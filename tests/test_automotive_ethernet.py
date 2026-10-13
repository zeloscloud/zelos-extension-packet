"""SOME/IP, SOME/IP-SD and DoIP: config parsing, the knobs reaching the native
constructors, and a real conversion with ARXML payload decode.

`files/someip-demo.arxml` describes DemoService (0x1234) on UDP 30509; the test
writes its capture.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import pytest
from zelos_sdk.extensions import load_config

from zelos_extension_packet import pkg
from zelos_extension_packet.capture import (
    AutoEthConfig,
    CaptureSession,
    ConfigError,
    InterfaceConfig,
    make_decoder,
    parse_autoeth,
    parse_interfaces,
)
from zelos_extension_packet.converter import convert_pcap

from .conftest import _udp_packet, needs_real_packet, write_pcap

FILES = Path(__file__).parent / "files"
ARXML = FILES / "someip-demo.arxml"
SCHEMA = Path(__file__).resolve().parents[1] / "config.schema.json"


class TestConfig:
    def test_schema_defaults_turn_sd_and_doip_on(self, tmp_path: Path):
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps({}))
        config = load_config(config_path=config_file, schema_path=SCHEMA)
        assert parse_autoeth(config) == AutoEthConfig(sd_port=30490, doip_port=13400)

    def test_null_ports_turn_dissectors_off_and_arxml_resolves(self, tmp_path, monkeypatch):
        monkeypatch.chdir(FILES)
        autoeth = parse_autoeth(
            {
                "advanced": {
                    "someip": {"sd_port": None, "ports": [30509]},
                    "doip": {"port": None},
                    "arxml": ["someip-demo.arxml"],
                }
            }
        )
        assert autoeth == AutoEthConfig(None, (30509,), None, (str(ARXML.resolve()),))

    @pytest.mark.parametrize(
        ("advanced", "snaplen"),
        [
            ({}, 512),
            ({"arxml": ["a.arxml"]}, 1518),
            ({"someip": {"ports": [30509]}}, 1518),
            ({"arxml": ["a.arxml"], "snaplen": 512}, 512),  # a set value wins
        ],
    )
    def test_unset_snaplen_is_a_full_frame_with_arxml_or_ports(self, advanced, snaplen):
        [cfg] = parse_interfaces({"interfaces": [{"interface": "eth0"}], "advanced": advanced})
        assert cfg.snaplen == snaplen

    def test_missing_arxml_is_a_config_error(self, tmp_path: Path):
        with pytest.raises(ConfigError, match="ARXML file not found"):
            parse_autoeth({"advanced": {"arxml": [str(tmp_path / "gone.arxml")]}})


class TestForwarding:
    def test_capture_and_decoder_get_the_same_knobs(self, fake_packet):
        autoeth = AutoEthConfig(30490, (30509,), None, ("/x.arxml",))
        session = CaptureSession(InterfaceConfig("lo0", "lo0"), autoeth=autoeth)
        expected = {
            "someip_sd_port": 30490,
            "someip_ports": [30509],
            "doip_port": None,
            "arxml": ["/x.arxml"],
        }
        assert expected.items() <= session.capture_kwargs().items()
        decoder = make_decoder("x", namespace=object(), autoeth=AutoEthConfig())
        assert decoder.kwargs["arxml"] is None
        assert decoder.kwargs["signal_source"] is None


def _has_arxml() -> bool:
    return pkg.available() and "arxml" in (pkg.module().PacketDecoder.__doc__ or "")


def _column(trace: Path, path: str) -> list:
    pa = pytest.importorskip("pyarrow")
    import zelos_sdk

    with zelos_sdk.TraceReader(str(trace)) as reader:
        span = reader.time_range()
        result = reader.query(
            data_segment_ids=[s.id for s in reader.list_data_segments()],
            fields=[f"*/{path}"],
            start=span.start,
            end=span.end,
        )
        table = pa.ipc.open_stream(result.to_arrow()).read_all()
    field = path.rsplit(".", 1)[1]
    return table.column(next(n for n in table.column_names if n.endswith(field))).to_pylist()


class TestRealPackage:
    @needs_real_packet
    def test_convert_decodes_someip_by_arxml(self, tmp_path: Path):
        if not _has_arxml():
            pytest.skip("zelos-packet predates SOME/IP and ARXML decode")
        # 50 Status notifications (speed u16 x0.01, temperature i16, mode u8), then
        # a DoIP vehicle identification request.
        frames = [
            _udp_packet(
                "10.0.0.1",
                "10.0.0.2",
                30509,
                40000,
                struct.pack("!HHIHHBBBB", 0x1234, 0x8001, 13, 0, i + 1, 1, 1, 0x02, 0)
                + struct.pack("!HhB", 1000 + 37 * i, -200, 0),
            )
            for i in range(50)
        ]
        frames.append(
            _udp_packet("10.0.0.2", "10.0.0.1", 40001, 13400, b"\x02\xfd\x00\x01\0\0\0\0")
        )
        pcap = write_pcap(tmp_path / "demo.pcap", frames)
        out = tmp_path / "demo.trz"
        autoeth = parse_autoeth({"advanced": {"arxml": [str(ARXML)]}})
        assert convert_pcap(pcap, out, autoeth=autoeth)["packets"] == 51

        speed = _column(out, "SOMEIP/DemoService/Status.speed")
        assert speed == pytest.approx([(1000 + 37 * i) * 0.01 for i in range(50)])
        assert _column(out, "Packet/demo/doip.payload_type") == [1]
