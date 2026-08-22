# Zelos extension for network packet capture

Live capture (Linux `AF_PACKET`, macOS `/dev/bpf`) and pcap decode, powered by the Rust-cored [`zelos-packet`](https://github.com/zeloscloud/zelos) package.

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

Live capture needs elevated privileges. **Run the `Check permissions` action first** - it prints the exact command for your OS. Decoding a pcap needs none.

## Configuration

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

## Actions

| Action | Purpose |
| --- | --- |
| `packet/list_interfaces` | NICs on the machine running the agent. |
| `packet/capture_stats` | Per-interface counters: `packets_read`, `bytes_read`, `packets_truncated`, `kernel_drops`, `decode_stall_ms`, plus `metrics.packets_filtered` (agent traffic excluded) and `metrics.emit_stall_ms`. `kernel_drops` climbing with `metrics.emit_stall_ms` near zero means line-rate overload (raise `buffer_size`); a high `metrics.emit_stall_ms` with no drops means the trace store is backpressuring. |
| `packet/check_permissions` | Can we capture? If not, the exact fix. |
| `packet/convert_pcap` | Convert a `.pcap`/`.pcapng` to a `.trz`. Standalone: runs with the extension stopped, no agent, no privileges. Output defaults to the input with a `.trz` suffix. |

## Granting capture rights

| OS | Command |
| --- | --- |
| Linux | `sudo setcap cap_net_raw,cap_net_admin+eip $(which python3.11)` |
| macOS | `sudo dseditgroup -o edit -a "$(whoami)" -t user access_bpf && sudo chgrp access_bpf /dev/bpf* && sudo chmod g+rw /dev/bpf*` (Wireshark's ChmodBPF makes it persistent) |
| Windows | Not supported this release - use `replay_pcap`. |

## CLI

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

`just install` (or `just install-nolive` while `zelos-packet` is still being built), then `just test`, `just check`, `just package`.
