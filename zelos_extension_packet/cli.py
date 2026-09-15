"""App-config mode (how the supervisor launches us) plus explicit subcommands."""

from __future__ import annotations

import logging
import signal
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType

import rich_click as click
import zelos_sdk
from zelos_sdk.extensions import load_config

from . import ACTION_PREFIX, pkg
from . import actions as packet_actions
from .agent_filter import AMPLIFICATION_WARNING, AgentEndpoint, is_loopback_interface
from .agent_filter import resolve_agent_endpoint as _resolve_agent_endpoint
from .capture import (
    DEFAULT_STORED_FRAME_BYTES,
    CaptureDeniedError,
    CaptureSession,
    ConfigError,
    InterfaceConfig,
    parse_interfaces,
    probe_permissions,
    replay_pcap,
)
from .capture import (
    list_interfaces as _list_interfaces,
)
from .converter import convert_paths

logger = logging.getLogger(__name__)

#: Defined once in the package root - the at-rest action inventory reads it too.
SOURCE_PREFIX = ACTION_PREFIX


def _apply_log_level(config: dict) -> None:
    level_name = config.get("log_level", "INFO")
    level = getattr(logging, str(level_name), None)
    if isinstance(level, int):
        logging.getLogger().setLevel(level)
    else:
        logger.warning("Invalid log level %r, using INFO", level_name)
        logging.getLogger().setLevel(logging.INFO)


def _resolve_exclusion(config: dict, interfaces: list[InterfaceConfig]) -> AgentEndpoint | None:
    """Resolve the agent endpoint to exclude.

    `exclude_agent_traffic` is deliberately NOT in `config.schema.json`, so the
    app cannot offer it and (`additionalProperties: false`) will not accept it.
    Disabling exclusion on an interface that carries the agent's stream is not
    merely noisy - a captured packet emits a row, the row is published, and the
    publish is captured, so at a large snaplen it diverges rather than settling.
    The knob survives here for the one case that is safe (an interface the agent
    never touches) and for tests; nothing advertises it.
    """
    if not config.get("exclude_agent_traffic", True):
        for iface in interfaces:
            if is_loopback_interface(iface.interface):
                logger.warning(AMPLIFICATION_WARNING, iface.interface, iface.snaplen)
        logger.warning(
            "Agent-traffic exclusion is disabled; captured traffic may include this "
            "extension's own publishes."
        )
        return None

    endpoint = _resolve_agent_endpoint()
    logger.info("Excluding agent traffic: %s", endpoint.describe())
    return endpoint


def _install_shutdown(stop_event: threading.Event) -> None:
    def handler(signum: int, _frame: FrameType | None) -> None:
        logger.info("Received signal %d, shutting down packet capture...", signum)
        stop_event.set()

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def _install_replay_shutdown() -> None:
    """Turn a supervisor Stop during a replay into an unwind, not a kill.

    Default SIGTERM handling tears the process down without running any
    `finally`, which leaves a half-written .trz behind. Raising instead lets the
    `TraceWriter` context manager close the file. `convert_file` runs with the
    GIL released, so the handler only fires once it returns - cancelling
    mid-file is not on offer, and is not what this protects.
    """

    def handler(signum: int, _frame: FrameType | None) -> None:
        logger.info("Received signal %d, stopping replay...", signum)
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def _run_sessions(sessions: list[CaptureSession]) -> None:
    """Start every session, wait for shutdown, then stop them in reverse order.

    Returning normally (rather than `os._exit`) matters: the SDK registers an
    atexit hook that drains the global trace namespace and blocks until every
    queued event has been delivered.
    """
    stop_event = threading.Event()
    _install_shutdown(stop_event)

    started: list[CaptureSession] = []
    try:
        for session in sessions:
            session.start()
            started.append(session)
        logger.info(
            "Capturing on %d interface%s; waiting for stop",
            len(started),
            "s" if len(started) != 1 else "",
        )
        stop_event.wait()
    finally:
        for session in reversed(started):
            session.stop()


def _fail(message: str) -> None:
    """Log a legible one-line reason and exit non-zero.

    The supervisor does not restart a crashed extension, so a clear final log
    line in `extension.log` is the whole user experience of a failed start.
    """
    logger.error("%s", message)
    sys.exit(1)


def _resolve_output_file(file: Path | None) -> Path | None:
    if file is None:
        return None
    if str(file) == ".":
        return Path(f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.trz")
    return file


def run_app_mode(file: Path | None = None) -> None:
    """Run from the Zelos App / supervisor configuration (no subcommand)."""
    config = load_config()
    _apply_log_level(config)

    log_frames = bool(config.get("log_frames", True))
    # `.get` with a default, not `or`: an explicit null means "store every
    # captured byte" and must survive, where `or` would fold it back to 256.
    stored_frame_bytes = config.get("stored_frame_bytes", DEFAULT_STORED_FRAME_BYTES)
    replay = str(config.get("replay_pcap") or "").strip()

    interfaces: list[InterfaceConfig] = []
    if not replay:
        try:
            interfaces = parse_interfaces(config)
        except ConfigError as exc:
            _fail(str(exc))
        if not interfaces:
            _fail(
                "Nothing to do: no interfaces are configured and no replay file is set. "
                "Add an interface (run the 'List interfaces' action to see what this "
                "machine has), or set 'Replay PCAP File' to decode a capture instead."
            )

    output_file = _resolve_output_file(file)

    # Actions are registered before init(); the `Packet/` prefix comes from init().
    packet_actions.register_actions(zelos_sdk.actions_registry)
    zelos_sdk.init(name=SOURCE_PREFIX, log_level="info", actions=True)

    if not pkg.available():
        _fail(pkg.skip_reason())

    if replay:
        logger.info("Replay mode: decoding %s (no capture handle is opened)", replay)
        _install_replay_shutdown()
        try:
            replay_kwargs = {
                "name": Path(replay).stem,
                "log_frames": log_frames,
                "stored_frame_bytes": stored_frame_bytes,
            }
            if output_file:
                with zelos_sdk.TraceWriter(str(output_file)):
                    replay_pcap(replay, **replay_kwargs)
            else:
                replay_pcap(replay, **replay_kwargs)
        except ConfigError as exc:
            _fail(str(exc))
        except KeyboardInterrupt:
            # The writer is closed by the unwind; say so rather than exiting mute.
            logger.warning("Replay of %s stopped before it finished", replay)
        except Exception as exc:
            logger.exception("Replay failed")
            _fail(f"Replay of {replay} failed: {exc}")
        return

    try:
        endpoint = _resolve_exclusion(config, interfaces)
    except ConfigError as exc:
        # An agent host that resolves to nothing: the exclusion cannot be built,
        # and capturing without it is the amplification loop.
        _fail(str(exc))
    sessions = [
        CaptureSession(
            cfg,
            endpoint=endpoint,
            log_frames=log_frames,
            stored_frame_bytes=stored_frame_bytes,
        )
        for cfg in interfaces
    ]
    for session in sessions:
        packet_actions.CAPTURES[session.name] = session

    try:
        if output_file:
            logger.info("Recording trace to: %s", output_file)
            with zelos_sdk.TraceWriter(str(output_file)):
                _run_sessions(sessions)
        else:
            _run_sessions(sessions)
    except CaptureDeniedError as exc:
        # Exit cleanly with the remediation, rather than a traceback: the
        # supervisor does not restart on crash, so this message is the fix.
        logger.error("%s\n\n%s", exc, exc.remediation)
        sys.exit(1)
    except (ValueError, RuntimeError) as exc:
        # A typo'd interface (InterfaceNotFoundError, a ValueError) or a native
        # capture failure (RuntimeError): one legible line, not a traceback.
        _fail(str(exc))
    finally:
        packet_actions.CAPTURES.clear()


# ─── Subcommands ────────────────────────────────────────────────────────────


@click.command("interfaces")
def interfaces_cmd() -> None:
    """List capturable network interfaces."""
    if not pkg.available():
        raise click.ClickException(pkg.skip_reason())
    for iface in _list_interfaces():
        flags = []
        if iface.get("is_up"):
            flags.append("up")
        if iface.get("is_loopback"):
            flags.append("loopback")
        addresses = ", ".join(str(a) for a in iface.get("addresses") or []) or "-"
        click.echo(f"{iface['name']:<16} {'/'.join(flags) or '-':<14} {addresses}")


@click.command("check")
@click.option("--interface", default="", help="Interface to probe (default: first non-loopback).")
def check_cmd(interface: str) -> None:
    """Probe whether live capture is permitted, and print how to fix it."""
    result = probe_permissions(interface.strip() or None)
    if result.get("can_capture"):
        click.echo(f"Capture is permitted on {result.get('interface')}.")
        return
    click.echo(result.get("reason") or "Capture is not permitted.")
    if result.get("remediation"):
        click.echo("")
        click.echo(result["remediation"])
    raise SystemExit(1)


@click.command("capture")
@click.argument("interface", nargs=-1, required=True)
@click.option("--snaplen", type=int, default=512, show_default=True, help="Bytes per packet.")
@click.option("--promiscuous", is_flag=True, help="Capture frames not addressed to this host.")
@click.option(
    "--buffer-size", type=int, default=8 * 1024 * 1024, show_default=True, help="Kernel buffer."
)
@click.option("--no-frames", is_flag=True, help="Do not populate the `frame` Binary column.")
@click.option(
    "--file",
    type=click.Path(path_type=Path),
    default=None,
    is_flag=False,
    flag_value=".",
    help="Record trace to .trz (defaults to a UTC-stamped name).",
)
def capture_cmd(
    interface: tuple[str, ...],
    snaplen: int,
    promiscuous: bool,
    buffer_size: int,
    no_frames: bool,
    file: Path | None,
) -> None:
    """Capture one or more INTERFACEs without app configuration.

    Examples:

      zelos-extension-packet capture eth0

      zelos-extension-packet capture eth0 eth1 --snaplen 1518 --file
    """
    # Through `parse_interfaces` so the CLI gets the same duplicate-name
    # check as app mode: `capture eth0.1 eth0:1` sanitizes to one name. The
    # flags are top-level, which is what "one --snaplen for every interface"
    # already meant.
    try:
        configs = parse_interfaces(
            {
                "interfaces": [{"interface": name} for name in interface],
                "snaplen": snaplen,
                "promiscuous": promiscuous,
                "buffer_size": buffer_size,
            }
        )
    except ConfigError as exc:
        raise click.ClickException(str(exc)) from exc

    packet_actions.register_actions(zelos_sdk.actions_registry)
    zelos_sdk.init(name=SOURCE_PREFIX, log_level="info", actions=True)

    if not pkg.available():
        raise click.ClickException(pkg.skip_reason())

    try:
        endpoint = _resolve_agent_endpoint()
    except ConfigError as exc:
        raise click.ClickException(str(exc)) from exc
    logger.info("Excluding agent traffic: %s", endpoint.describe())

    sessions = [CaptureSession(cfg, endpoint=endpoint, log_frames=not no_frames) for cfg in configs]
    for session in sessions:
        packet_actions.CAPTURES[session.name] = session

    output_file = _resolve_output_file(file)
    try:
        if output_file:
            logger.info("Recording trace to: %s", output_file)
            with zelos_sdk.TraceWriter(str(output_file)):
                _run_sessions(sessions)
        else:
            _run_sessions(sessions)
    except CaptureDeniedError as exc:
        raise click.ClickException(f"{exc}\n\n{exc.remediation}") from exc
    except (ValueError, RuntimeError) as exc:
        # Same one-line failure as app mode: a typo'd interface must not print
        # a traceback. ClickException is this command's `_fail`.
        raise click.ClickException(str(exc)) from exc
    finally:
        packet_actions.CAPTURES.clear()


@click.command("replay")
@click.argument("pcap", type=click.Path(exists=True, path_type=Path))
@click.option(
    "--name",
    default="",
    help="Names this capture's branch in the signal tree (default: the file stem).",
)
@click.option("--no-frames", is_flag=True, help="Do not populate the `frame` Binary column.")
@click.option(
    "--file",
    type=click.Path(path_type=Path),
    default=None,
    is_flag=False,
    flag_value=".",
    help="Record trace to .trz (defaults to a UTC-stamped name).",
)
def replay_cmd(pcap: Path, name: str, no_frames: bool, file: Path | None) -> None:
    """Decode a PCAP file into a trace. Needs no capture privileges."""
    zelos_sdk.init(name=SOURCE_PREFIX, log_level="info")
    if not pkg.available():
        raise click.ClickException(pkg.skip_reason())

    output_file = _resolve_output_file(file)
    capture_name = name or pcap.stem
    _install_replay_shutdown()
    try:
        if output_file:
            logger.info("Recording trace to: %s", output_file)
            with zelos_sdk.TraceWriter(str(output_file)):
                replay_pcap(pcap, name=capture_name, log_frames=not no_frames)
        else:
            replay_pcap(pcap, name=capture_name, log_frames=not no_frames)
    except KeyboardInterrupt:
        logger.warning("Replay of %s stopped before it finished", pcap)


@click.command("convert")
@click.argument("inputs", nargs=-1, required=True, type=click.Path(path_type=Path))
@click.option(
    "-o",
    "--output",
    type=click.Path(path_type=Path),
    default=None,
    help="Output .trz path. Single input only; use --output-dir for a batch.",
)
@click.option(
    "-d",
    "--output-dir",
    type=click.Path(path_type=Path),
    default=None,
    help="Write every .trz into this directory instead of alongside its input.",
)
@click.option("-f", "--force", is_flag=True, help="Overwrite outputs that already exist.")
@click.option("--no-frames", is_flag=True, help="Do not populate the `frame` Binary column.")
@click.option("--no-progress", is_flag=True, help="Disable progress bars.")
def convert_cmd(
    inputs: tuple[Path, ...],
    output: Path | None,
    output_dir: Path | None,
    force: bool,
    no_frames: bool,
    no_progress: bool,
) -> None:
    """Convert PCAP files to Zelos traces (.trz).

    Needs no capture privileges and no agent - nothing is published, the trace
    is written straight to disk. One input file produces one .trz; a directory
    converts every .pcap/.pcapng directly inside it. A failure on one file does
    not stop the rest, and the command exits non-zero if any failed.

    Examples:

      zelos-extension-packet convert capture.pcap

      zelos-extension-packet convert *.pcapng --output-dir traces/

      zelos-extension-packet convert ./captures -f --no-frames
    """
    if not pkg.available():
        raise click.ClickException(pkg.skip_reason())

    try:
        results = convert_paths(
            inputs,
            output=output,
            output_dir=output_dir,
            log_frames=not no_frames,
            overwrite=force,
            progress=not no_progress,
        )
    except ValueError as exc:  # ConfigError is a ValueError
        raise click.ClickException(str(exc)) from exc

    failures = 0
    for result in results:
        if result["status"] == "success":
            click.echo(
                f"{result['input_file']} -> {result['output_file']} ({result['packets']:,} packets)"
            )
        else:
            failures += 1
            click.echo(f"{result['input_file']}: {result['message']}", err=True)

    click.echo(f"{len(results) - failures}/{len(results)} converted")
    if failures:
        raise SystemExit(1)
