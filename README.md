# Packet Capture

Live network capture and pcap decode, in your Zelos workspace.

- 📡 **Capture any NIC** — Linux and macOS, several interfaces at once
- 🔍 **Every packet as a row** — addresses, ports, protocol, flags, and the raw bytes
- 🧭 **Drag into a packet panel** — Wireshark-style list, filter as you type
- 📈 **Plot the capture itself** — packet and byte rates, kernel drops
- 📁 **Open a pcap** — decode `.pcap`/`.pcapng` with no privileges and no NIC
- ⏱️ **One timeline** — packets line up with your CAN and sensor data

## Quick start

```bash
zelos extensions install packet-capture
zelos extensions start packet-capture --config '{"interfaces": [{"interface": "lo0"}]}'
```

Capturing needs elevated privileges. Check first — it prints the exact command for your OS:

```bash
zelos actions execute packet/check_permissions
```

No capture rights? Decode a file instead, which needs none:

```bash
zelos extensions start packet-capture --config '{"replay_pcap": "capture.pcapng"}'
```

Rows land under `packet` → `<interface>` → `packets`. Drag that node into the workspace for a
packet panel; drag `stats` for a plot.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `interfaces[].interface` | – | NIC to capture. `packet/list_interfaces` shows what is available |
| `interfaces[].name` | interface name | Names the branch: `packet.<name>/packets` |
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
zelos-extension-packet interfaces            # list NICs
zelos-extension-packet check                 # probe permissions
zelos-extension-packet capture eth0 eth1     # capture, no app config
zelos-extension-packet replay capture.pcap   # stream a file to the agent
zelos-extension-packet convert capture.pcap  # write capture.trz, no agent needed
```

## Links

- [Documentation](https://docs.zeloscloud.io)
- [Issues](https://github.com/zeloscloud/zelos-extension-packet/issues)

Apache-2.0. See [LICENSE](LICENSE).
