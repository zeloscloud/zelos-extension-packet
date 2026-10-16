import type {
  AppBridgePanelData,
  AppBridgePanelSignal,
  ColumnMetadata,
  LatestSignalValue,
  LiveQueryAllMultiParams,
  MockBridge,
  QueryCellValue,
  QueryDataMulti,
} from "@zeloscloud/app-extension-sdk";
import { signalPath } from "@zeloscloud/app-extension-sdk";
import { PACKET_FIELDS } from "./data";
import { PACKET_EVENT_FIELDS } from "./event-fetch";

/**
 * A synthetic capture for `npm run dev`, where the SDK's mock host stands in for Zelos: one interface,
 * `Packet/eth0`, writing TCP, UDP and ICMP packets with real frame bytes, plus its stats counters. The
 * host's side is played here: the rows and stats subscriptions are pushed every 250 ms, the cursor moves,
 * and the one-packet re-fetch behind the drawer and "Copy row as JSON" is answered from the same packets.
 *
 * Loaded only when the bridge is the standalone mock (see `main.tsx`), so the panel never runs it in Zelos.
 */

const SOURCE = "Packet";
const PACKETS = { source: SOURCE, message: "eth0/packets", eventType: "zelos.packet.v1" };
const STATS = { source: SOURCE, message: "eth0/stats", eventType: "zelos.packet.stats.v1" };
const PRODUCER = "dev-agent";
const PUSH_MS = 250;
/** Packets kept for the window and the re-fetch. */
const RETAINED = 2_000;

const STATS_FIELDS = [
  "iface",
  "packets_captured",
  "packets_dropped_kernel",
  "packets_dropped_iface",
  "packets_dropped_agent",
  "truncated_count",
  "bytes_captured",
  "pps",
  "bps",
  "emit_stall_ms",
] as const;

function signal(table: typeof PACKETS, name: string): AppBridgePanelSignal {
  return { ...table, signal: name, color: "", path: signalPath({ ...table, signal: name }) };
}

/** What dragging the `eth0` capture node binds: every field of both events. */
export const DEV_SIGNALS: AppBridgePanelSignal[] = [
  ...PACKET_EVENT_FIELDS.map((name) => signal(PACKETS, name)),
  ...STATS_FIELDS.map((name) => signal(STATS, name)),
];

// ── Frames ───────────────────────────────────────────────────────────────────────────────────────

const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const ipBytes = (address: string) => address.split(".").map(Number);
const hex = (bytes: readonly number[]) => `0x${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const HOST_MAC = "02:00:00:00:00:01";
const GATEWAY_MAC = "02:00:00:00:00:02";
const macBytes = (mac: string) => mac.split(":").map((part) => Number.parseInt(part, 16));

const IPPROTO = { ICMP: 1, TCP: 6, UDP: 17 } as const;

interface Flow {
  proto: keyof typeof IPPROTO;
  src: string;
  dst: string;
  srcPort: number | null;
  dstPort: number | null;
}

/** One packet as the capture would write it: the 31 fields of `zelos.packet.v1`, and its time. */
type DevPacket = Record<string, QueryCellValue> & { timeS: number };

function ethernetIpv4(flow: Flow, outbound: boolean, l4: number[], ttl: number, id: number): number[] {
  const ipLength = 20 + l4.length;
  const ip = [
    0x45,
    0,
    ...be16(ipLength),
    ...be16(id),
    0x40,
    0,
    ttl,
    IPPROTO[flow.proto],
    0,
    0,
    ...ipBytes(flow.src),
    ...ipBytes(flow.dst),
  ];
  const [dstMac, srcMac] = outbound ? [GATEWAY_MAC, HOST_MAC] : [HOST_MAC, GATEWAY_MAC];
  return [...macBytes(dstMac), ...macBytes(srcMac), ...be16(0x0800), ...ip, ...l4];
}

const TCP_FLAG_NAMES: Array<[number, string]> = [
  [0x02, "SYN"],
  [0x10, "ACK"],
  [0x08, "PSH"],
  [0x01, "FIN"],
];
const flagText = (flags: number) =>
  TCP_FLAG_NAMES.filter(([bit]) => flags & bit)
    .map(([, name]) => name)
    .join(", ");

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0) & 0x7f);

/** One synthetic conversation's packet: its flow, its L4 bytes, and the fields only its protocol has. */
interface Exchange {
  flow: Flow;
  l4: number[];
  info: string;
  extra: Record<string, QueryCellValue>;
  flowId: number;
}

/** An HTTPS conversation: data out, ACKs back. */
function httpsExchange(n: number, outbound: boolean): Exchange {
  const flow: Flow = outbound
    ? { proto: "TCP", src: "10.0.0.5", dst: "93.184.216.34", srcPort: 51514, dstPort: 443 }
    : { proto: "TCP", src: "93.184.216.34", dst: "10.0.0.5", srcPort: 443, dstPort: 51514 };
  const payload = outbound ? ascii(`record ${n}`.padEnd(24, ".")) : [];
  const flags = payload.length > 0 ? 0x18 : 0x10;
  const seq = 1_000 + n * 24;
  const ack = 5_000 + n;
  const window = 64_240;
  const l4 = [
    ...be16(flow.srcPort ?? 0),
    ...be16(flow.dstPort ?? 0),
    ...be32(seq),
    ...be32(ack),
    0x50,
    flags,
    ...be16(window),
    0,
    0,
    0,
    0,
    ...payload,
  ];
  const info = `${flow.srcPort} → ${flow.dstPort} [${flagText(flags)}] Seq=${seq} Ack=${ack} Win=${window} Len=${payload.length}`;
  return { flow, l4, info, extra: { tcp_flags: flags, tcp_seq: seq, tcp_ack: ack, tcp_window: window }, flowId: 1 };
}

/** DNS, query and answer. */
function dnsExchange(n: number, outbound: boolean): Exchange {
  const flow: Flow = outbound
    ? { proto: "UDP", src: "10.0.0.5", dst: "8.8.8.8", srcPort: 5353, dstPort: 53 }
    : { proto: "UDP", src: "8.8.8.8", dst: "10.0.0.5", srcPort: 53, dstPort: 5353 };
  const payload = ascii(outbound ? "query example.com A" : "answer 93.184.216.34");
  const l4 = [...be16(flow.srcPort ?? 0), ...be16(flow.dstPort ?? 0), ...be16(8 + payload.length), 0, 0, ...payload];
  const info = outbound ? `Standard query 0x${(n & 0xffff).toString(16)} A example.com` : "Standard query response A 93.184.216.34";
  return { flow, l4, info, extra: { udp_len: 8 + payload.length }, flowId: 2 };
}

/** A ping and its echo. */
function pingExchange(n: number, outbound: boolean): Exchange {
  const flow: Flow = outbound
    ? { proto: "ICMP", src: "10.0.0.5", dst: "1.1.1.1", srcPort: null, dstPort: null }
    : { proto: "ICMP", src: "1.1.1.1", dst: "10.0.0.5", srcPort: null, dstPort: null };
  const type = outbound ? 8 : 0;
  const seq = n >> 1;
  const l4 = [type, 0, 0, 0, ...be16(1), ...be16(seq), ...ascii("abcdefgh")];
  const info = `Echo (ping) ${outbound ? "request" : "reply"} id=0x0001, seq=${seq}`;
  return { flow, l4, info, extra: { icmp_type: type, icmp_code: 0 }, flowId: 3 };
}

/** Three packets in five are HTTPS, one DNS, one ping. */
function exchange(n: number, outbound: boolean): Exchange {
  const kind = n % 5;
  if (kind <= 2) return httpsExchange(n, outbound);
  return kind === 3 ? dnsExchange(n, outbound) : pingExchange(n, outbound);
}

/** Packet number `n` of the synthetic capture, at `timeS`. */
function makePacket(n: number, timeS: number): DevPacket {
  const outbound = n % 2 === 0;
  const { flow, l4, info, extra, flowId } = exchange(n, outbound);

  const frame = ethernetIpv4(flow, outbound, l4, outbound ? 64 : 56, n & 0xffff);
  const fields: Record<string, QueryCellValue> = Object.fromEntries(PACKET_EVENT_FIELDS.map((name) => [name, null]));
  Object.assign(fields, {
    frame_no: n,
    iface: "eth0",
    link_type: 1,
    orig_len: frame.length,
    cap_len: frame.length,
    truncated: false,
    eth_src: outbound ? HOST_MAC : GATEWAY_MAC,
    eth_dst: outbound ? GATEWAY_MAC : HOST_MAC,
    eth_type: 0x0800,
    ip_version: 4,
    src_ip: flow.src,
    dst_ip: flow.dst,
    ip_proto: IPPROTO[flow.proto],
    ip_ttl: outbound ? 64 : 56,
    ip_len: frame.length - 14,
    frag_offset: 0,
    src_port: flow.srcPort,
    dst_port: flow.dstPort,
    flow_id: flowId,
    proto: flow.proto,
    info,
    frame: hex(frame),
    ...extra,
  });
  return { ...fields, timeS };
}

// ── The host's side ──────────────────────────────────────────────────────────────────────────────

function column(name: string): ColumnMetadata {
  return {
    source: name === "" ? "time_s" : PACKETS.source,
    message: name === "" ? "" : PACKETS.message,
    signal: name,
    producer: PRODUCER,
    tracePath: null,
    dataSegmentId: null,
    startTimeS: null,
    endTimeS: null,
  };
}

/** A column-major window over `packets`, in the order given. */
function window(packets: readonly DevPacket[], fields: readonly string[]): QueryDataMulti {
  return {
    columns: [column(""), ...fields.map(column)],
    data: [packets.map((packet) => packet.timeS), ...fields.map((field) => packets.map((packet) => packet[field] ?? null))],
    range: null,
    queryDurationS: 0,
  };
}

/** `query.liveQueryAllMulti` over the retained packets: the drawer's and "Copy row as JSON"'s re-fetch. */
function answerLiveQuery(packets: readonly DevPacket[], params: LiveQueryAllMultiParams): QueryDataMulti {
  const paths = params.agentSignals[PRODUCER] ?? [];
  const fields = paths
    .filter((path) => path.includes(`${PACKETS.message}.`))
    .map((path) => path.slice(path.lastIndexOf(".") + 1));
  // ISO bounds carry microseconds that Date.parse drops; widen by a millisecond, the frame number decides.
  const start = Date.parse(params.start) / 1000 - 0.001;
  const end = Date.parse(params.end) / 1000 + 0.001;
  const hits = packets.filter((packet) => packet.timeS >= start && packet.timeS <= end);
  return window(hits.slice(0, params.maxRows ?? hits.length), fields);
}

/** Start the feed. Returns the stop function, which also hands `invoke` back to the mock. */
export function startDevFeed(bridge: MockBridge): () => void {
  const packets: DevPacket[] = [];
  let next = 1;
  let bytes = 0;

  // Capture time only moves forward: each push spreads its packets over the time since the last one.
  let capturedToS = Date.now() / 1000 - PUSH_MS / 1000;
  const capture = (nowS: number) => {
    const count = 4;
    const stepS = Math.max(nowS - capturedToS, 0.004) / count;
    for (let i = 1; i <= count; i++) {
      const packet = makePacket(next, capturedToS + i * stepS);
      next += 1;
      bytes += Number(packet.orig_len);
      packets.push(packet);
    }
    capturedToS += count * stepS;
    if (packets.length > RETAINED) packets.splice(0, packets.length - RETAINED);
  };

  const startS = Date.now() / 1000;
  bridge.setPanel({ signals: DEV_SIGNALS });

  const rows = (): Omit<AppBridgePanelData, "seq" | "id"> => ({
    // Newest first, as the panel subscribes.
    dataset: window([...packets].reverse(), PACKET_FIELDS),
    latest: null,
    timeMode: "absolute",
    totalRows: next - 1,
    isLoading: false,
    error: null,
  });

  const stats = (): Omit<AppBridgePanelData, "seq" | "id"> => {
    const timeNs = `${BigInt(Date.now()) * 1_000_000n}`;
    const elapsedS = Math.max(Date.now() / 1000 - startS, PUSH_MS / 1000);
    const values: Record<(typeof STATS_FIELDS)[number], string> = {
      iface: "eth0",
      packets_captured: `${next - 1}`,
      packets_dropped_kernel: `${Math.floor((next - 1) / 400)}`,
      packets_dropped_iface: "0",
      packets_dropped_agent: "0",
      truncated_count: "0",
      bytes_captured: `${bytes}`,
      pps: `${(next - 1) / elapsedS}`,
      bps: `${(bytes * 8) / elapsedS}`,
      emit_stall_ms: "0",
    };
    const latest: LatestSignalValue[] = STATS_FIELDS.map((name) => ({
      source: STATS.source,
      message: STATS.message,
      signal: name,
      producer: PRODUCER,
      value: values[name],
      tracePath: null,
      timeNs,
      dataSegmentId: null,
    }));
    return { dataset: null, latest, timeMode: "absolute", totalRows: 0, isLoading: false, error: null };
  };

  const tick = () => {
    const nowS = Date.now() / 1000;
    capture(nowS);
    // Paused a few seconds back, with the cursor walking forward, so the cursor row moves down the list.
    bridge.setTime({
      mode: "absolute",
      playback: "PAUSED",
      isPlaying: true,
      cursorS: nowS - 3 + ((nowS * 0.5) % 2),
      viewRange: { startS: nowS - 30, endS: nowS },
      dataRange: { startS, endS: nowS },
    });
  };
  const timer = setInterval(tick, PUSH_MS);
  tick();

  // The mock answers `panel.*` itself; only the query the drawer needs is played here.
  const invoke = bridge.invoke;
  bridge.invoke = <T = unknown>(method: string, params?: unknown, options?: Parameters<MockBridge["invoke"]>[2]) =>
    method === "query.liveQueryAllMulti"
      ? Promise.resolve(answerLiveQuery(packets, params as LiveQueryAllMultiParams) as T)
      : invoke.call(bridge, method, params, options) as Promise<T>;

  const stops = [bridge.startPush("packets", rows, PUSH_MS), bridge.startPush("stats", stats, PUSH_MS)];
  return () => {
    clearInterval(timer);
    for (const stop of stops) stop();
    bridge.invoke = invoke;
  };
}
