import type { PacketField } from "./data";

// A layout can be hand-edited or written by another build, so every option is re-validated on read.

function parseBooleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** The options schema's maximum, held on read too. */
export const MAX_BUFFER_SIZE = 1_000_000;

/** A positive integer up to {@link MAX_BUFFER_SIZE}, so a bad value can neither empty the buffer nor unbound it. */
function parseBufferSizeOption(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.min(MAX_BUFFER_SIZE, Math.floor(value));
  }
  return fallback;
}

interface PacketOptions {
  /** Forces the Interface column on; a panel with more than one capture shows it anyway. */
  showInterface?: boolean;
  showVlan?: boolean;
  showFragOffset?: boolean;
  autoScroll?: boolean;
  bufferSize?: number;
}

export const DEFAULT_PACKET_OPTIONS: Required<PacketOptions> = {
  // Opt-in, as in Wireshark: most captures carry neither VLAN tags nor fragments.
  showInterface: false,
  showVlan: false,
  showFragOffset: false,
  autoScroll: true,
  bufferSize: 10_000,
} as const;

export type ResolvedPacketOptions = Required<PacketOptions>;

/** The persisted `options` bag, type-checked and clamped back onto {@link DEFAULT_PACKET_OPTIONS}. */
export function resolvePacketPanelOptions(
  options: Record<string, unknown> | null | undefined,
): ResolvedPacketOptions {
  return {
    showInterface: parseBooleanOption(options?.showInterface, DEFAULT_PACKET_OPTIONS.showInterface),
    showVlan: parseBooleanOption(options?.showVlan, DEFAULT_PACKET_OPTIONS.showVlan),
    showFragOffset: parseBooleanOption(
      options?.showFragOffset,
      DEFAULT_PACKET_OPTIONS.showFragOffset,
    ),
    autoScroll: parseBooleanOption(options?.autoScroll, DEFAULT_PACKET_OPTIONS.autoScroll),
    bufferSize: parseBufferSizeOption(options?.bufferSize, DEFAULT_PACKET_OPTIONS.bufferSize),
  };
}

/** Always on screen, so always projected. */
const ALWAYS_ON: readonly PacketField[] = [
  "frame_no",
  "src_ip",
  "src_port",
  "dst_ip",
  "dst_port",
  "proto",
  "orig_len",
  "info",
];

/** Not columns: the drawer's snaplen footer reads `cap_len`/`truncated`; the L4 filters read `ip_proto`. */
const ALWAYS_FETCHED: readonly PacketField[] = ["cap_len", "truncated", "ip_proto"];

/** The fields on screen: both each column's `hide` and the query's projection, so a shown column has its data. */
export function visiblePacketFields(
  options: ResolvedPacketOptions,
  forceInterface: boolean,
): ReadonlySet<PacketField> {
  const fields = new Set<PacketField>(ALWAYS_ON);
  if (options.showInterface || forceInterface) fields.add("iface");
  if (options.showVlan) fields.add("vlan_id");
  if (options.showFragOffset) fields.add("frag_offset");
  return fields;
}

/** What the panel's query projects: every visible field, plus the non-column fields rows need. */
export function packetQueryFields(visible: ReadonlySet<PacketField>): ReadonlySet<PacketField> {
  return new Set<PacketField>([...visible, ...ALWAYS_FETCHED]);
}

/** Semantic, not hashed, so a family keeps its color across captures; mid-tones read on both themes. */
const PROTO_PALETTE: Record<string, string> = {
  TCP: "#3b82f6",
  UDP: "#10b981",
  ICMP: "#f59e0b",
  ICMPV6: "#f59e0b",
  ARP: "#a855f7",
  "HOMEPLUG AV": "#ec4899",
  SDP: "#14b8a6",
  V2GTP: "#6366f1",
};

const PROTO_FALLBACK_COLOR = "#9ca3af";
/** Case-insensitive: the decoder's spelling (`ICMPv6`) is displayed verbatim but keyed uppercased. */
export function getProtoColor(proto: string): string {
  return PROTO_PALETTE[proto.toUpperCase()] ?? PROTO_FALLBACK_COLOR;
}

/** `ip:port`, or the bare address when the packet carries no port (ARP, ICMP, a bare IP frame). */
export function endpointLabel(address: string, port: unknown): string {
  if (!address) return "";
  return port == null ? address : `${address}:${port}`;
}
