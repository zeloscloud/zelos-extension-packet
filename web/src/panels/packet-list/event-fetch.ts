import {
  type BridgeTransport,
  type ColumnMetadata,
  type QueryCellValue,
  type QueryDataMulti,
  query,
  signalPath,
} from "@zeloscloud/app-extension-sdk";
import type { PacketRow } from "./data";
import { secToISOString } from "./grid/format";
import { streamKeyOf } from "./grid/streams";

/**
 * The fields the grid never fetches, fetched one packet at a time.
 *
 * The packet list projects to the fields its columns show; `frame` and the protocol-detail fields are
 * pulled only when the drawer or a menu item asks for that ONE packet, addressed by its `(streamKey,
 * frame_no)` identity, over a 2 ms window around its (lossy, display-only) timestamp.
 */

/** Half-width of the re-fetch window. 2 ms total clears the host's 1 ms minimum range with room to spare. */
const HALF_WINDOW_S = 0.001;

/** Row cap for the re-fetch, and the one widened retry when a 2 ms window really does hold that many. */
const MAX_ROWS = 512;
const WIDENED_MAX_ROWS = 4_096;

/** Every field of `zelos.packet.v1`, in schema order. */
export const PACKET_EVENT_FIELDS = [
  "frame_no",
  "iface",
  "link_type",
  "orig_len",
  "cap_len",
  "truncated",
  "eth_src",
  "eth_dst",
  "eth_type",
  "vlan_id",
  "ip_version",
  "src_ip",
  "dst_ip",
  "ip_proto",
  "ip_ttl",
  "ip_len",
  "frag_offset",
  "src_port",
  "dst_port",
  "tcp_flags",
  "tcp_seq",
  "tcp_ack",
  "tcp_window",
  "udp_len",
  "icmp_type",
  "icmp_code",
  "flow_id",
  "direction",
  "proto",
  "info",
  "frame",
] as const;

/**
 * What the byte view asks for: the frame and its link-layer encapsulation (the dissector must never assume
 * Ethernet — a cooked capture read that way decodes to nonsense). `frame_no`, NOT NULL, is the identity
 * every re-fetch matches on and is added by `fetchPacketEventFields` regardless.
 */
export const PACKET_FRAME_FIELDS = ["link_type", "frame"] as const;

/** "Copy row as JSON": every field in schema order, `frame` included, so it can be pasted into a decoder. */
export function packetRowJson(row: PacketRow, cells: Record<string, QueryCellValue>): Record<string, unknown> {
  const json: Record<string, unknown> = { time_s: row.timeS };
  for (const field of PACKET_EVENT_FIELDS) json[field] = cells[field] ?? null;
  json.producer = row.producer;
  json.trace = row.tracePath;
  return json;
}

/** The packet was not in the window the re-fetch got back — it aged out, or its capture is gone. */
export class PacketEventGoneError extends Error {
  constructor() {
    super("packet no longer available");
    this.name = "PacketEventGoneError";
  }
}

/** The column index of each wanted field of the stream `streamKey`. */
function streamFieldIndices(
  columns: readonly ColumnMetadata[],
  streamKey: string,
  fields: readonly string[],
): Map<string, number> {
  const wanted = new Set<string>(fields);
  const indexByField = new Map<string, number>();
  columns.forEach((column, i) => {
    if (column.source === "time_s" || !wanted.has(column.signal) || streamKeyOf(column) !== streamKey) return;
    indexByField.set(column.signal, i);
  });
  return indexByField;
}

/**
 * The one row of `target`'s stream carrying its frame number, or null. Matched on `frame_no` within the
 * packet's own table, so a second capture of the same event with the same numbering cannot answer for it.
 */
function selectPacketEventRow(
  dataset: QueryDataMulti,
  target: { streamKey: string; frameNo: number },
  fields: readonly string[],
): Record<string, QueryCellValue> | null {
  const indexByField = streamFieldIndices(dataset.columns, target.streamKey, fields);
  const frameNoIndex = indexByField.get("frame_no");
  if (frameNoIndex === undefined) return null;
  const i = dataset.data[frameNoIndex]?.indexOf(target.frameNo) ?? -1;
  if (i < 0) return null;
  const cells: Record<string, QueryCellValue> = {};
  for (const [field, index] of indexByField) cells[field] = dataset.data[index]?.[i] ?? null;
  return cells;
}

/** A wildcard-segment path, so every data segment of the packet's stream answers. */
function queryPath(row: PacketRow, signal: string): string {
  return `*/${signalPath({ source: row.source, message: row.message, signal })}`;
}

async function fetchWindow(
  bridge: BridgeTransport,
  row: PacketRow,
  live: boolean,
  fields: readonly string[],
  maxRows: number,
): Promise<QueryDataMulti> {
  const paths = fields.map((signal) => queryPath(row, signal));
  const start = row.timeS - HALF_WINDOW_S;
  const end = row.timeS + HALF_WINDOW_S;

  if (live) {
    // In a live workspace the packet's stream is addressed by the agent that produced it.
    if (!row.producer) throw new PacketEventGoneError();
    return query.liveQueryAllMulti(bridge, {
      agentSignals: { [row.producer]: paths },
      start: secToISOString(start),
      end: secToISOString(end),
      maxRows,
      sortOrder: "asc",
    });
  }

  if (!row.tracePath) throw new PacketEventGoneError();
  // A relative trace's `time_s` IS relative seconds, so the window has to be expressed under the mode the
  // ROW was melted in, which the ambient mode may already have moved on from.
  const relative = row.timeMode === "relative";
  return query.traceQueryAllMulti(bridge, {
    traceSignals: { [row.tracePath]: paths },
    timeMode: row.timeMode,
    zoomRelative: relative ? { start, end } : null,
    zoomAbsolute: relative ? null : { start: secToISOString(start), end: secToISOString(end) },
    maxRows,
    sortOrder: "asc",
  });
}

/**
 * Re-fetch `fields` for exactly the clicked packet.
 *
 * The window is 2 ms around the row's timestamp, wide enough that the lossy `time_s` cannot miss it, and the
 * packet is picked out by frame number, so whatever else shares its timestamp is irrelevant. There is no
 * nearest-neighbor fallback: showing a different packet's bytes as if they were this one's is worse than
 * saying nothing. GONE when no row carries the number, or the window came back at the row cap so the
 * packet may sit past it (widened once, then given up on).
 *
 * `live` is the workspace mode: a live workspace reads through the packet's producer, any other through
 * its trace.
 */
export async function fetchPacketEventFields(
  bridge: BridgeTransport,
  row: PacketRow,
  fields: readonly string[],
  live: boolean,
): Promise<Record<string, QueryCellValue>> {
  const wanted = fields.includes("frame_no") ? fields : ["frame_no", ...fields];
  for (const maxRows of [MAX_ROWS, WIDENED_MAX_ROWS]) {
    const dataset = await fetchWindow(bridge, row, live, wanted, maxRows);
    const found = selectPacketEventRow(dataset, row, wanted);
    if (found) return found;

    const timeColumnIndex = dataset.columns.findIndex((column) => column.source === "time_s");
    const returned = dataset.data[timeColumnIndex]?.length ?? 0;
    if (returned < maxRows) break;
  }

  throw new PacketEventGoneError();
}
