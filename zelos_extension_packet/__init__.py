"""Zelos Packet extension.

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

#: The namespace of the actions and the trace source; it must equal `name` in extension.toml.
ACTION_PREFIX = "Packet"

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
