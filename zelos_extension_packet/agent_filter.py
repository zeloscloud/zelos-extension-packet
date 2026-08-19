"""Resolve the Zelos agent endpoint so captured traffic can exclude it.

The extension publishes every captured packet *to the agent, over the network*.
Capturing that traffic therefore feeds the extension its own output: one packet
in produces one row out, the row is published, and the publish is captured. At
useful snapshot lengths a row is larger than the packet that produced it, so
the loop amplifies rather than settling. Excluding the agent's own address and
port is the fix, and it is on by default.

The agent endpoint is resolved exactly the way the SDK resolves it: the
``ZELOS_AGENT_URL`` environment variable, then ``http://localhost:2300``. A
hostname is resolved to *both* its IPv4 and IPv6 literals, because the capture
filter matches on wire addresses and `localhost` is routinely both `127.0.0.1`
and `::1`.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

DEFAULT_AGENT_URL = "http://localhost:2300"
DEFAULT_AGENT_PORT = 2300


class ConfigError(ValueError):
    """The extension configuration cannot be turned into capture sessions.

    Lives in this module (which imports nothing from the package) so endpoint
    resolution can raise it without an import cycle; `capture` re-exports it.
    """


@dataclass(frozen=True)
class AgentEndpoint:
    """The agent's host as configured, its port, and its resolved literals."""

    host: str
    port: int
    literals: tuple[str, ...]

    def describe(self) -> str:
        joined = ", ".join(self.literals) or "<unresolved>"
        if self.literals == (self.host,):
            return f"{self.host}:{self.port}"
        return f"{self.host}:{self.port} -> [{joined}]:{self.port}"


def agent_url(url: str | None = None) -> str:
    """Effective agent URL: explicit argument, then env, then the default."""
    return (url or os.environ.get("ZELOS_AGENT_URL") or DEFAULT_AGENT_URL).strip() or (
        DEFAULT_AGENT_URL
    )


def parse_agent_url(url: str | None = None) -> tuple[str, int]:
    """Split an agent URL into ``(host, port)``.

    Accepts every form the SDK accepts, plus the bare forms users actually type:

    * ``http://host:2300`` / ``grpc://host:2300`` - full URL
    * ``host`` - bare hostname, default port
    * ``host:2300`` - host and port with no scheme
    * ``http://[::1]:2300`` / ``[::1]:2300`` / ``::1`` - IPv6, bracketed or not
    """
    raw = agent_url(url)

    if "://" in raw:
        parts = urlsplit(raw)
    elif raw.startswith("["):
        # Bracketed IPv6 with no scheme: "[::1]:2300"
        parts = urlsplit(f"//{raw}")
    elif raw.count(":") > 1:
        # Unbracketed IPv6 literal ("::1", "fe80::1"). urlsplit cannot parse it,
        # and a port cannot be expressed this way, so take it whole.
        return raw, DEFAULT_AGENT_PORT
    else:
        parts = urlsplit(f"//{raw}")

    host = parts.hostname or "localhost"
    try:
        port = parts.port or DEFAULT_AGENT_PORT
    except ValueError:
        logger.warning("Agent URL %r has an unparseable port; using %d", raw, DEFAULT_AGENT_PORT)
        port = DEFAULT_AGENT_PORT
    return host, port


def resolve_literals(host: str, port: int, resolver=socket.getaddrinfo) -> tuple[str, ...]:
    """Resolve `host` to its IPv4 and IPv6 literals, IPv4 first, deduplicated.

    Raises:
        ConfigError: when `host` resolves to nothing. The native filter parses
        every entry as an IP address, so a hostname handed through would be
        rejected there as a bare ValueError at capture construction; failing
        here names the setting to fix instead.
    """
    # Strip any zone id first: `fe80::1%en0` satisfies ip_address() but not the
    # native (Rust `IpAddr`) parse, and the wire address is what the filter matches.
    literal = host.split("%", 1)[0]
    try:
        ipaddress.ip_address(literal)
    except ValueError:
        pass
    else:
        return (literal,)

    try:
        infos = resolver(host, port, 0, socket.SOCK_STREAM)
    except OSError as exc:
        raise ConfigError(
            f"Could not resolve the Zelos agent host {host!r} ({exc}), so its traffic "
            "cannot be excluded from the capture. Point ZELOS_AGENT_URL at an address "
            "this machine resolves, or turn off 'Exclude Agent Traffic' (which risks a "
            "capture/publish feedback loop)."
        ) from exc

    v4: list[str] = []
    v6: list[str] = []
    for family, _type, _proto, _canon, sockaddr in infos:
        if not sockaddr:
            continue
        literal = str(sockaddr[0])
        if family == socket.AF_INET and literal not in v4:
            v4.append(literal)
        elif family == socket.AF_INET6 and literal not in v6:
            # Drop any scope id: the wire address is what the filter matches.
            v6.append(literal.split("%", 1)[0])

    literals = tuple(v4 + [addr for addr in v6 if addr not in v4])
    if not literals:
        raise ConfigError(
            f"The Zelos agent host {host!r} resolved to no usable addresses, so its "
            "traffic cannot be excluded from the capture. Point ZELOS_AGENT_URL at an "
            "address this machine resolves, or turn off 'Exclude Agent Traffic'."
        )
    return literals


def resolve_agent_endpoint(url: str | None = None, resolver=socket.getaddrinfo) -> AgentEndpoint:
    """Full resolution: URL (or ``$ZELOS_AGENT_URL``) to host, port and literals."""
    host, port = parse_agent_url(url)
    literals = resolve_literals(host, port, resolver=resolver)
    return AgentEndpoint(host=host, port=port, literals=literals)


LOOPBACK_NAMES = frozenset({"lo", "lo0", "loopback", "localhost"})


def is_loopback_interface(name: str) -> bool:
    """Heuristic loopback check, used only to decide whether to warn."""
    return name.strip().lower() in LOOPBACK_NAMES


AMPLIFICATION_WARNING = (
    "Agent-traffic exclusion is DISABLED while capturing on loopback interface %r. "
    "The agent is reached over this interface, so every row this extension "
    "publishes is captured again, and at snaplen %d a row is larger than the "
    "packet that produced it - the feedback loop amplifies without settling. "
    "Re-enable 'Exclude Agent Traffic' unless you are deliberately measuring this."
)
