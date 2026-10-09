import type { AppBridgePanelSignal, LatestSignalValue } from "@zeloscloud/app-extension-sdk";

/** `zelos.packet.stats.v1` and any later version: the counters a capture emits beside its packets. */
const PACKET_STATS_EVENT_PREFIX = "zelos.packet.stats.";

function isPacketStatsSignal(signal: { eventType?: string | null | undefined }): boolean {
  return signal.eventType?.startsWith(PACKET_STATS_EVENT_PREFIX) ?? false;
}

/** A panel's bound signals by role: the packet fields feed the grid, the stats fields feed the strip. */
export function splitPacketSignals<S extends Pick<AppBridgePanelSignal, "eventType">>(
  signals: readonly S[],
): { packets: S[]; stats: S[] } {
  const packets: S[] = [];
  const stats: S[] = [];
  for (const signal of signals) (isPacketStatsSignal(signal) ? stats : packets).push(signal);
  return { packets, stats };
}

/** The strip's fields, in strip order. Cumulative counters, except the two interval rates. */
const STRIP_FIELDS = [
  "packets_captured",
  "packets_dropped_kernel",
  "packets_dropped_agent",
  "truncated_count",
  "pps",
  "bps",
] as const;
type StripField = (typeof STRIP_FIELDS)[number];

interface PacketStatsSummary {
  /** Stats streams that contributed a value: one per capture. */
  captures: number;
  packets: number;
  droppedKernel: number;
  droppedAgent: number;
  truncated: number;
  pps: number;
  bps: number;
}

function later(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return b === null;
  return BigInt(a) > BigInt(b);
}

/**
 * The latest value of each strip field, per capture, summed across captures. Wireshark's status bar: the
 * counters as they stand now, never a history. A stream expanded across data segments answers once per
 * segment, so the newest answer per field wins; a field nobody answered reads as 0.
 */
export function summarizePacketStats(values: readonly LatestSignalValue[]): PacketStatsSummary | null {
  const streams = new Map<string, Partial<Record<StripField, LatestSignalValue>>>();
  for (const value of values) {
    if (!(STRIP_FIELDS as readonly string[]).includes(value.signal)) continue;
    const key = `${value.producer ?? ""} ${value.tracePath ?? ""} ${value.source} ${value.message}`;
    const stream = streams.get(key) ?? {};
    const field = value.signal as StripField;
    const held = stream[field];
    if (!held || later(value.timeNs, held.timeNs)) stream[field] = value;
    streams.set(key, stream);
  }
  if (streams.size === 0) return null;

  const read = (stream: Partial<Record<StripField, LatestSignalValue>>, field: StripField): number => {
    const n = Number(stream[field]?.value);
    return Number.isFinite(n) ? n : 0;
  };
  const summary: PacketStatsSummary = {
    captures: streams.size,
    packets: 0,
    droppedKernel: 0,
    droppedAgent: 0,
    truncated: 0,
    pps: 0,
    bps: 0,
  };
  for (const stream of streams.values()) {
    summary.packets += read(stream, "packets_captured");
    summary.droppedKernel += read(stream, "packets_dropped_kernel");
    summary.droppedAgent += read(stream, "packets_dropped_agent");
    summary.truncated += read(stream, "truncated_count");
    summary.pps += read(stream, "pps");
    summary.bps += read(stream, "bps");
  }
  return summary;
}

const count = (n: number): string => Math.round(n).toLocaleString("en-US");

function bitRate(bps: number): string {
  if (bps < 1_000) return `${count(bps)} bit/s`;
  if (bps < 1_000_000) return `${(bps / 1_000).toFixed(1)} kbit/s`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbit/s`;
  return `${(bps / 1_000_000_000).toFixed(1)} Gbit/s`;
}

/**
 * `Packets N · Dropped K kernel / M agent · X pps · Y bit/s`, then only what is non-zero or plural.
 * `rates: false` drops the two rates: in a recording they describe the interval before the cursor, not
 * traffic anyone is watching, so the counts alone are the answer.
 */
export function formatPacketStats(s: PacketStatsSummary, { rates = true }: { rates?: boolean } = {}): string {
  const parts = [`Packets ${count(s.packets)}`, `Dropped ${count(s.droppedKernel)} kernel / ${count(s.droppedAgent)} agent`];
  if (rates) parts.push(`${count(s.pps)} pps`, bitRate(s.bps));
  if (s.truncated > 0) parts.push(`Truncated ${count(s.truncated)}`);
  if (s.captures > 1) parts.push(`${s.captures} captures`);
  return parts.join(" · ");
}
