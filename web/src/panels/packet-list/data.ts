import type { QueryCellValue, QueryDataMulti, SortOrder } from "@zeloscloud/app-extension-sdk";
import { text, type TimeMode } from "./grid/format";
import { type BoundSignal, buildFieldStreams, type FieldStream } from "./grid/streams";

/** One captured packet; interface, producer and segment are row attributes, so every capture shares one schema. */
export interface PacketRow {
  /** `${streamKey}:${frameNo}`. */
  id: string;
  /** Wireshark's "No.": the frame's 1-based index in its capture, and the packet's identity within its stream. */
  frameNo: number;
  timeS: number;
  /** Stamped at melt time: the re-fetch must express its window the way the row was melted, whatever the mode now. */
  timeMode: TimeMode;
  /** Capture interface (`eth0`, `en0`); `""` when the stream doesn't carry one. */
  iface: string;
  srcIp: string;
  dstIp: string;
  /** Kept raw, not folded into `srcIp`: a null port means "this protocol has none", not port 0. */
  srcPort: QueryCellValue;
  dstPort: QueryCellValue;
  /** As the decoder spelled it (`TCP`, `ICMPv6`, `V2GTP`); the chip keys its color case-insensitively. */
  proto: string;
  /** IP protocol number (6, 17, 1, 58). `proto` is a display label, so L4 filters key on this. */
  ipProto: QueryCellValue;
  origLen: QueryCellValue;
  /** Bytes actually stored. Below `origLen` when the capture hit its snaplen. */
  capLen: QueryCellValue;
  truncated: QueryCellValue;
  vlanId: QueryCellValue;
  fragOffset: QueryCellValue;
  /** The decoder's one-line summary — Wireshark's Info column. */
  info: string;
  /** Agent hostname (live) — null in trace, where `tracePath` identifies the scope instead. */
  producer: string | null;
  tracePath: string | null;
  /** The backend table this packet came from; with `frameNo` it addresses the packet for the re-fetch. */
  streamKey: string;
  /** The stream's catalog coordinates, so the re-fetch can name the signal path without parsing the key. */
  source: string;
  message: string;
}

/** The fields the panel may melt. Not `frame`: up to a snaplen per packet, it is fetched a packet at a time. */
export const PACKET_FIELDS = [
  "frame_no",
  "iface",
  "src_ip",
  "dst_ip",
  "src_port",
  "dst_port",
  "ip_proto",
  "proto",
  "orig_len",
  "cap_len",
  "truncated",
  "vlan_id",
  "frag_offset",
  "info",
] as const;

export type PacketField = (typeof PACKET_FIELDS)[number];

/** `before` when `next` changes nothing in it, so the row keeps its object identity; else `next`. */
function keepIdentity(before: PacketRow | undefined, next: PacketRow): PacketRow {
  if (!before) return next;
  return (Object.keys(next) as (keyof PacketRow)[]).every((key) => before[key] === next[key])
    ? before
    : next;
}

/** Row `i` of `stream`, or null when it is another stream's. Row queries return plain values, never value codes. */
function meltStreamRow(
  stream: FieldStream<PacketField>,
  data: QueryDataMulti["data"],
  i: number,
  timeS: number,
  timeMode: TimeMode,
): PacketRow | null {
  const cells = {} as Record<PacketField, QueryCellValue>;
  for (const field of PACKET_FIELDS) {
    const index = stream.fields[field];
    cells[field] = index >= 0 ? (data[index]?.[i] ?? null) : null;
  }
  // The union is sparse: every other stream's cells read null here, and `frame_no` is NOT NULL in a packet's own.
  const frameNo = cells.frame_no;
  if (typeof frameNo !== "number") return null;

  return {
    id: `${stream.key}:${frameNo}`,
    frameNo,
    timeS,
    timeMode,
    iface: text(cells.iface),
    srcIp: text(cells.src_ip),
    dstIp: text(cells.dst_ip),
    srcPort: cells.src_port,
    dstPort: cells.dst_port,
    proto: text(cells.proto),
    ipProto: cells.ip_proto,
    origLen: cells.orig_len,
    capLen: cells.cap_len,
    truncated: cells.truncated,
    vlanId: cells.vlan_id,
    fragOffset: cells.frag_offset,
    info: text(cells.info),
    producer: stream.producer,
    tracePath: stream.tracePath,
    streamKey: stream.key,
    source: stream.source,
    message: stream.message,
  };
}

/** One row per packet, ascending; ids are `(streamKey, frame_no)`, so packets sharing a timestamp stay distinct. */
export function meltPacketRows(
  dataset: QueryDataMulti | null | undefined,
  fetchedOrder: SortOrder,
  panelSignals: readonly BoundSignal[],
  timeMode: TimeMode,
  previous: readonly PacketRow[] = [],
): PacketRow[] {
  const window = packetWindow(dataset, panelSignals);
  if (!window) return [];
  const { timeColumn, data, streams } = window;

  const previousById = new Map(previous.map((row) => [row.id, row]));
  const rows: PacketRow[] = [];
  // Emit ascending whichever way the backend handed us the window; the panel fetches `desc` (the newest N).
  for (const i of ascendingIndices(timeColumn.length, fetchedOrder)) {
    // A lossy f64 at today's epoch, so it is display, not identity.
    const timeS = Number(timeColumn[i] ?? null);
    if (!Number.isFinite(timeS)) continue;

    for (const stream of streams) {
      const next = meltStreamRow(stream, data, i, timeS, timeMode);
      if (next) rows.push(keepIdentity(previousById.get(next.id), next));
    }
  }

  return rows;
}

/** The window's time column, cells and packet streams, or null when it holds no packets to melt. */
function packetWindow(
  dataset: QueryDataMulti | null | undefined,
  panelSignals: readonly BoundSignal[],
): {
  timeColumn: QueryCellValue[];
  data: QueryDataMulti["data"];
  streams: FieldStream<PacketField>[];
} | null {
  const columns = dataset?.columns ?? [];
  const data = dataset?.data ?? [];
  // The time column is identified by metadata, never by position.
  const timeColumnIndex = columns.findIndex((column) => column.source === "time_s");
  const timeColumn = timeColumnIndex < 0 ? undefined : data[timeColumnIndex];
  if (!timeColumn?.length) return null;

  // Both are NOT NULL in a packet stream; the stats event's `iface` alone would melt into phantom rows.
  const streams = buildFieldStreams<PacketField>(
    columns,
    timeColumnIndex,
    panelSignals,
    PACKET_FIELDS,
  ).filter((stream) => stream.fields.orig_len >= 0 && stream.fields.frame_no >= 0);
  return streams.length === 0 ? null : { timeColumn, data, streams };
}

/** Row indices `0..count`, in time order for a window fetched in `order`. */
function ascendingIndices(count: number, order: SortOrder): number[] {
  const indices = Array.from({ length: count }, (_, i) => i);
  return order === "desc" ? indices.reverse() : indices;
}
