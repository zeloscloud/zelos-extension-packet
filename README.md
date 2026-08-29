# Packet Capture

Live network capture and pcap decode, in your Zelos workspace.

- 📡 **Capture any NIC** — Linux and macOS, several interfaces at once
- 🔍 **Every packet as a row** — addresses, ports, protocol, flags, and the raw bytes
- 🧭 **Drag into a packet panel** — Wireshark-style list, filter as you type
- 📈 **Plot the capture itself** — packet and byte rates, kernel drops
- 📁 **Open a pcap** — decode `.pcap`/`.pcapng` with no privileges and no NIC
- ⏱️ **One timeline** — packets line up with your CAN and sensor data

## Granting capture rights

Capturing reads raw frames, which needs one grant per machine. Decoding a file does not.

```bash
uv run zelos-extension-packet check     # when denied, prints the exact command for this machine
sudo /path/to/python -m zelos_packet install-helper
```

- 🔐 **Linux** installs a small privileged helper (`cap_net_raw` only) and a `zelos-packet` group; **macOS** installs a boot-time daemon that puts `/dev/bpf*` in the `access_bpf` group
- 🛡️ **Linux** group members can capture on the machine, nothing more — the helper drops every capability before it reads a byte and streams decoded packets, so it never hands out a socket anyone could send with
- ⚠️ **macOS** `access_bpf` members can also **send** arbitrary frames: a bpf device is opened read-write and capture needs the write side
- 🔁 Log out and back in, then restart the agent — a session's groups are fixed at login
- ✅ `python -m zelos_packet status` says whether capture would work right now
- 🪟 Windows has no live capture this release — use `replay_pcap`

## Quick start

```bash
zelos extensions install packet-capture
zelos extensions start packet-capture --config '{"interfaces": [{"interface": "en0"}]}'
```

If the rights above are missing, the extension stops on start and logs the exact command to fix it.

Decoding a file needs no privileges and no NIC:

```bash
zelos extensions start packet-capture --config '{"replay_pcap": "capture.pcapng"}'
```

Captures appear in the tree under **packet → your interface → packets**. Drag that node into
the workspace for a packet panel; drag **stats** for a plot.

On Linux without `CAP_NET_RAW` the capture runs in the privileged helper process and streams
to the agent directly, so rows reach the tree the same way — `packet/check_permissions`
reports which backend a Start would use.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `interfaces[].interface` | – | NIC to capture |
| `interfaces[].name` | interface name | Names this capture's branch in the tree |
| `interfaces[].snaplen` | `512` | Bytes captured per packet; raise for full payloads |
| `interfaces[].promiscuous` | `false` | Enable for a mirror/SPAN port or tap |
| `interfaces[].buffer_size` | `8388608` | Raise if `capture_stats` shows `kernel_drops` climbing |
| `replay_pcap` | – | Decode a file instead of capturing |
| `log_frames` | `true` | Store raw bytes in the `frame` column |
| `frame_snaplen` | `null` | Bytes stored per packet; `null` stores everything captured |
| `log_level` | `INFO` | |

## Actions

| Action | |
| --- | --- |
| `packet/list_interfaces` | NICs on the machine running the agent |
| `packet/check_permissions` | Can we capture, and through which backend? If not, the exact fix |
| `packet/capture_stats` | Per-interface counters and drop accounting |
| `packet/convert_pcap` | Convert a pcap to `.trz`. Runs without the extension started |

## CLI

```bash
uv run zelos-extension-packet interfaces            # list NICs
uv run zelos-extension-packet check                 # probe permissions
uv run zelos-extension-packet capture en0 en1       # capture, no app config
uv run zelos-extension-packet replay capture.pcap   # stream a file to the agent
uv run zelos-extension-packet convert capture.pcap  # write capture.trz, no agent needed
```

## Links

- [Documentation](https://docs.zeloscloud.io)
- [Issues](https://github.com/zeloscloud/zelos-extension-packet/issues)

Apache-2.0. See [LICENSE](LICENSE).
