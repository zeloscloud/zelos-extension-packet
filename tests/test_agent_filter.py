"""Agent-endpoint resolution from `$ZELOS_AGENT_URL`."""

from __future__ import annotations

import socket

import pytest

from zelos_extension_packet.agent_filter import (
    DEFAULT_AGENT_PORT,
    ConfigError,
    is_loopback_interface,
    parse_agent_url,
    resolve_agent_endpoint,
    resolve_literals,
)


def fake_resolver(host, port, *_args, **_kwargs):
    """getaddrinfo stand-in: `localhost` is dual-stack, anything else is v4."""
    if host == "localhost":
        return [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
        ]
    if host == "unresolvable.invalid":
        raise socket.gaierror("nodename nor servname provided")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", port))]


class TestParseAgentUrl:
    def test_default_when_env_is_unset(self, monkeypatch):
        monkeypatch.delenv("ZELOS_AGENT_URL", raising=False)
        assert parse_agent_url() == ("localhost", 2300)

    def test_full_url(self):
        assert parse_agent_url("http://agent.local:2400") == ("agent.local", 2400)

    def test_grpc_scheme(self):
        assert parse_agent_url("grpc://10.0.0.5:2300") == ("10.0.0.5", 2300)

    def test_bare_host(self):
        # No scheme, no port - the form users actually type.
        assert parse_agent_url("agent.local") == ("agent.local", DEFAULT_AGENT_PORT)

    def test_host_and_port_without_scheme(self):
        assert parse_agent_url("agent.local:2555") == ("agent.local", 2555)

    def test_url_without_explicit_port_uses_the_default(self):
        assert parse_agent_url("http://agent.local") == ("agent.local", 2300)

    def test_ipv6_with_scheme_and_brackets(self):
        assert parse_agent_url("http://[::1]:2300") == ("::1", 2300)

    def test_ipv6_bracketed_without_scheme(self):
        assert parse_agent_url("[fe80::1]:2400") == ("fe80::1", 2400)

    def test_ipv6_bare_literal(self):
        # An unbracketed IPv6 literal cannot carry a port; take it whole.
        assert parse_agent_url("::1") == ("::1", DEFAULT_AGENT_PORT)

    def test_env_var_is_used(self, monkeypatch):
        monkeypatch.setenv("ZELOS_AGENT_URL", "http://box:9000")
        assert parse_agent_url() == ("box", 9000)

    def test_explicit_argument_beats_env(self, monkeypatch):
        monkeypatch.setenv("ZELOS_AGENT_URL", "http://box:9000")
        assert parse_agent_url("http://other:1234") == ("other", 1234)

    def test_unparseable_port_falls_back_to_default(self):
        assert parse_agent_url("host:notaport") == ("host", DEFAULT_AGENT_PORT)


class TestResolveLiterals:
    def test_ipv4_literal_resolves_to_itself(self):
        assert resolve_literals("10.0.0.1", 2300, resolver=fake_resolver) == ("10.0.0.1",)

    def test_ipv6_literal_resolves_to_itself(self):
        assert resolve_literals("::1", 2300, resolver=fake_resolver) == ("::1",)

    def test_hostname_resolves_to_both_families_ipv4_first(self):
        assert resolve_literals("localhost", 2300, resolver=fake_resolver) == (
            "127.0.0.1",
            "::1",
        )

    def test_ipv6_zone_id_is_stripped(self):
        # `fe80::1%en0` satisfies ip_address() but the native filter's IpAddr
        # parse rejects it, so the zone must never reach the constructor.
        assert resolve_literals("fe80::1%en0", 2300, resolver=fake_resolver) == ("fe80::1",)

    def test_unresolvable_host_is_a_config_error(self):
        # Passing the name through would fail natively as a bare ValueError at
        # capture construction; this names the setting to fix.
        with pytest.raises(ConfigError, match="ZELOS_AGENT_URL"):
            resolve_literals("unresolvable.invalid", 2300, resolver=fake_resolver)


class TestResolveAgentEndpoint:
    def test_default_endpoint_is_dual_stack_localhost(self, monkeypatch):
        monkeypatch.delenv("ZELOS_AGENT_URL", raising=False)
        endpoint = resolve_agent_endpoint(resolver=fake_resolver)
        assert endpoint.host == "localhost"
        assert endpoint.port == 2300
        assert endpoint.literals == ("127.0.0.1", "::1")

    def test_describe_shows_the_resolution(self, monkeypatch):
        monkeypatch.delenv("ZELOS_AGENT_URL", raising=False)
        described = resolve_agent_endpoint(resolver=fake_resolver).describe()
        assert "localhost:2300" in described
        assert "127.0.0.1" in described and "::1" in described

    def test_ipv6_endpoint_from_env(self, monkeypatch):
        monkeypatch.setenv("ZELOS_AGENT_URL", "http://[::1]:2300")
        endpoint = resolve_agent_endpoint(resolver=fake_resolver)
        assert endpoint.host == "::1"
        assert endpoint.literals == ("::1",)
        assert endpoint.describe() == "::1:2300"


@pytest.mark.parametrize("name", ["lo", "lo0", "LO", " loopback "])
def test_loopback_names(name: str):
    assert is_loopback_interface(name)


@pytest.mark.parametrize("name", ["eth0", "en0", "wlan0"])
def test_non_loopback_names(name: str):
    assert not is_loopback_interface(name)
