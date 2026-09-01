# Changelog

All notable changes to the Zelos Packet Capture extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **pcap -> trz conversion**, one function behind two surfaces: the `convert`
  CLI subcommand and the standalone `Convert Pcap` action. Output defaults to
  the input path with a `.trz` suffix.
- Conversion needs **no agent**: it builds its own `TraceNamespace` +
  `TraceWriter` and never calls `zelos_sdk.init()`, so no publish client is
  stood up. `replay` keeps the streaming-to-agent behaviour it always had.
- Batch conversion: repeated paths, shell globs, or a directory (its
  `.pcap`/`.pcapng` children, non-recursive). One input file, one `.trz` -
  nothing is merged. `--output-dir` redirects outputs; a failure converts one
  file's entry to an error instead of aborting the run, and the command exits
  non-zero if any failed.
- Optional `tqdm` progress (`[cli]` extra): a bar across files in batch mode,
  and a per-file packet counter polled from `decoder.metrics()` while the
  GIL-releasing `convert_file` runs. Missing `tqdm` logs an install hint rather
  than failing.

### Changed
- Log lines carry a UTC ISO 8601 timestamp with milliseconds, matching the
  SDK's Rust tracing format in the same extension log stream.

### Fixed
- A failed decode no longer leaves a stub `.trz` behind. The writer creates the
  file before the first packet, so a partial output was indistinguishable from
  a successful conversion of an empty capture; it is now deleted on failure.

## [0.0.1]

### Added
- Live packet capture on Linux (`AF_PACKET`) and macOS (`/dev/bpf`) via the
  Rust-cored `zelos-packet` package. Multiple interfaces capture concurrently;
  the extension hands each one its own `zelos_sdk` trace source, so the `pkt`
  event lands at `eth0.pkt.src_ip` rather than everything sharing the package's
  default source.
- **Agent-traffic exclusion, on by default.** The agent endpoint is resolved
  from `$ZELOS_AGENT_URL` (falling back to `http://localhost:2300`) to both its
  IPv4 and IPv6 literals and excluded from capture. Without it, publishing a
  captured packet is itself captured, and at useful snapshot lengths a row is
  larger than the packet that produced it - the loop amplifies rather than
  settling. Disabling it while capturing loopback logs a prominent warning.
- **Replay mode** (`replay_pcap`): decode a `.pcap`/`.pcapng` instead of
  capturing. Opens no capture handle, so it works with no privileges at all.
- Actions: `list_interfaces`, `capture_stats`, `check_permissions`.
- CLI subcommands: `interfaces`, `check`, `capture`, `replay`.
- Permission failures exit with copy-pasteable remediation (`setcap` on Linux,
  the ChmodBPF-style `/dev/bpf*` group grant on macOS) instead of a traceback.

### Notes
- Snapshot length defaults to 512 bytes: byte-complete for the embedded and
  industrial control plane (Modbus-TCP, DHCP, DNS, mDNS, MQTT CONNECT, DoIP,
  SOME/IP, PTP) while truncating bulk transfer. 128 would break DHCP and DNS
  responses outright.
- Windows is not supported in this release; use `replay_pcap`.
