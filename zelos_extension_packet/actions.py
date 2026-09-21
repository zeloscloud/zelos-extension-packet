"""Free-floating packet actions registered under ``Packet/<name>``.

Same shape as the CAN extension: free functions (so ``choices=`` can reference a
module-level callable), a shared registry populated by ``cli.py`` at startup, and
one global namespace rather than per-interface action paths.
"""

from __future__ import annotations

import inspect
import logging
import platform
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from zelos_sdk.actions import ActionsRegistry, action

from . import capture as capture_mod
from . import pkg

if TYPE_CHECKING:
    from .capture import CaptureSession

logger = logging.getLogger(__name__)

#: Live capture sessions, keyed by capture name. Populated by `cli.py`.
CAPTURES: dict[str, CaptureSession] = {}


def _available_captures(*_args: Any) -> list[str]:
    """`choices=` provider; evaluated at form-render time."""
    return sorted(CAPTURES.keys())


def _interface_choice(iface: dict[str, Any]) -> dict[str, str]:
    """One `choices` entry: the name, and what a user needs to pick it."""
    detail = []
    if isinstance(iface.get("is_up"), bool):
        detail.append("up" if iface["is_up"] else "down")
    if iface.get("is_loopback") is True:
        detail.append("loopback")
    addresses = iface.get("addresses") or []
    if addresses and isinstance(addresses[0], str):
        detail.append(addresses[0])
    return {"value": iface["name"], "detail": " · ".join(detail)}


def _interface_rank(iface: dict[str, Any]) -> tuple[int, str]:
    """Up non-loopback first, then up loopback, then down; names break ties."""
    up = iface.get("is_up") is True
    loopback = iface.get("is_loopback") is True
    return (0 if up and not loopback else 1 if up else 2, iface["name"])


def _scan_interfaces(build: Callable[[list[dict[str, Any]]], dict[str, Any]]) -> dict[str, Any]:
    """Enumerate and rank the host's interfaces, then `build` an answer from them.

    One place says how a scan fails: the packet package missing is the message
    itself; anything else is logged and named.
    """
    try:
        interfaces = sorted(capture_mod.list_interfaces(), key=_interface_rank)
        return build(interfaces)
    except pkg.PacketPackageUnavailable as exc:
        return {"status": "error", "message": str(exc)}
    except Exception as exc:
        logger.exception("Failed to enumerate interfaces")
        return {"status": "error", "message": f"{type(exc).__name__}: {exc}"}


def _auto_config(interfaces: list[dict[str, Any]]) -> dict[str, Any]:
    picked = [
        i["name"] for i in interfaces if i.get("is_up") is True and i.get("is_loopback") is not True
    ]
    if not picked:
        return {"status": "error", "message": "No interface on this host is up and not loopback."}
    return {"status": "success", "config": {"interfaces": [{"interface": n} for n in picked]}}


@action(
    "Auto-configure",
    "A configuration that captures on every interface that is up and not loopback, "
    "for the config form's Auto-configure button. Review it, then save and start.",
    standalone=True,
)
def auto_config() -> dict[str, Any]:
    """The app's auto-configure contract: `config` replaces the form's keys."""
    return _scan_interfaces(_auto_config)


@action(
    "List Interfaces",
    "Network interfaces on the machine running the agent, as choices for the "
    "config's 'Interface' field, which also accepts a name typed by hand.",
    # Enumerating NICs opens no capture handle and needs no privileges, and the
    # config form wants the list before the extension has ever run.
    standalone=True,
)
def list_interfaces() -> dict[str, Any]:
    """The app's `action-choices` contract: `choices` in the order to show."""
    return _scan_interfaces(
        lambda interfaces: {
            "status": "success",
            "choices": [_interface_choice(i) for i in interfaces],
        }
    )


@action(
    "Capture Stats",
    "Per-interface read-loop counters (packets_read, bytes_read, "
    "packets_truncated, kernel_drops, decode_stall_ms) plus a 'metrics' "
    "sub-object of decoder counters (packets_filtered - how much agent traffic "
    "the exclusion dropped - and emit_stall_ms). kernel_drops climbing with "
    "emit_stall_ms near zero means the kernel buffer is too small; a high "
    "emit_stall_ms with no drops means the trace pipeline is the bottleneck.",
)
@action.select(
    "name",
    title="Interface",
    description="Leave empty for every running capture.",
    required=False,
    default="",
    choices=_available_captures,
)
def capture_stats(name: str = "") -> dict[str, Any]:
    if name:
        session = CAPTURES.get(name)
        if session is None:
            return {
                "status": "error",
                "message": f"Unknown capture {name!r}. Running: {_available_captures()}",
            }
        sessions = [session]
    else:
        sessions = [CAPTURES[key] for key in _available_captures()]

    if not sessions:
        return {
            "status": "warning",
            "message": "No captures are running. Configure interfaces and start the extension.",
            "captures": [],
        }
    return {"status": "success", "captures": [s.stats() for s in sessions]}


@action(
    "Check Permissions",
    "Probe whether live capture is possible on this machine and, if not, return "
    "the exact command to fix it. Run this before the first Start.",
)
@action.text(
    "interface",
    title="Interface",
    description="Optional. Defaults to the first interface that is up and not loopback.",
    required=False,
    default="",
    placeholder="eth0",
)
def check_permissions(interface: str = "") -> dict[str, Any]:
    result = capture_mod.probe_permissions(interface.strip() or None)
    result["status"] = "success" if result.get("can_capture") else "error"
    result["python"] = sys.executable
    result.setdefault("platform", platform.system())
    return result


@action(
    "Convert Pcap",
    "Convert a .pcap/.pcapng file to a Zelos trace (.trz). Runs without the "
    "extension running - no capture handle, no interface, no privileges, and no "
    "agent: the trace is written straight to disk.",
    # Decoding is I/O bound over files that can reach multi-GB. 30 minutes is a
    # ceiling for the pathological case, not an expectation; the action returns
    # as soon as the file is written. The AI tool bridge clamps its own calls to
    # MAX_ACTION_TOOL_TIMEOUT_MS (5 min) regardless, so long conversions are an
    # action-panel / CLI path.
    timeout=1800.0,
    standalone=True,
)
@action.text(
    "input_file",
    title="Capture file",
    description="Source .pcap or .pcapng",
    widget="file_path_picker",
)
@action.text(
    "output_file",
    title="Output (.trz)",
    description="Defaults to the input file with a .trz suffix",
    required=False,
    default="",
    widget="file_path_picker",
)
@action.boolean(
    "force", title="Overwrite existing output", required=False, default=False, widget="toggle"
)
@action.boolean(
    "log_frames",
    title="Include raw frames",
    description="Populate the `frame` Binary column with the captured bytes",
    required=False,
    default=True,
    widget="toggle",
)
def convert_pcap(
    input_file: str,
    output_file: str = "",
    force: bool = False,
    log_frames: bool = True,
) -> dict[str, Any]:
    """Convert one capture file to .trz.

    Shares `converter.convert_pcap` with the `convert` CLI command, so the two
    surfaces cannot diverge. Failures raise rather than returning an error dict:
    a standalone action's exit status is how the caller learns it failed.
    """
    from .converter import convert_pcap as _convert
    from .converter import resolve_output

    source = Path(input_file).expanduser()
    if not source.is_file():
        raise FileNotFoundError(f"Input file not found: {source}")
    destination = resolve_output(
        source,
        Path(output_file).expanduser() if output_file.strip() else None,
        overwrite=force,
    )
    return _convert(source, destination, log_frames=log_frames)


def register_actions(registry: ActionsRegistry) -> list[str]:
    """Register every ``@action``-decorated free function by its bare name.

    The ``Packet/`` prefix consumers see comes from
    ``zelos_sdk.init(name="Packet", actions=True)``.
    """
    module = sys.modules[__name__]
    registered: list[str] = []
    for name, obj in inspect.getmembers(module):
        if name.startswith("_"):
            continue
        if inspect.isfunction(obj) and hasattr(obj, "_action"):
            registry.register(obj, name=name)
            registered.append(name)
    logger.info("Registered %d packet actions", len(registered))
    return registered
