"""Shared fixtures.

Two things live here:

* a **programmatically generated pcap** - no binary fixture is committed, so the
  bytes under test are visible in this file;
* a **fake `zelos_packet` module**, so everything except the native capture path
  is exercised without the real (Rust) package, which is being built in
  parallel. Tests that genuinely need the real package use
  ``needs_real_packet``.
"""

from __future__ import annotations

import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

from zelos_extension_packet import pkg

# ─── pcap generation ────────────────────────────────────────────────────────

PCAP_MAGIC = 0xA1B2C3D4
LINKTYPE_ETHERNET = 1


def _udp_packet(src_ip: str, dst_ip: str, sport: int, dport: int, payload: bytes) -> bytes:
    """A minimal Ethernet/IPv4/UDP frame. Checksums are zero (legal for UDP,
    and no decoder under test validates the IPv4 one)."""
    eth = bytes.fromhex("020000000002") + bytes.fromhex("020000000001") + b"\x08\x00"

    udp_len = 8 + len(payload)
    udp = struct.pack("!HHHH", sport, dport, udp_len, 0) + payload

    total_len = 20 + udp_len
    ip = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,  # version 4, IHL 5
        0x00,  # DSCP/ECN
        total_len,
        0x0001,  # identification
        0x4000,  # don't fragment
        64,  # TTL
        17,  # protocol UDP
        0,  # header checksum (unchecked)
        bytes(int(o) for o in src_ip.split(".")),
        bytes(int(o) for o in dst_ip.split(".")),
    )
    return eth + ip + udp


def write_pcap(path: Path, packets: list[bytes], *, snaplen: int = 65535) -> Path:
    """Write a classic (little-endian, microsecond) pcap file."""
    with path.open("wb") as fh:
        fh.write(struct.pack("<IHHiIII", PCAP_MAGIC, 2, 4, 0, 0, snaplen, LINKTYPE_ETHERNET))
        for index, data in enumerate(packets):
            fh.write(
                struct.pack("<IIII", 1_700_000_000 + index, index * 1000, len(data), len(data))
            )
            fh.write(data)
    return path


@pytest.fixture
def sample_pcap(tmp_path: Path) -> Path:
    """A 3-packet pcap: a DNS query, a Modbus-TCP-ish payload, and an mDNS frame."""
    packets = [
        _udp_packet("192.168.1.10", "192.168.1.1", 51234, 53, b"\x12\x34\x01\x00" + b"\x00" * 8),
        _udp_packet("192.168.1.10", "192.168.1.50", 40000, 502, bytes(range(12))),
        _udp_packet("192.168.1.10", "224.0.0.251", 5353, 5353, b"\x00\x00\x84\x00" + b"\x00" * 8),
    ]
    return write_pcap(tmp_path / "sample.pcap", packets)


# ─── fake zelos_packet ──────────────────────────────────────────────────────


class FakeCapture:
    """Records the kwargs it was constructed with; never touches a socket.

    The signature is the real ``zelos_packet.PacketCapture`` one, spelled out
    rather than ``**kwargs``, so a keyword drifting out of `capture_kwargs()`
    fails here even in an environment with no native wheel.
    """

    instances: list[FakeCapture] = []

    def __init__(
        self,
        interface,
        snaplen=0,
        promiscuous=False,
        buffer_bytes=2 * 1024 * 1024,
        immediate=False,
        source_name="pkt",
        log_frames=True,
        frame_snaplen=256,
        stats_interval=1.0,
        exclude_agent_addrs=None,
        exclude_agent_port=None,
        source=None,
    ):
        self.kwargs = {
            "interface": interface,
            "snaplen": snaplen,
            "promiscuous": promiscuous,
            "buffer_bytes": buffer_bytes,
            "immediate": immediate,
            "source_name": source_name,
            "log_frames": log_frames,
            "frame_snaplen": frame_snaplen,
            "stats_interval": stats_interval,
            "exclude_agent_addrs": exclude_agent_addrs,
            "exclude_agent_port": exclude_agent_port,
            "source": source,
        }
        self.started = False
        self.stopped = False
        FakeCapture.instances.append(self)

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True

    def stats(self) -> SimpleNamespace:
        """Mirrors `zelos_packet.CaptureStats`: an object of getters, not a dict."""
        return SimpleNamespace(
            packets_read=12,
            bytes_read=1024,
            packets_truncated=2,
            kernel_packets=15,
            kernel_drops=0,
            decode_stall_ns=0,
            decode_stall_ms=0.0,
            read_errors=0,
            kernel_timestamps=12,
            fallback_timestamps=0,
        )

    def metrics(self) -> SimpleNamespace:
        """Mirrors `zelos_packet.Metrics` (all 11 getters)."""
        return SimpleNamespace(
            packets_received=12,
            packets_emitted=9,
            packets_filtered=3,
            packets_truncated=1,
            bytes_captured=1024,
            stats_rows_emitted=2,
            emit_errors=0,
            flush_errors=0,
            drain_abandoned=0,
            emit_stall_ns=0,
            emit_stall_ms=0.0,
        )


class FakeDecoder:
    """Counts the packet records in a pcap so replay tests assert something real.

    Real ``PacketDecoder`` signature, for the same reason as `FakeCapture`.
    """

    def __init__(
        self,
        source_name="pkt",
        iface=None,
        log_frames=True,
        frame_snaplen=256,
        emit_schemas_on_init=False,
        source=None,
        exclude_agent_addrs=None,
        exclude_agent_port=None,
    ):
        self.kwargs = {
            "source_name": source_name,
            "iface": iface,
            "log_frames": log_frames,
            "frame_snaplen": frame_snaplen,
            "emit_schemas_on_init": emit_schemas_on_init,
            "source": source,
            "exclude_agent_addrs": exclude_agent_addrs,
            "exclude_agent_port": exclude_agent_port,
        }
        self.flushed = False
        self.packets = 0

    def metrics(self) -> SimpleNamespace:
        """What the in-file progress poller reads while `convert_file` blocks."""
        return SimpleNamespace(packets_received=self.packets)

    def convert_file(self, path: str) -> int:
        data = Path(path).read_bytes()
        header = struct.unpack("<IHHiIII", data[:24])
        assert header[0] == PCAP_MAGIC, "not a little-endian pcap"
        offset = 24
        packets = 0
        while offset + 16 <= len(data):
            _ts, _us, incl, _orig = struct.unpack("<IIII", data[offset : offset + 16])
            offset += 16 + incl
            packets += 1
        self.packets = packets
        return packets

    def flush(self) -> None:
        self.flushed = True


class FakeCapturePermissionError(PermissionError):
    """Stands in for `zelos_packet.CapturePermissionError`, which subclasses
    `PermissionError` in the real package."""


class FakeInterfaceNotFoundError(ValueError):
    """Stands in for `zelos_packet.InterfaceNotFoundError` (a ValueError - a
    typo'd interface is not a privilege problem)."""


class FakeTraceSource:
    """Stands in for `zelos_sdk.TraceSourceCache` / `TraceSource`.

    `cached` is recorded rather than acted on: it is the only thing that
    differs between the live and conversion paths, so a test asserting which
    one a caller asked for needs it visible.
    """

    def __init__(self, name: str, namespace=None, *, cached: bool = True) -> None:
        self.name = name
        self.namespace = namespace
        self.cached = cached


FAKE_REMEDIATION = "fake native remediation: do the thing"


def make_fake_module(*, capture_cls=FakeCapture, interfaces=None) -> SimpleNamespace:
    ifaces = (
        interfaces
        if interfaces is not None
        else [
            SimpleNamespace(
                name="lo0",
                index=1,
                is_up=True,
                is_running=True,
                is_loopback=True,
                addresses=["127.0.0.1", "::1"],
                mac=None,
            ),
            SimpleNamespace(
                name="en0",
                index=2,
                is_up=True,
                is_running=True,
                is_loopback=False,
                addresses=["192.168.1.10"],
                mac="02:00:00:00:00:01",
            ),
        ]
    )
    return SimpleNamespace(
        PacketCapture=capture_cls,
        PacketDecoder=FakeDecoder,
        CapturePermissionError=FakeCapturePermissionError,
        InterfaceNotFoundError=FakeInterfaceNotFoundError,
        list_interfaces=lambda: list(ifaces),
        capture_supported=lambda: True,
        permission_remediation=lambda: FAKE_REMEDIATION,
    )


def install_fake(monkeypatch, *, capture_cls=FakeCapture, interfaces=None) -> SimpleNamespace:
    """Install a stand-in `zelos_packet` (and trace source) for one test.

    `make_trace_source` is stubbed too: constructing a real SDK source would
    reach into the global trace namespace, which these tests have no reason to
    touch.
    """
    from zelos_extension_packet import capture as capture_mod

    FakeCapture.instances.clear()
    module = make_fake_module(capture_cls=capture_cls, interfaces=interfaces)
    monkeypatch.setattr(pkg, "module", lambda: module)
    monkeypatch.setattr(pkg, "available", lambda: True)
    monkeypatch.setattr(capture_mod, "make_trace_source", FakeTraceSource)
    return module


@pytest.fixture
def fake_packet(monkeypatch) -> SimpleNamespace:
    """`install_fake` as a fixture, for tests that need the default shape."""
    return install_fake(monkeypatch)


needs_real_packet = pytest.mark.skipif(
    not pkg.available(),
    reason=pkg.skip_reason() or "zelos-packet unavailable",
)


def ensure_sdk_init() -> None:
    """`zelos_sdk.init()` once per process: the native constructors resolve
    their trace source through the SDK's ABI capsule."""
    import zelos_sdk

    if not zelos_sdk.initialized():
        zelos_sdk.init(name="packet_test")
