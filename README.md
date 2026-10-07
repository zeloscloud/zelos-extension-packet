# Packet

Live network capture and pcap decode, in your Zelos workspace.

- 📡 **Capture any NIC** — Linux and macOS, several interfaces at once
- 🔍 **Every packet as a row** — addresses, ports, protocol, flags, and the raw bytes
- 🧭 **Drag into a Packet List** — Wireshark-style list, filter as you type
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
- 🪟 Windows and Intel Macs have no capture agent this release — see [Platforms](#platforms)

## Platforms

| | Linux x86_64 | Linux aarch64 | macOS Apple silicon | macOS Intel | Windows |
| --- | --- | --- | --- | --- | --- |
| Packet List panel (recorded traces) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Capture agent (live capture, pcap replay, `convert_pcap`) | ✅ | ✅ | ✅ | – | – |

The agent runs on the platforms `zelos-packet` ships native wheels for. Everywhere else the panel still
opens any trace that holds packets.

## Quick start

```bash
zelos extensions install packet
zelos extensions start packet --config '{"interfaces": [{"interface": "en0"}]}'
```

If the rights above are missing, the extension stops on start and logs the exact command to fix it.

Decoding a file needs no privileges and no NIC:

```bash
zelos extensions start packet --config '{"replay_pcap": "capture.pcapng"}'
```

Captures appear in the tree under **Packet → your interface → packets**. Drag that node into
the workspace for a Packet List; drag **stats** for a plot.

On Linux without `CAP_NET_RAW` the capture runs in the privileged helper process and streams
to the agent directly, so rows reach the tree the same way — `Packet/check_permissions`
reports which backend a Start would use.

## Packet List panel

The extension ships its own panel, the **Packet List** (Zelos 26.0.10 or later). Drag a capture's
node from the tree onto a layout and the panel opens with it bound; its `stats` ride along.

- 📋 **Wireshark's packet list** — No., Time, Source, Destination, Protocol, Length, Info; Interface, VLAN
  and Fragment Offset are opt-in, and Interface turns on by itself when two captures share the panel
- 🔎 **Two filters that compose** — the search box matches text (`*retry?of*` globs work), and the
  display filter takes `tcp.port == 443 && ip.addr == 10.0.0.5`, `udp or arp`, `info contains dns`
- 🧬 **Click a row for its frame** — the dissection tree and the hex dump, selection linked both ways,
  fetched for that one packet
- 📍 **Right-click a cell** — Set cursor here, Copy value, Copy row as JSON (all 31 fields), View frame bytes
- 📊 **Status strip** — captured, dropped and truncated counts from the capture's own counters, plus rates while live
- ⬇️ **Follows the live tail** — scroll back and the list holds still; **Jump to latest** resumes

Its options (the opt-in columns, font size, auto-scroll, buffer size) are in the panel's Edit sheet.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `interfaces[].interface` | – | NIC to capture |
| `interfaces[].name` | interface name | Names this capture's branch in the tree |
| `advanced.snaplen` | `512` | Bytes captured per packet, on every interface; raise for full payloads |
| `advanced.promiscuous` | `false` | Enable for a mirror/SPAN port or tap |
| `advanced.buffer_size` | `8388608` | Raise if `capture_stats` shows `kernel_drops` climbing |
| `advanced.replay_pcap` | – | Replay a file instead of capturing (original pace, stamped from now) |
| `advanced.log_frames` | `true` | Store raw bytes in the `frame` column |
| `advanced.stored_frame_bytes` | `null` | Bytes stored per packet; `null` stores everything captured |
| `advanced.log_level` | `INFO` | |

## Actions

| Action | |
| --- | --- |
| `Packet/list_interfaces` | NICs on the machine running the agent |
| `Packet/check_permissions` | Can we capture, and through which backend? If not, the exact fix |
| `Packet/capture_stats` | Per-interface counters and drop accounting |
| `Packet/convert_pcap` | Convert a pcap to `.trz`. Runs without the extension started |

## CLI

```bash
uv run zelos-extension-packet interfaces            # list NICs
uv run zelos-extension-packet check                 # probe permissions
uv run zelos-extension-packet capture en0 en1       # capture, no app config
uv run zelos-extension-packet replay capture.pcap   # stream a file to the agent, paced, stamped from now
uv run zelos-extension-packet convert capture.pcap  # write capture.trz, no agent needed
```

## Links

- [Documentation](https://docs.zeloscloud.io)
- [Issues](https://github.com/zeloscloud/zelos-extension-packet/issues)

Apache-2.0. See [LICENSE](LICENSE).
