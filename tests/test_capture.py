"""Capture session wiring: what reaches `PacketCapture`, and what a denied
capture handle tells the user."""

from __future__ import annotations

import pytest

from zelos_extension_packet.agent_filter import AgentEndpoint
from zelos_extension_packet.capture import (
    METRICS_FIELDS,
    STATS_FIELDS,
    CaptureDeniedError,
    CaptureSession,
    InterfaceConfig,
    builtin_grant_instructions,
    capture_grant_instructions,
    probe_permissions,
)

from .conftest import (
    FAKE_REMEDIATION,
    FakeCapture,
    ensure_sdk_init,
    install_fake,
    needs_real_packet,
)

ENDPOINT = AgentEndpoint(host="localhost", port=2300, literals=("127.0.0.1", "::1"))


def session(**overrides) -> CaptureSession:
    cfg = InterfaceConfig(
        interface=overrides.pop("interface", "en0"),
        name=overrides.pop("name", "en0"),
        snaplen=overrides.pop("snaplen", 512),
        promiscuous=overrides.pop("promiscuous", False),
        buffer_size=overrides.pop("buffer_size", 8 * 1024 * 1024),
    )
    return CaptureSession(cfg, **overrides)


class TestExclusionParameters:
    def test_agent_addrs_and_port_reach_packet_capture(self, fake_packet):
        s = session(endpoint=ENDPOINT)
        s.start()
        [capture] = FakeCapture.instances
        assert capture.kwargs["exclude_agent_addrs"] == ["127.0.0.1", "::1"]
        assert capture.kwargs["exclude_agent_port"] == 2300

    def test_disabled_exclusion_passes_none(self, fake_packet):
        s = session(endpoint=None)
        s.start()
        [capture] = FakeCapture.instances
        assert capture.kwargs["exclude_agent_addrs"] is None
        assert capture.kwargs["exclude_agent_port"] is None

    def test_capture_knobs_are_forwarded(self, fake_packet):
        s = session(
            interface="eth0.100",
            name="eth0_100",
            snaplen=1518,
            promiscuous=True,
            buffer_size=1 << 20,
            endpoint=ENDPOINT,
            log_frames=False,
        )
        s.start()
        [capture] = FakeCapture.instances
        assert capture.kwargs["interface"] == "eth0.100"
        assert capture.kwargs["snaplen"] == 1518
        assert capture.kwargs["promiscuous"] is True
        assert capture.kwargs["buffer_bytes"] == 1 << 20
        assert capture.kwargs["log_frames"] is False
        assert capture.started

    def test_frame_snaplen_defaults_to_store_everything_captured(self, fake_packet):
        """The extension's byte budget is `snaplen` alone: by default every
        captured byte is stored (`frame_snaplen=None`), so the 512 control-plane
        rationale holds end-to-end. An explicit cap must survive to the core."""
        session(endpoint=ENDPOINT).start()
        session(endpoint=ENDPOINT, frame_snaplen=128).start()
        default, capped = FakeCapture.instances
        assert (default.kwargs["snaplen"], default.kwargs["frame_snaplen"]) == (512, None)
        assert capped.kwargs["frame_snaplen"] == 128

    def test_the_shared_source_and_a_per_capture_name_reach_the_core(self, fake_packet):
        # Together these make the tree read `packet` -> `eth0` -> `packets`.
        # The source has to be OUR shared one — letting the package default
        # would build a second source also named `packet`, which nothing
        # rejects and which hides one of the two from path resolution.
        s = session(interface="eth0", name="eth0", endpoint=ENDPOINT)
        s.start()
        [capture] = FakeCapture.instances
        assert capture.kwargs["source"].name == "packet"
        assert capture.kwargs["name"] == "eth0"

    def test_stats_use_the_packages_counter_names(self, fake_packet):
        s = session(endpoint=ENDPOINT)
        s.start()
        stats = s.stats()
        assert stats["interface"] == "en0"
        assert stats["running"] is True
        assert stats["packets_read"] == 12
        assert stats["kernel_drops"] == 0
        assert stats["decode_stall_ms"] == 0.0
        # Exclusion effectiveness and backpressure ride in the metrics sub-dict.
        assert stats["metrics"]["packets_filtered"] == 3
        assert stats["metrics"]["emit_stall_ms"] == 0.0

    def test_stats_before_start_report_not_running(self, fake_packet):
        assert session().stats() == {"interface": "en0", "name": "en0", "running": False}

    def test_stop_joins_the_native_capture(self, fake_packet):
        # `PacketCapture.stop()` joins and drains; there is nothing else to flush.
        s = session(endpoint=ENDPOINT)
        s.start()
        [capture] = FakeCapture.instances
        s.stop()
        assert capture.stopped

    def test_stop_is_idempotent(self, fake_packet):
        s = session(endpoint=ENDPOINT)
        s.start()
        s.stop()
        s.stop()


class TestPermissionDenied:
    def test_eperm_is_translated_with_remediation(self, monkeypatch):
        class DeniedCapture(FakeCapture):
            def __init__(self, **kwargs):
                raise PermissionError(1, "Operation not permitted (/dev/bpf0)")

        install_fake(monkeypatch, capture_cls=DeniedCapture)
        with pytest.raises(CaptureDeniedError) as excinfo:
            session(endpoint=ENDPOINT).start()

        assert "was denied" in str(excinfo.value)
        assert "Permission denied opening a capture handle on 'en0'" in excinfo.value.remediation
        assert "Replay PCAP File" in excinfo.value.remediation

    def test_typed_permission_error_from_start_is_translated(self, monkeypatch):
        from .conftest import FakeCapturePermissionError

        class DeniedCapture(FakeCapture):
            def start(self):
                raise FakeCapturePermissionError("bpf open failed")

        install_fake(monkeypatch, capture_cls=DeniedCapture)
        with pytest.raises(CaptureDeniedError):
            session(endpoint=ENDPOINT).start()

    def test_interface_not_found_is_not_a_privilege_problem(self, monkeypatch):
        from .conftest import FakeInterfaceNotFoundError

        class MissingIface(FakeCapture):
            def start(self):
                raise FakeInterfaceNotFoundError("no such interface: en9")

        install_fake(monkeypatch, capture_cls=MissingIface)
        with pytest.raises(ValueError, match="no such interface"):
            session(endpoint=ENDPOINT).start()

    def test_non_permission_errors_are_not_swallowed(self, monkeypatch):
        class BrokenCapture(FakeCapture):
            def start(self):
                raise OSError("device is down")

        install_fake(monkeypatch, capture_cls=BrokenCapture)
        with pytest.raises(OSError, match="device is down"):
            session(endpoint=ENDPOINT).start()

    def test_probe_reports_can_capture_when_the_handle_opens(self, fake_packet):
        result = probe_permissions()
        assert result["can_capture"] is True
        # First interface that is up and not loopback.
        assert result["interface"] == "en0"

    def test_probe_returns_remediation_instead_of_raising(self, monkeypatch):
        class DeniedCapture(FakeCapture):
            def __init__(self, **kwargs):
                raise PermissionError(1, "Operation not permitted")

        install_fake(monkeypatch, capture_cls=DeniedCapture)
        result = probe_permissions("en0")
        assert result["can_capture"] is False
        assert FAKE_REMEDIATION in result["remediation"]
        assert "Replay PCAP File" in result["remediation"]

    def test_probe_never_starts_the_capture(self, fake_packet):
        # start() registers the pkt schemas; a permission probe must not leave a
        # phantom source in the live catalog.
        probe_permissions("en0")
        [capture] = FakeCapture.instances
        assert capture.started is False


class TestRemediationText:
    def test_native_text_wins_when_the_package_is_available(self, fake_packet):
        # zelos-packet opens the handle, so its instructions are authoritative
        # and must not drift from a second copy maintained here.
        text = capture_grant_instructions()
        assert FAKE_REMEDIATION in text
        assert "Replay PCAP File" in text

    def test_linux_names_setcap_with_the_running_interpreter(self):
        text = builtin_grant_instructions(system="Linux", executable="/usr/bin/python3.11")
        assert "sudo setcap cap_net_raw,cap_net_admin+eip /usr/bin/python3.11" in text
        assert "getcap /usr/bin/python3.11" in text

    def test_macos_names_the_bpf_group_grant(self):
        """The grant must match zelos-packet's own remediation text.

        These two used to disagree — this fallback named an access_bpf group,
        which needs a logout before the membership applies, so a user who
        followed it saw it apparently fail. Pinned on `admin` because a macOS
        admin user is already a member and it takes effect immediately.
        """
        text = builtin_grant_instructions(system="Darwin")
        assert "/dev/bpf*" in text
        assert "sudo chgrp admin /dev/bpf*" in text
        assert "sudo chmod g+rw /dev/bpf*" in text
        assert "access_bpf" not in text, "must not resurrect the logout-required grant"
        assert "ChmodBPF" in text

    def test_every_platform_offers_the_zero_privilege_path(self):
        # Including Windows, which has no live capture in this release.
        for system in ("Linux", "Darwin", "Windows"):
            assert "Replay PCAP File" in builtin_grant_instructions(system=system)


class TestRealPackageContract:
    """Against the installed wheel. None of these need capture privileges: the
    constructor's probe-open may be refused, and that is an accepted outcome."""

    @needs_real_packet
    def test_capture_kwargs_bind_to_the_real_constructor(self):
        import zelos_packet

        ensure_sdk_init()
        kwargs = session(endpoint=ENDPOINT).capture_kwargs()
        try:
            zelos_packet.PacketCapture(**kwargs, source_name="kwarg_probe", log_frames=False)
        except TypeError as exc:  # keyword drift - the thing this guards
            pytest.fail(f"capture_kwargs() no longer binds to PacketCapture: {exc}")
        except Exception:
            pass  # CapturePermissionError / InterfaceNotFoundError are fine here

    @needs_real_packet
    def test_non_ip_exclusion_entry_is_rejected(self):
        import zelos_packet

        ensure_sdk_init()
        # The native filter parses every entry as an IP address, which is why
        # `resolve_literals` refuses to pass a hostname through.
        with pytest.raises(ValueError):
            zelos_packet.PacketCapture(
                "lo0", exclude_agent_addrs=["not-an-ip"], exclude_agent_port=2300
            )

    @needs_real_packet
    def test_capture_stats_exposes_every_field_we_report(self):
        import zelos_packet

        for field in STATS_FIELDS:
            assert hasattr(zelos_packet.CaptureStats, field), f"CaptureStats lost {field}"

    @needs_real_packet
    def test_metrics_expose_every_field_we_report(self):
        import zelos_packet

        # `Metrics` is not exported by name; a decoder (no privileges) yields one.
        ensure_sdk_init()
        metrics = zelos_packet.PacketDecoder(source_name="metrics_probe").metrics()
        for field in METRICS_FIELDS:
            assert hasattr(metrics, field), f"Metrics lost {field}"
