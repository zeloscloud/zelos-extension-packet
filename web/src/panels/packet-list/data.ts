import type { QueryCellValue, QueryDataMulti, SortOrder } from "@zeloscloud/app-extension-sdk";
import { text, type TimeMode } from "./grid/format";
import { type BoundSignal, buildFieldStreams, type FieldStream } from "./grid/streams";

/**
 * One captured packet. A packet's interface, producer and segment are ROW attributes, not columns: every
 * bound capture melts into one shared schema.
 */
export interface PacketRow {
  /** `${streamKey}:${frameNo}`. */
  id: string;
  /** Wireshark's "No.": the frame's 1-based index in its capture, and the packet's identity within its stream. */
  frameNo: number;
  timeS: number;
  /**
   * What `timeS` MEANS — epoch seconds (`absolute`) or elapsed seconds (`relative`). Stamped at melt time,
   * not read from the ambient mode: the dataset outlives a mode switch, and the re-fetch has to express its
   * window the same way the row was melted or it looks for the packet in 1970.
   */
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
  /**
   * Which backend table this packet came from. With `frameNo` it addresses the packet exactly, which is
   * what lets the byte view re-fetch the fields the grid never asked for (`event-fetch`).
   */
  streamKey: string;
  /** The stream's catalog coordinates, so the re-fetch can name the signal path without parsing the key. */
  source: string;
  message: string;
}

/**
 * The `zelos.packet.v1` fields this panel MAY melt. `visiblePacketFields` narrows it per panel and that
 * narrowed set is what the query projects. `frame` is deliberately absent — up to a snaplen of bytes per
 * packet, so it is fetched one packet at a time on demand instead.
 */
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
  return (Object.keys(next) as (keyof PacketRow)[]).every((key) => before[key] === next[key]) ? before : next;
}

/**
 * The window holds packets but none carries a frame number: a capture from a Packet extension older than
 * `frame_no`. Rows need that identity, so the panel says why the list is empty instead of showing one.
 */
export function packetsLackFrameNumbers(dataset: QueryDataMulti | null | undefined): boolean {
  const columns = dataset?.columns ?? [];
  return columns.some((c) => c.signal === "orig_len") && !columns.some((c) => c.signal === "frame_no");
}

/**
 * Row `i` of `stream` as a packet, or null when the row is another stream's.
 *
 * Raw cell read: the row-window query path returns plain values, never dictionary indices. If that ever
 * changes, this needs the query's `valueTables` to resolve a code to its label.
 */
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
  // A row belongs to exactly one stream (the union is sparse): every other stream reads null here, its
  // `frame_no` included, and `frame_no` is NOT NULL in a packet's own stream.
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

/**
 * Column-major `QueryDataMulti` → one `PacketRow` per packet, ascending by time.
 *
 * Ids are `(streamKey, frame_no)`: the capture numbered every frame, so two packets sharing a timestamp,
 * even byte for byte (ordinary at line rate), stay distinct without any positional bookkeeping, and the
 * backend's tie order between windows cannot renumber anything.
 *
 * A row identical to its `previous` build keeps that object, so AG Grid can skip reference-identical nodes.
 */
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
    // `time_s` is an f64 (time_ns cast and divided), lossy above ~238ns at today's epoch, which is why it
    // is display, not identity.
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
): { timeColumn: QueryCellValue[]; data: QueryDataMulti["data"]; streams: FieldStream<PacketField>[] } | null {
  const columns = dataset?.columns ?? [];
  const data = dataset?.data ?? [];
  // The time column is identified by metadata, never by position.
  const timeColumnIndex = columns.findIndex((column) => column.source === "time_s");
  const timeColumn = timeColumnIndex < 0 ? undefined : data[timeColumnIndex];
  if (!timeColumn?.length) return null;

  // A stream without `orig_len` is not a packet stream. `orig_len` is NOT NULL in `zelos.packet.v1` and is
  // a member of ALWAYS_ON, so every correctly-bound packet stream carries it — while `zelos.packet.stats.v1`
  // ALSO declares an `iface` field and groups into a stream of its own, which would otherwise melt every
  // stats sample into a phantom packet row holding nothing but an interface name.
  // Deliberate consequence: a panel bound to a packet event that omits `orig_len` renders no rows at all.
  // `frame_no` is the row's identity, so it is required the same way.
  const streams = buildFieldStreams<PacketField>(columns, timeColumnIndex, panelSignals, PACKET_FIELDS).filter(
    (stream) => stream.fields.orig_len >= 0 && stream.fields.frame_no >= 0,
  );
  return streams.length === 0 ? null : { timeColumn, data, streams };
}

/** Row indices `0..count`, in time order for a window fetched in `order`. */
function ascendingIndices(count: number, order: SortOrder): number[] {
  const indices = Array.from({ length: count }, (_, i) => i);
  return order === "desc" ? indices.reverse() : indices;
}
