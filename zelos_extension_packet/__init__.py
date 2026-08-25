"""Zelos Packet Capture extension.

Live network capture (Linux AF_PACKET, macOS /dev/bpf) and pcap decode, driven
by the Rust-cored `zelos-packet` package.
"""

from .agent_filter import AgentEndpoint, resolve_agent_endpoint
from .capture import (
    CaptureDeniedError,
    CaptureSession,
    ConfigError,
    InterfaceConfig,
    parse_interfaces,
    remediation_text,
    replay_pcap,
)

#: The namespace actions are addressed under. One definition for both the live
#: registration (`zelos_sdk.init(name=ACTION_PREFIX, actions=True)`) and the
#: at-rest inventory the packaging step dumps from `main.py`, which re-exports
#: it. Nothing binds the two, so a mismatch silently produces two unrelated
#: action trees - `packet/convert_pcap` live and `main/convert_pcap` at rest.
#:
#: Also the trace source every capture writes into, so the address a user reads
#: in the app is the one they type.
ACTION_PREFIX = "packet"

__all__ = [
    "ACTION_PREFIX",
    "AgentEndpoint",
    "CaptureDeniedError",
    "CaptureSession",
    "ConfigError",
    "InterfaceConfig",
    "parse_interfaces",
    "remediation_text",
    "replay_pcap",
    "resolve_agent_endpoint",
]
