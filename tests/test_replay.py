"""Replay mode - the zero-privilege path, over a pcap generated in conftest."""

from __future__ import annotations

from pathlib import Path

import pytest

from zelos_extension_packet import pkg
from zelos_extension_packet.capture import ConfigError, replay_pcap

from .conftest import ensure_sdk_init, needs_real_packet


def spy_on_decoder(fake_packet) -> list:
    """Capture the constructed `PacketDecoder` instances."""
    decoders: list = []
    original = fake_packet.PacketDecoder

    def spy(**kwargs):
        decoder = original(**kwargs)
        decoders.append(decoder)
        return decoder

    fake_packet.PacketDecoder = spy
    return decoders


class TestReplay:
    def test_decodes_every_packet_in_the_file(self, fake_packet, sample_pcap: Path):
        result = replay_pcap(sample_pcap)
        assert result["packets"] == 3
        assert result["file"] == str(sample_pcap)

    def test_the_capture_name_is_sanitized(self, fake_packet, tmp_path: Path):
        from .conftest import _udp_packet, write_pcap

        pcap = write_pcap(
            tmp_path / "eth0.100.pcap", [_udp_packet("10.0.0.1", "10.0.0.2", 1, 2, b"ab")]
        )
        decoders = spy_on_decoder(fake_packet)
        replay_pcap(pcap, name="eth0.100")
        # Dots are catalog path separators, so they never reach an event name.
        assert decoders[0].kwargs["name"] == "eth0_100"
        assert decoders[0].kwargs["source"].name == "packet"

    def test_log_frames_is_forwarded(self, fake_packet, sample_pcap: Path):
        decoders = spy_on_decoder(fake_packet)
        replay_pcap(sample_pcap, log_frames=False)
        assert decoders[0].kwargs["log_frames"] is False

    def test_decoder_is_flushed(self, fake_packet, sample_pcap: Path):
        decoders = spy_on_decoder(fake_packet)
        replay_pcap(sample_pcap)
        assert decoders[0].flushed

    def test_missing_file_is_a_config_error(self, fake_packet, tmp_path: Path):
        with pytest.raises(ConfigError, match="Replay file not found"):
            replay_pcap(tmp_path / "nope.pcap")


class TestPcapFixture:
    def test_generated_pcap_is_a_wellformed_classic_pcap(self, sample_pcap: Path):
        data = sample_pcap.read_bytes()
        assert data[:4] == b"\xd4\xc3\xb2\xa1"  # 0xa1b2c3d4, little-endian
        assert len(data) > 24


class TestRealPackage:
    @needs_real_packet
    def test_real_decoder_reads_the_generated_pcap(self, sample_pcap: Path):
        """Runs only when zelos-packet is installed; proves the replay path
        against the shipped package end to end."""
        ensure_sdk_init()
        result = replay_pcap(sample_pcap, name="fixture")
        assert result["file"] == str(sample_pcap)
        assert result["packets"] == 3


class TestContract:
    def test_skip_reason_is_actionable_when_absent(self):
        if pkg.available():
            assert pkg.skip_reason() == ""
        else:
            reason = pkg.skip_reason()
            assert "zelos-packet" in reason
            assert "uv sync" in reason

    @needs_real_packet
    def test_declared_surface_exists_on_the_real_package(self):
        """Every name this extension calls, checked against the shipped package."""
        module = pkg.module()
        for name in (
            "list_interfaces",
            "capture_supported",
            "permission_remediation",
            "CapturePermissionError",
            "InterfaceNotFoundError",
            "PacketCapture",
            "PacketDecoder",
        ):
            assert hasattr(module, name), f"zelos_packet is missing {name}"
        assert pkg.permission_remediation()
        assert issubclass(module.CapturePermissionError, PermissionError)
