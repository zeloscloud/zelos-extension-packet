"""App-mode wiring: exclusion resolution and the amplification warning."""

from __future__ import annotations

import logging

from zelos_extension_packet import cli
from zelos_extension_packet.agent_filter import AgentEndpoint
from zelos_extension_packet.capture import InterfaceConfig

ENDPOINT = AgentEndpoint(host="localhost", port=2300, literals=("127.0.0.1", "::1"))


def _iface(name: str, snaplen: int = 512) -> InterfaceConfig:
    return InterfaceConfig(interface=name, name=name.replace(".", "_"), snaplen=snaplen)


class TestResolveExclusion:
    def test_enabled_by_default(self, monkeypatch):
        monkeypatch.setattr(cli, "_resolve_agent_endpoint", lambda: ENDPOINT)
        assert cli._resolve_exclusion({}, [_iface("eth0")]) is ENDPOINT

    def test_disabled_returns_none(self):
        assert cli._resolve_exclusion({"exclude_agent_traffic": False}, [_iface("eth0")]) is None

    def test_disabled_on_loopback_warns_about_amplification(self, caplog):
        with caplog.at_level(logging.WARNING):
            cli._resolve_exclusion({"exclude_agent_traffic": False}, [_iface("lo0", 1518)])
        warnings = "\n".join(r.getMessage() for r in caplog.records)
        assert "'lo0'" in warnings
        assert "amplifies" in warnings
        assert "1518" in warnings

    def test_disabled_on_a_normal_interface_warns_but_not_about_loopback(self, caplog):
        with caplog.at_level(logging.WARNING):
            cli._resolve_exclusion({"exclude_agent_traffic": False}, [_iface("eth0")])
        warnings = "\n".join(r.getMessage() for r in caplog.records)
        assert "exclusion is disabled" in warnings
        assert "amplifies" not in warnings


class TestActionsSurface:
    def test_actions_register_under_their_bare_names(self):
        from zelos_sdk.actions import ActionsRegistry

        from zelos_extension_packet import actions

        registered = actions.register_actions(ActionsRegistry())
        assert set(registered) == {
            "list_interfaces",
            "capture_stats",
            "check_permissions",
            "convert_pcap",
        }

    def test_capture_stats_reports_nothing_running(self):
        from zelos_extension_packet import actions

        actions.CAPTURES.clear()
        result = actions.capture_stats()
        assert result["status"] == "warning"
        assert result["captures"] == []

    def test_capture_stats_returns_per_interface_counters(self, fake_packet):
        from zelos_extension_packet import actions
        from zelos_extension_packet.capture import CaptureSession

        session = CaptureSession(_iface("en0"), endpoint=ENDPOINT)
        session.start()
        actions.CAPTURES.clear()
        actions.CAPTURES["en0"] = session
        try:
            result = actions.capture_stats()
            assert result["status"] == "success"
            [stats] = result["captures"]
            assert stats["interface"] == "en0"
            # The counters named in the action's description, as `zelos-packet`
            # spells them.
            assert {
                "packets_read",
                "bytes_read",
                "packets_truncated",
                "kernel_drops",
                "decode_stall_ms",
            } <= set(stats)
            assert {"packets_filtered", "emit_stall_ms"} <= set(stats["metrics"])
        finally:
            actions.CAPTURES.clear()
            session.stop()

    def test_capture_stats_rejects_an_unknown_name(self):
        from zelos_extension_packet import actions

        actions.CAPTURES.clear()
        assert actions.capture_stats("nope")["status"] == "error"

    def test_list_interfaces_action_reports_the_missing_package(self, monkeypatch):
        from zelos_extension_packet import actions, pkg

        monkeypatch.setattr(pkg, "available", lambda: False)
        monkeypatch.setattr(
            pkg, "module", lambda: (_ for _ in ()).throw(pkg.PacketPackageUnavailable("nope"))
        )
        result = actions.list_interfaces()
        assert result["status"] == "error"

    def test_check_permissions_always_returns_remediation_on_failure(self, monkeypatch):
        from zelos_extension_packet import actions, pkg

        monkeypatch.setattr(pkg, "available", lambda: False)
        result = actions.check_permissions()
        assert result["status"] == "error"
        assert result["remediation"]
        assert "Replay PCAP File" in result["remediation"]
