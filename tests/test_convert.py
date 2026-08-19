"""Conversion: output defaulting, the no-agent path, and batch isolation."""

from __future__ import annotations

from pathlib import Path

import pytest

from zelos_extension_packet.converter import convert_paths, convert_pcap, resolve_output

from .conftest import needs_real_packet, write_pcap


class TestOutputPath:
    def test_defaults_to_the_input_with_a_trz_suffix(self):
        assert resolve_output(Path("/caps/run1.pcap")) == Path("/caps/run1.trz")
        assert resolve_output(Path("/caps/run1.pcapng")) == Path("/caps/run1.trz")

    def test_output_dir_keeps_the_input_stem(self):
        out = resolve_output(Path("/caps/run1.pcap"), output_dir=Path("/traces"))
        assert out == Path("/traces/run1.trz")

    def test_existing_output_needs_overwrite(self, tmp_path: Path):
        existing = tmp_path / "run1.trz"
        existing.touch()
        with pytest.raises(FileExistsError):
            resolve_output(tmp_path / "run1.pcap")
        assert resolve_output(tmp_path / "run1.pcap", overwrite=True) == existing


class TestNoAgent:
    def test_conversion_never_calls_sdk_init(self, fake_packet, sample_pcap: Path, monkeypatch):
        """Writing a .trz must not stand up a publish client."""
        import zelos_sdk

        def boom(*args, **kwargs):
            raise AssertionError("convert_pcap must not call zelos_sdk.init()")

        monkeypatch.setattr(zelos_sdk, "init", boom)
        result = convert_pcap(sample_pcap, sample_pcap.with_suffix(".trz"))
        assert result["packets"] == 3
        assert Path(result["output_file"]).exists()


class TestBatch:
    def test_two_inputs_produce_two_outputs(self, fake_packet, tmp_path: Path):
        from .conftest import _udp_packet

        frame = _udp_packet("10.0.0.1", "10.0.0.2", 1, 2, b"ab")
        a = write_pcap(tmp_path / "a.pcap", [frame])
        b = write_pcap(tmp_path / "b.pcap", [frame, frame])

        results = convert_paths([a, b])

        assert [r["status"] for r in results] == ["success", "success"]
        assert [r["packets"] for r in results] == [1, 2]
        assert (tmp_path / "a.trz").exists()
        assert (tmp_path / "b.trz").exists()

    def test_a_bad_input_does_not_abort_the_good_one(self, fake_packet, tmp_path: Path):
        from .conftest import _udp_packet

        missing = tmp_path / "gone.pcap"
        good = write_pcap(tmp_path / "good.pcap", [_udp_packet("10.0.0.1", "10.0.0.2", 1, 2, b"a")])

        results = convert_paths([missing, good])

        assert results[0]["status"] == "error"
        assert "FileNotFoundError" in results[0]["message"]
        assert results[1]["status"] == "success"
        assert (tmp_path / "good.trz").exists()

    def test_directory_input_expands_to_its_captures(self, fake_packet, tmp_path: Path):
        from .conftest import _udp_packet

        frame = _udp_packet("10.0.0.1", "10.0.0.2", 1, 2, b"ab")
        write_pcap(tmp_path / "a.pcap", [frame])
        write_pcap(tmp_path / "b.pcapng", [frame])
        (tmp_path / "notes.txt").write_text("ignored")

        results = convert_paths([tmp_path], output_dir=tmp_path / "out")

        assert [Path(r["output_file"]).name for r in results] == ["a.trz", "b.trz"]


class TestRealPackage:
    @needs_real_packet
    def test_written_trace_holds_every_packet(self, sample_pcap: Path, tmp_path: Path):
        """The .trz on disk must contain the rows, not just report a count."""
        pa = pytest.importorskip("pyarrow")
        import zelos_sdk

        out = tmp_path / "explicit.trz"
        assert convert_pcap(sample_pcap, out)["packets"] == 3

        with zelos_sdk.TraceReader(str(out)) as reader:
            segments = reader.list_data_segments()
            event = reader.list_fields()[0].events[0]
            span = reader.time_range()
            result = reader.query(
                data_segment_ids=[s.id for s in segments],
                fields=[event.fields[0].path],
                start=span.start,
                end=span.end,
            )
            table = pa.ipc.open_stream(result.to_arrow()).read_all()

        assert event.name == "pkt"
        assert table.num_rows == 3

    @needs_real_packet
    def test_a_failed_decode_leaves_no_stub_trz(self, tmp_path: Path):
        """The writer creates the file before the first packet is decoded, so a
        stub .trz would be indistinguishable from an empty capture."""
        corrupt = tmp_path / "corrupt.pcap"
        corrupt.write_bytes(b"not a pcap at all")

        with pytest.raises(RuntimeError):
            convert_pcap(corrupt, tmp_path / "corrupt.trz")

        assert not (tmp_path / "corrupt.trz").exists()
