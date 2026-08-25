"""Per-interface capture lifecycle, config parsing, and permission remediation.

One :class:`CaptureSession` per configured interface, each backed by a
``zelos_packet.PacketCapture`` whose Rust core owns the emit path. The session
is the Start/Stop granularity the supervisor drives.

Every session writes into ONE trace source, ``packet``, and is told apart by
its name, which becomes the prefix of its two events - so the tree reads
``packet`` -> ``eth0`` -> ``{packets, stats}`` -> fields.
"""

from __future__ import annotations

import logging
import platform
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import pkg

# `ConfigError` is defined in `agent_filter` (which imports nothing from here)
# and re-exported, so endpoint resolution can raise it without an import cycle.
from .agent_filter import AgentEndpoint, ConfigError

logger = logging.getLogger(__name__)

DEFAULT_SNAPLEN = 512
DEFAULT_BUFFER_SIZE = 8 * 1024 * 1024
DEFAULT_PROMISCUOUS = False
#: Bytes of each packet stored in the `frame` column. `None` stores every
#: captured byte, deliberately diverging from `zelos_packet`'s 256 default:
#: the extension already bounds its byte budget with `DEFAULT_SNAPLEN` (512,
#: chosen to keep the control plane byte-complete), and storing less than we
#: capture would defeat that rationale.
DEFAULT_FRAME_SNAPLEN: int | None = None

#: The one trace source every capture writes into. Sessions are told apart by
#: their event-name prefix, not by source; see the module docstring.
PACKET_SOURCE_NAME = "packet"

#: Catalog path separators. A VLAN interface is literally named `eth0.100`, so
#: this is not hypothetical: an unsanitized name breaks `agent.latest` lookups.
#: `/` is here too - it would graft extra levels onto the tree under `packet`.
#:
#: Fallback only. `zelos_packet.sanitize_name` is the single home for the rule
#: (`sanitize_capture_name` prefers it); this keeps config parsing working when
#: the native package is not importable, which is when a user most needs a
#: legible config error rather than a second failure.
_PATH_SEPARATORS = re.compile(r"[.:@/\s]+")

#: `zelos_packet.CaptureStats` getters, in full.
STATS_FIELDS = (
    "packets_read",
    "bytes_read",
    "packets_truncated",
    "kernel_packets",
    "kernel_drops",
    "decode_stall_ns",
    "decode_stall_ms",
    "read_errors",
    "kernel_timestamps",
    "fallback_timestamps",
)

#: Every `zelos_packet.Metrics` getter except `emit_stall_ns` (redundant with
#: the `_ms` form). Complete on purpose: this feeds a diagnostic action, and
#: `flush_errors`/`drain_abandoned` are the only in-band signal of the two
#: warn-only loss windows (each flush_error may be up to 255 rows).
METRICS_FIELDS = (
    "packets_received",
    "packets_emitted",
    "packets_filtered",
    "packets_truncated",
    "bytes_captured",
    "stats_rows_emitted",
    "emit_errors",
    "flush_errors",
    "drain_abandoned",
    "emit_stall_ms",
)


class CaptureDeniedError(RuntimeError):
    """The OS refused a capture handle. Carries copy-pasteable remediation.

    Deliberately not named ``CapturePermissionError``: that is the typed error
    `zelos-packet` itself raises, and two same-named classes in one traceback
    is a readability trap. This one wraps that one, adding which interface was
    refused and the zero-privilege escape hatch.
    """

    def __init__(self, message: str, remediation: str) -> None:
        super().__init__(message)
        self.remediation = remediation


@dataclass(frozen=True)
class InterfaceConfig:
    """One capture target, with every default already applied."""

    interface: str
    name: str
    snaplen: int = DEFAULT_SNAPLEN
    promiscuous: bool = DEFAULT_PROMISCUOUS
    buffer_size: int = DEFAULT_BUFFER_SIZE


def sanitize_capture_name(raw: str) -> str:
    """Make `raw` safe as a capture's event-name prefix.

    Dots, colons, '@' and '/' are catalog *path separators* in Zelos, so an
    interface named `eth0.100` (a VLAN) would otherwise produce events that
    cannot be addressed. Collapse them to '_'.

    Defers to `zelos_packet.sanitize_name`: the package applies the rule to
    whatever name it is handed, and this result is what `parse_interfaces` uses
    to reject duplicates, so a disagreement would let two captures collide on
    one event name. The regex below is the fallback for a machine where the
    package is not importable.
    """
    native = pkg.sanitize_name(raw)
    if native is not None:
        return native
    cleaned = _PATH_SEPARATORS.sub("_", raw.strip()).strip("_")
    return cleaned or "capture"


def parse_interfaces(config: dict) -> list[InterfaceConfig]:
    """Turn the `interfaces` array into :class:`InterfaceConfig` values.

    Defaults are applied here as well as in the JSON Schema, so CLI callers -
    which never go through `load_config` - get identical behaviour.

    Raises:
        ConfigError: on a missing interface name or a duplicate capture name.
        Duplicates are a hard error rather than a silent rename: the sessions
        share one trace source, and event registration there is strict-create,
        so a duplicate would fail at Start with a native error naming an event
        rather than here naming the config field that caused it.
    """
    entries = config.get("interfaces") or []
    if not isinstance(entries, list):
        raise ConfigError("'interfaces' must be a list of capture configurations")

    parsed: list[InterfaceConfig] = []
    seen: dict[str, str] = {}

    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ConfigError(f"interfaces[{index}] must be an object")

        interface = str(entry.get("interface") or "").strip()
        if not interface:
            raise ConfigError(
                f"interfaces[{index}] is missing 'interface'. Run the "
                "'List interfaces' action to see the interfaces available on "
                "the machine running the agent."
            )

        raw_name = str(entry.get("name") or "").strip() or interface
        name = sanitize_capture_name(raw_name)
        if name != raw_name:
            logger.info("Capture name %r sanitized to %r", raw_name, name)

        if name in seen:
            raise ConfigError(
                f"Duplicate capture name {name!r} (interfaces {seen[name]!r} "
                f"and {interface!r}). Give each interface a unique 'name'."
            )
        seen[name] = interface

        parsed.append(
            InterfaceConfig(
                interface=interface,
                name=name,
                snaplen=int(entry.get("snaplen") or DEFAULT_SNAPLEN),
                promiscuous=bool(entry.get("promiscuous", DEFAULT_PROMISCUOUS)),
                buffer_size=int(entry.get("buffer_size") or DEFAULT_BUFFER_SIZE),
            )
        )

    return parsed


# ─── Permission remediation ─────────────────────────────────────────────────
#
# Kept as a pure function so it is testable at the helper seam, without opening
# a socket or shelling out.

_REPLAY_HINT = (
    "No capture rights on this machine? Set 'Replay PCAP File' in the extension\n"
    "config to decode a .pcap/.pcapng instead - that path opens no capture handle\n"
    "and needs no privileges."
)


def builtin_grant_instructions(
    *,
    system: str | None = None,
    executable: str | None = None,
) -> str:
    """This extension's own capture-privilege instructions, per platform.

    Pure: no package, no syscalls, so it is testable at the helper seam and is
    available even when `zelos-packet` cannot be imported - which is exactly
    when a user still needs to be told what capture costs here.
    """
    system = system or platform.system()
    executable = executable or sys.executable or "python3"

    if system == "Linux":
        body = f"""
Live capture needs CAP_NET_RAW (and CAP_NET_ADMIN for promiscuous mode). Grant
them to the interpreter that runs this extension - one time, no reboot:

    sudo setcap cap_net_raw,cap_net_admin+eip {executable}

Verify with:

    getcap {executable}

If that path is a symlink (uv-managed venvs usually are), capabilities must go
on the real file: `setcap ... "$(readlink -f {executable})"`.

Then restart the extension.
"""
    elif system == "Darwin":
        # Deliberately the same two options, in the same order, as
        # zelos-packet's own `permission_remediation()` (rs/capture/error.rs).
        # These used to disagree: this fallback told the user to create an
        # access_bpf group, which needs a logout before the membership takes
        # effect, so following it looked like it had failed. `admin` is a
        # group a macOS admin user is already in, so it works immediately.
        body = """
Live capture reads /dev/bpf*, which is root-only by default on macOS. Pick one:

  1. Grant your user access (works immediately, resets on reboot):

         sudo chgrp admin /dev/bpf*
         sudo chmod g+rw /dev/bpf*

  2. Persist it across reboots with Wireshark's ChmodBPF daemon:

         sudo /Library/Application\\ Support/Wireshark/ChmodBPF/ChmodBPF

Then restart the extension. Verify with `ls -l /dev/bpf0` — you want
`crw-rw---- root admin`.
"""
    else:
        body = f"""
Live capture is supported on Linux (AF_PACKET) and macOS (/dev/bpf) only in this
release; this machine reports {system!r}.
"""

    return f"{body.strip()}\n\n{_REPLAY_HINT}"


def capture_grant_instructions(
    *,
    system: str | None = None,
    executable: str | None = None,
) -> str:
    """Copy-pasteable instructions for granting capture rights on this OS.

    Prefers ``zelos_packet.permission_remediation()``: that package opens the
    handle, so its text is authoritative and cannot drift from what the native
    backend actually requires. It is compiled for the running platform, so it
    only applies when `system` is this machine; otherwise, and whenever the
    package is unavailable, fall back to
    :func:`builtin_grant_instructions`.

    Carries no "permission denied" claim, so it can also be handed to a user
    whose Start failed for some other reason (missing package, no NICs).
    """
    if (system or platform.system()) == platform.system():
        native = pkg.permission_remediation().strip()
        if native:
            return f"{native}\n\n{_REPLAY_HINT}"
    return builtin_grant_instructions(system=system, executable=executable)


def remediation_text(
    interface: str,
    *,
    system: str | None = None,
    executable: str | None = None,
) -> str:
    """What a user sees when a capture handle is refused."""
    return (
        f"Permission denied opening a capture handle on {interface!r}.\n\n"
        + capture_grant_instructions(system=system, executable=executable)
    )


# ─── Capture session ────────────────────────────────────────────────────────


#: The live namespace's shared `packet` source, built on first use. See
#: :func:`make_trace_source`.
_live_source: Any = None


def make_trace_source(namespace: Any = None, *, cached: bool = True) -> Any:
    """The ``packet`` source every capture in this process writes into.

    ONE object, not one per session. Two `TraceSource`s under one name is not
    a duplicate-name error - `TraceNamespace` keys its registry by UUID, so
    both register, and the query layer's `by_path` resolution then buckets them
    together and keeps only the newest, silently hiding the other's rows. It
    also defeats the duplicate-event guard, which is per-source: two same-named
    sources will each accept ``eth0/packets`` without complaint. Sessions are
    kept apart by their event-name prefix instead, which `parse_interfaces`
    guarantees is unique.

    ``cached`` picks the source type, and it is a throughput decision. A
    ``TraceSourceCache`` keeps last-value navigation available, which live
    capture wants; a plain ``TraceSource`` is the only one the native sink can
    hand whole Arrow batches to (a cache has no ``log_batch``, deliberately -
    it would bypass the last-value map). File conversion navigates nothing, so
    it passes ``cached=False``: measured on a 50k-packet convert with frames
    logged, 2870 ns/packet cached vs 801 plain.

    `namespace` of None is the global namespace `zelos_sdk.init()` set up - the
    live path, and the only one that shares. Conversion passes its own
    namespace and gets its own source, so nothing it decodes reaches an agent
    and nothing is retained after it finishes.
    """
    import zelos_sdk

    factory = zelos_sdk.TraceSourceCache if cached else zelos_sdk.TraceSource
    if namespace is not None:
        return factory(PACKET_SOURCE_NAME, namespace=namespace)

    # The first live caller's `cached` choice wins for the rest of the
    # process. Every live caller asks for a cache today; forking a second
    # source to honor a different answer is the failure this exists to stop.
    global _live_source
    if _live_source is None:
        _live_source = factory(PACKET_SOURCE_NAME, namespace=None)
    return _live_source


@dataclass
class CaptureSession:
    """Lifecycle wrapper around one ``zelos_packet.PacketCapture``."""

    config: InterfaceConfig
    endpoint: AgentEndpoint | None = None
    log_frames: bool = True
    frame_snaplen: int | None = DEFAULT_FRAME_SNAPLEN
    _capture: Any = field(default=None, init=False, repr=False)
    _source: Any = field(default=None, init=False, repr=False)

    @property
    def name(self) -> str:
        return self.config.name

    def capture_kwargs(self) -> dict[str, Any]:
        """Arguments handed to ``PacketCapture``. Split out so tests can assert
        the exclusion parameters without constructing anything.

        Keyword names are the native ones (``api/py/zelos-packet/rs/lib.rs``);
        the package is pinned `==`, so there is nothing to negotiate.
        """
        return {
            "interface": self.config.interface,
            # Prefixes this capture's two events, which is what keeps several
            # sessions on the one shared source from colliding.
            "name": self.config.name,
            "snaplen": self.config.snaplen,
            "promiscuous": self.config.promiscuous,
            "buffer_bytes": self.config.buffer_size,
            "exclude_agent_addrs": list(self.endpoint.literals) if self.endpoint else None,
            "exclude_agent_port": self.endpoint.port if self.endpoint else None,
        }

    def start(self) -> None:
        """Open the capture handle and begin emitting.

        `zelos_sdk.init()` must already have run: the source is resolved through
        the SDK's ABI capsule at construction time. The constructor probe-opens
        the handle, so a privilege failure surfaces here rather than from a
        background thread.
        """
        try:
            self._source = make_trace_source()
            self._capture = pkg.module().PacketCapture(
                source=self._source,
                log_frames=self.log_frames,
                frame_snaplen=self.frame_snaplen,
                **self.capture_kwargs(),
            )
            self._capture.start()
        except Exception as exc:
            # Dropping the handle is what stops a constructed-but-unstarted
            # capture from pinning its source for the session's lifetime.
            self._capture = None
            self._source = None
            if pkg.is_permission_error(exc):
                raise CaptureDeniedError(
                    f"Capture on {self.config.interface!r} was denied: {exc}",
                    remediation_text(self.config.interface),
                ) from exc
            raise

        if not self.log_frames:
            frames = "off"
        elif self.frame_snaplen is None:
            frames = "whole frame"
        else:
            frames = f"first {self.frame_snaplen} B"
        logger.info(
            "Capturing %s into %s.%s/packets (snaplen=%d, promiscuous=%s, buffer=%d B, frames=%s)",
            self.config.interface,
            PACKET_SOURCE_NAME,
            self.config.name,
            self.config.snaplen,
            self.config.promiscuous,
            self.config.buffer_size,
            frames,
        )

    def stats(self) -> dict[str, Any]:
        """Read-loop counters plus decoder counters, or a not-started marker."""
        # One snapshot: a concurrent stop() nulls the field, and re-reading it
        # between the None check and the calls would raise AttributeError.
        cap = self._capture
        if cap is None:
            return {"interface": self.config.interface, "name": self.name, "running": False}
        stats = cap.stats()
        metrics = cap.metrics()
        return {
            "interface": self.config.interface,
            "name": self.name,
            "running": True,
            **{field: getattr(stats, field) for field in STATS_FIELDS},
            "metrics": {field: getattr(metrics, field) for field in METRICS_FIELDS},
        }

    def stop(self) -> None:
        """Stop capturing.

        ``PacketCapture.stop()`` joins the reader thread and drains the batch in
        flight, so returning implies every row is through the sink. The router
        itself is drained (blocking) by the SDK's atexit hook, which is why the
        CLI returns normally from `main` rather than calling `os._exit`.
        """
        if self._capture is None:
            return
        try:
            self._capture.stop()
        except Exception:
            logger.exception("Error stopping capture on %s", self.config.interface)
        self._capture = None
        self._source = None
        logger.info("Stopped capture on %s", self.config.interface)


# ─── Interfaces, replay, permission probe ───────────────────────────────────


def list_interfaces() -> list[dict[str, Any]]:
    """Enumerate NICs on the machine running the agent."""
    interfaces = []
    for iface in pkg.module().list_interfaces():
        interfaces.append(
            {
                "name": getattr(iface, "name", str(iface)),
                "index": getattr(iface, "index", None),
                "is_up": getattr(iface, "is_up", None),
                # IFF_RUNNING: administratively up is not the same as "has a
                # carrier", and capturing a down link looks like a hang.
                "is_running": getattr(iface, "is_running", None),
                "is_loopback": getattr(iface, "is_loopback", None),
                "addresses": list(getattr(iface, "addresses", []) or []),
                "mac": getattr(iface, "mac", None),
            }
        )
    return interfaces


def make_decoder(
    name: str,
    *,
    log_frames: bool = True,
    frame_snaplen: int | None = DEFAULT_FRAME_SNAPLEN,
    namespace: Any = None,
    cached: bool = True,
) -> Any:
    """A ``PacketDecoder`` emitting into `namespace` under a sanitized `name`.

    Rows land at ``packet.{name}/packets.<field>``: the decoder shares the
    ``packet`` source with every live capture and is told apart by `name`,
    exactly as a capture is.

    Shared by replay (global namespace, streaming to an agent) and by
    `converter` (its own namespace, writing a file), so the two cannot drift
    apart on naming or constructor keywords. `cached` is the one thing they
    genuinely disagree on - see `make_trace_source`.
    """
    source = make_trace_source(namespace, cached=cached)
    return pkg.module().PacketDecoder(
        name=sanitize_capture_name(name),
        source=source,
        log_frames=log_frames,
        frame_snaplen=frame_snaplen,
    )


def replay_pcap(
    path: str | Path,
    *,
    name: str = "pcap",
    log_frames: bool = True,
    frame_snaplen: int | None = DEFAULT_FRAME_SNAPLEN,
) -> dict[str, Any]:
    """Decode a pcap/pcapng into the *live* trace namespace. No privileges required.

    This is the streaming path: rows go wherever `zelos_sdk.init()` pointed them.
    To write a `.trz` and nothing else, use `converter.convert_pcap` - it needs
    no agent and never calls `init()`.
    """
    pcap = Path(path).expanduser()
    if not pcap.exists():
        raise ConfigError(f"Replay file not found: {pcap}")

    logger.info(
        "Replaying %s into %s.%s/packets", pcap, PACKET_SOURCE_NAME, sanitize_capture_name(name)
    )
    decoder = make_decoder(name, log_frames=log_frames, frame_snaplen=frame_snaplen)
    count = decoder.convert_file(str(pcap))
    decoder.flush()
    logger.info("Replay of %s complete: %d packets", pcap.name, count)
    return {"file": str(pcap), "packets": count}


def probe_permissions(interface: str | None = None) -> dict[str, Any]:
    """Try to open (and immediately close) a capture handle.

    Returns a result dict rather than raising, because this is the answer to
    "will Start work?" and callers want the remediation text either way.
    """
    system = platform.system()
    # `capture_supported()` is the package's own compiled-in answer; the
    # platform check is the fallback for when it is not importable.
    supported = pkg.capture_supported() if pkg.available() else system in ("Linux", "Darwin")

    def denied(reason: str, target: str | None = None, remediation: str | None = None) -> dict:
        # Every failure carries instructions, whatever the cause: this probe
        # exists to answer "what do I run to make Start work?", and an empty
        # answer is the support ticket it is meant to prevent. Only a genuine
        # refusal gets the "permission denied" header (passed in by the caller).
        return {
            "supported": supported,
            "can_capture": False,
            "platform": system,
            "interface": target or "",
            "reason": reason,
            "remediation": (
                remediation
                if remediation is not None
                else capture_grant_instructions(system=system)
            ),
        }

    if not pkg.available():
        return denied(pkg.skip_reason(), interface)

    target = interface
    if not target:
        candidates = list_interfaces()
        preferred = [i for i in candidates if i.get("is_up") and not i.get("is_loopback")]
        pool = preferred or candidates
        if not pool:
            return denied("No network interfaces were reported by zelos-packet")
        target = str(pool[0]["name"])

    # Construct and drop, never start: the constructor probe-opens the handle
    # (lib.rs `new`), which is the entire question here, while `start()` would
    # register this interface's two events and leave them in the live catalog
    # on every permission check.
    #
    # The shared source is passed rather than letting the package default one:
    # defaulting would build a SECOND source named `packet` alongside the one
    # the sessions use, which nothing rejects and which hides one of the two
    # from `by_path` resolution. Construction registers no events, so handing
    # over the real source costs nothing.
    try:
        pkg.module().PacketCapture(
            interface=target, snaplen=64, log_frames=False, source=make_trace_source()
        )
    except Exception as exc:
        if pkg.is_permission_error(exc):
            # str(exc) embeds the package's own remediation block; keep only
            # its first line so callers printing reason + remediation don't
            # show the instructions twice.
            return denied(
                f"Capture on {target!r} was denied: {str(exc).splitlines()[0]}",
                target,
                remediation=remediation_text(target),
            )
        return denied(f"{type(exc).__name__}: {exc}", target)
    else:
        return {
            "supported": True,
            "can_capture": True,
            "platform": system,
            "interface": target,
            "reason": "",
            "remediation": "",
        }
