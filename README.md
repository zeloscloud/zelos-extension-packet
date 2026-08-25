# Zelos extension for network packet capture

Live capture (Linux `AF_PACKET`, macOS `/dev/bpf`) and pcap decode, powered by the Rust-cored [`zelos-packet`](https://github.com/zeloscloud/zelos) package.

## Features

- 📡 **Live capture** - Multiple interfaces at once, each on its own branch of one trace source
- 📁 **pcap decode** - Replay a `.pcap`/`.pcapng` into the agent, or convert it straight to `.trz`
- 🔍 **Dissected columns** - `src_ip`, `dst_port`, `proto`, and the raw `frame` bytes, per packet
- 📊 **Per-second stats** - `kernel_drops`, pps, bps, so overload is visible rather than inferred
- 🔁 **Self-traffic exclusion** - The agent's own endpoint is filtered out by default, so publishing a captured packet does not feed the capture
- 🔐 **Permission remediation** - A failed capture prints the exact command for your OS instead of a traceback

## Quick Start

1. **Install** the extension from the Zelos App
2. **Run the `Check permissions` action** - live capture needs elevated privileges, and this prints the exact fix for your OS. Decoding a pcap needs none.
3. **Run the `List interfaces` action** and paste a NIC name into the configuration
4. **Start** the extension to begin streaming

Every capture writes into one trace source, `packet`, and appears under it as its own branch:

```
packet
├── eth0
│   ├── packets      # one row per frame  — src_ip, dst_port, proto, frame, ...
│   └── stats        # one row per second — kernel_drops, pps, bps, ...
└── wlan0
    ├── packets
    └── stats
```

So a field is addressed `packet.eth0/packets.src_ip`.

## Configuration

All configuration is managed through the Zelos App settings interface.

| Setting | Default | Notes |
| --- | --- | --- |
| `interfaces[].interface` | - | NIC name. Free text: a static schema cannot enumerate NICs, so run `List interfaces` and paste. |
| `interfaces[].name` | interface name | Names the capture's branch: `packet.<name>/packets`. Must be unique — the captures share one source. `.`, `:`, `@`, `/` become `_` (catalog path separators), so `eth0.100` reads `packet.eth0_100/packets`. |
| `interfaces[].snaplen` | `512` | Keeps the control plane byte-complete (Modbus-TCP, DHCP, DNS/mDNS, MQTT CONNECT, DoIP, SOME/IP, PTP) while truncating bulk transfer. `128` breaks DHCP and DNS responses. |
| `interfaces[].promiscuous` | `false` | Noise on switched networks; enable for a mirror/SPAN port or tap. |
| `interfaces[].buffer_size` | `8388608` | Raise if `Capture stats` shows `kernel_drops` climbing. |
| `exclude_agent_traffic` | `true` | Leave on: rows are published to the agent over the network, so capturing that traffic feeds the extension its own output, and a row is bigger than the packet that made it - the loop amplifies. |
| `replay_pcap` | - | Decode a `.pcap`/`.pcapng` instead of capturing. Zero privileges; interfaces are ignored. |
| `log_frames` | `true` | Populate the `frame` Binary column with captured bytes. |
| `frame_snaplen` | `null` | Bytes of each packet **stored** in `frame`; `null` stores every captured byte, so `snaplen` (512) is the single byte budget and the control plane stays byte-complete. Storage only - dissection always reads the full captured bytes, so decoded columns and `orig_len`/`cap_len`/`truncated` are unaffected. |
| `log_level` | `INFO` | |

## Granting capture rights

| OS | Command |
| --- | --- |
| Linux | `sudo setcap cap_net_raw,cap_net_admin+eip $(which python3.11)` |
| macOS | `sudo dseditgroup -o edit -a "$(whoami)" -t user access_bpf && sudo chgrp access_bpf /dev/bpf* && sudo chmod g+rw /dev/bpf*` (Wireshark's ChmodBPF makes it persistent) |
| Windows | Not supported this release - use `replay_pcap`. |

## Actions

| Action | Purpose |
| --- | --- |
| `packet/list_interfaces` | NICs on the machine running the agent. Standalone: runs with the extension stopped. |
| `packet/capture_stats` | Per-interface counters: `packets_read`, `bytes_read`, `packets_truncated`, `kernel_drops`, `decode_stall_ms`, plus `metrics.packets_filtered` (agent traffic excluded) and `metrics.emit_stall_ms`. `kernel_drops` climbing with `metrics.emit_stall_ms` near zero means line-rate overload (raise `buffer_size`); a high `metrics.emit_stall_ms` with no drops means the trace store is backpressuring. |
| `packet/check_permissions` | Can we capture? If not, the exact fix. |
| `packet/convert_pcap` | Convert a `.pcap`/`.pcapng` to a `.trz`. Standalone: runs with the extension stopped, no agent, no privileges. Output defaults to the input with a `.trz` suffix. |

## CLI Usage

```bash
zelos-extension-packet interfaces          # list NICs
zelos-extension-packet check               # probe permissions
zelos-extension-packet capture eth0 eth1   # capture, no app config
zelos-extension-packet replay capture.pcap # decode a file, streaming to the agent
zelos-extension-packet convert capture.pcap             # write capture.trz, no agent
zelos-extension-packet convert ./caps -d traces/ -f     # batch a directory
```

`replay` streams into a running agent; `convert` only writes files - it never calls `zelos_sdk.init()`, so no agent has to be reachable.

| `convert` option | Notes |
| --- | --- |
| `INPUTS...` | Files, shell globs, or a directory (its `.pcap`/`.pcapng` children, non-recursive). One input, one `.trz`; nothing is merged (`zelos trace merge` does that). |
| `-o, --output` | Explicit output path. Single input only. |
| `-d, --output-dir` | Write every `.trz` here instead of alongside its input. |
| `-f, --force` | Overwrite existing outputs. |
| `--no-frames` | Skip the `frame` Binary column. |
| `--no-progress` | Disable progress bars. |

Progress bars need `tqdm` (`pip install zelos-extension-packet[cli]`); without it the conversion runs unchanged and logs an install hint. A failed file does not stop the batch, its partial `.trz` is deleted, and the command exits non-zero.

## Development

Want to contribute or modify this extension? See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete developer guide.

`zelos-packet` is not published yet, so `just install` and `just test` must run inside the monorepo dev shell; `just install-nolive` is the escape hatch.

## Links

- **Repository**: [github.com/zeloscloud/zelos-extension-packet](https://github.com/zeloscloud/zelos-extension-packet)
- **Issues**: [Report bugs or request features](https://github.com/zeloscloud/zelos-extension-packet/issues)

## Support

For help and support:
- 📖 [Zelos Documentation](https://docs.zeloscloud.io)
- 🐛 [GitHub Issues](https://github.com/zeloscloud/zelos-extension-packet/issues)
- 📧 help@zeloscloud.io

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Built with [Zelos](https://zeloscloud.io)**
