# Packet Capture

Live network capture and pcap decode, in your Zelos workspace.

- 📡 **Capture any NIC** — Linux and macOS, several interfaces at once
- 🔍 **Every packet as a row** — addresses, ports, protocol, flags, and the raw bytes
- 🧭 **Drag into a packet panel** — Wireshark-style list, filter as you type
- 📈 **Plot the capture itself** — packet and byte rates, kernel drops
- 📁 **Open a pcap** — decode `.pcap`/`.pcapng` with no privileges and no NIC
- ⏱️ **One timeline** — packets line up with your CAN and sensor data

## Granting capture rights

Capturing reads raw frames, which needs elevated privileges. Decoding a file does not.

| OS | Command |
| --- | --- |
| macOS | `sudo dseditgroup -o edit -a "$(whoami)" -t user access_bpf && sudo chgrp access_bpf /dev/bpf* && sudo chmod g+rw /dev/bpf*` — Wireshark's ChmodBPF makes it persistent |
| Linux | `sudo setcap cap_net_raw,cap_net_admin+eip $(which python3.11)` |
| Windows | Not supported this release — use `replay_pcap` |

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

## Settings

| Setting | Default | |
| --- | --- | --- |
| `interfaces[].interface` | – | NIC to capture |
| `interfaces[].name` | interface name | Names this capture's branch in the tree |
| `interfaces[].snaplen` | `512` | Bytes captured per packet; raise for full payloads |
| `interfaces[].promiscuous` | `false` | Enable for a mirror/SPAN port or tap |
| `interfaces[].buffer_size` | `8388608` | Raise if `capture_stats` shows `kernel_drops` climbing |
| `exclude_agent_traffic` | `true` | Leave on — capturing the agent's own traffic feeds it its own output |
| `replay_pcap` | – | Decode a file instead of capturing |
| `log_frames` | `true` | Store raw bytes in the `frame` column |
| `frame_snaplen` | `null` | Bytes stored per packet; `null` stores everything captured |
| `log_level` | `INFO` | |

## Actions

| Action | |
| --- | --- |
| `packet/list_interfaces` | NICs on the machine running the agent |
| `packet/check_permissions` | Can we capture? If not, the exact fix |
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
