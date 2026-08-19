"""Import probe for the Rust-cored ``zelos-packet`` package.

The extension calls `zelos_packet` directly - no keyword aliases, no method
probing - because the two ship in lockstep and the dependency is pinned `==`.
What lives here is the import probe (so a missing native package is one legible
line rather than a traceback) and the monkeypatch seam the tests use.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_module: Any | None = None
_import_error: BaseException | None = None
_import_attempted = False


class PacketPackageUnavailable(RuntimeError):
    """`zelos-packet` is not importable in this interpreter."""


def _import() -> None:
    global _module, _import_error, _import_attempted
    if _import_attempted:
        return
    _import_attempted = True
    try:
        import zelos_packet
    except Exception as exc:  # ImportError, or a native-load failure
        _import_error = exc
        logger.debug("zelos-packet is not importable: %s", exc)
    else:
        _module = zelos_packet


def available() -> bool:
    """True when `zelos_packet` imported cleanly."""
    _import()
    return _module is not None


def skip_reason() -> str:
    """One-line explanation for why the package is unusable (for test skips)."""
    _import()
    if _module is not None:
        return ""
    return (
        f"zelos-packet is not installed or failed to load ({_import_error!r}). "
        "Install it with `uv sync` once the package is published, or point "
        "[tool.uv.sources] at a local checkout."
    )


def module() -> Any:
    """Return the imported `zelos_packet` module, or raise a legible error.

    Tests monkeypatch this function to inject a stand-in module, which is why
    every call site in this extension goes through it rather than importing
    `zelos_packet` directly.
    """
    _import()
    if _module is None:
        raise PacketPackageUnavailable(skip_reason()) from _import_error
    return _module


def capture_supported() -> bool:
    """Whether live capture has a native backend here (Linux/macOS)."""
    return bool(module().capture_supported()) if available() else False


def permission_remediation() -> str:
    """The package's own platform-specific capture-privilege instructions.

    Empty when the package is unavailable. It is the component that opens the
    handle, so its text is authoritative; the extension only adds context.
    """
    return str(module().permission_remediation()) if available() else ""


def is_permission_error(exc: BaseException) -> bool:
    """Whether `exc` means "the OS refused to give us a capture handle".

    `CapturePermissionError` subclasses `PermissionError`, so this one check
    covers it. `InterfaceNotFoundError` is a `ValueError` and correctly does not
    match - a typo'd interface is not a privilege problem.
    """
    return isinstance(exc, PermissionError)
