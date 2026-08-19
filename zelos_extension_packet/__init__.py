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

__all__ = [
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
