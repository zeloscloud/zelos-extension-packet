/**
 * A frame's captured bytes as a labeled tree.
 *
 * NOT a second source of truth. The `pkt` columns the Rust decoder produced stay authoritative; this
 * renders the SAME bytes so a header field can be pointed at in the hex view and back. Where the two could
 * disagree the columns are right.
 *
 * Deliberately primitive: fixed headers only, no reassembly, no application protocols. `frame` is capped at
 * the capture's `stored_frame_bytes`, so a header the capture cut short renders as ONE truncated node
 * rather than a partial parse of bytes that are not there.
 */

/** libpcap DLT numbers, as the `zelos-packet` decoder writes them into `link_type`. */
const DLT_NULL = 0;
const DLT_EN10MB = 1;
const DLT_RAW = 101;
const DLT_LOOP = 108;
const DLT_LINUX_SLL = 113;
const DLT_IPV4 = 228;
const DLT_IPV6 = 229;
const DLT_LINUX_SLL2 = 276;

const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_IPV6 = 0x86dd;
const ETHERTYPE_ARP = 0x0806;
const VLAN_TPIDS = new Set([0x8100, 0x88a8, 0x9100]);
/** Same cap as the Rust dissector, so a tag stack neither side walks stops at the link layer. */
const MAX_VLAN_TAGS = 4;

export const IPPROTO_ICMP = 1;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;
const IPPROTO_FRAGMENT = 44;
export const IPPROTO_ICMPV6 = 58;
/** IPv6 extension headers in `(next_header, hdr_ext_len)` form; the fragment header is a fixed 8 bytes. */
const IPV6_EXT_HEADERS = new Map([
  [0, "Hop-by-Hop Options"],
  [43, "Routing"],
  [IPPROTO_FRAGMENT, "Fragment"],
  [60, "Destination Options"],
]);
/** Same cap as the Rust dissector: past it the chain is not walked and no L4 is claimed. */
const MAX_IPV6_EXT_HEADERS = 8;

/** One row of the tree. `offset`/`len` address the captured frame, which is what drives hex selection. */
export interface DissectNode {
  label: string;
  value: string;
  offset: number;
  /** Clamped to what was captured, so a selection can never point past the bytes on screen. */
  len: number;
  children?: DissectNode[];
}

// ---------------------------------------------------------------- byte reads

function be16(bytes: Uint8Array, offset: number): number | undefined {
  const hi = bytes[offset];
  const lo = bytes[offset + 1];
  return hi === undefined || lo === undefined ? undefined : (hi << 8) | lo;
}

function be32(bytes: Uint8Array, offset: number): number | undefined {
  const hi = be16(bytes, offset);
  const lo = be16(bytes, offset + 2);
  return hi === undefined || lo === undefined ? undefined : hi * 0x10000 + lo;
}

function has(bytes: Uint8Array, offset: number, len: number): boolean {
  return offset >= 0 && offset + len <= bytes.length;
}

/** `0x…`, as wide as the field it shows — a one-byte field read as four digits is a different number. */
function hex(value: number, width: number): string {
  return `0x${value.toString(16).padStart(width * 2, "0")}`;
}

function mac(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + 6), (b) => b.toString(16).padStart(2, "0")).join(":");
}

function ipv4(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + 4), (b) => String(b)).join(".");
}

/**
 * Rust's `Ipv6Addr` Display writes the IPv4-mapped and IPv4-compatible forms as a dotted quad, and keeps
 * `::` and `::1` as themselves. Match it, or the tree and the Source column spell one address two ways.
 */
function embeddedIpv4(groups: readonly number[]): string | null {
  if (!groups.slice(0, 5).every((g) => g === 0)) return null;
  const tail = groups[6] ?? 0;
  const last = groups[7] ?? 0;
  const quad = `${tail >> 8}.${tail & 0xff}.${last >> 8}.${last & 0xff}`;
  if (groups[5] === 0xffff) return `::ffff:${quad}`;
  if (groups[5] === 0 && !(tail === 0 && last <= 1)) return `::${quad}`;
  return null;
}

/** The longest run of zero groups; the first wins a tie. */
function longestZeroRun(groups: readonly number[]): { start: number; len: number } {
  let best = { start: -1, len: 0 };
  let runStart = -1;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart > best.len) best = { start: runStart, len: i - runStart };
    runStart = -1;
  }
  return best;
}

/**
 * RFC 5952 text, which is what Rust's `Ipv6Addr` Display writes into the `src_ip` column — the two have to
 * agree or the same address reads two ways. Longest run of two or more zero groups collapses, first wins.
 */
function ipv6(bytes: Uint8Array, offset: number): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push(be16(bytes, offset + i * 2) ?? 0);

  const embedded = embeddedIpv4(groups);
  if (embedded !== null) return embedded;

  const run = longestZeroRun(groups);
  const hextets = (part: readonly number[]) => part.map((g) => g.toString(16)).join(":");
  if (run.len < 2) return hextets(groups);
  return `${hextets(groups.slice(0, run.start))}::${hextets(groups.slice(run.start + run.len))}`;
}

// ---------------------------------------------------------------- node build

/** A leaf. `len` is clamped so a declared length longer than the capture cannot select bytes we lack. */
function field(bytes: Uint8Array, label: string, value: string, offset: number, len: number): DissectNode {
  return { label, value, offset, len: Math.max(0, Math.min(len, bytes.length - offset)) };
}

/**
 * A layer whose fixed header did not fit in what was captured. Truncated, never a partial parse.
 *
 * `offset` is clamped to the end of the capture: a DECLARED header length (IPv4's IHL, an IPv6 extension
 * header's) can point past the bytes on hand, and a node there would address a byte that does not exist.
 */
function cutShort(bytes: Uint8Array, label: string, offset: number, needed: number): DissectNode {
  const at = Math.min(offset, bytes.length);
  const have = bytes.length - at;
  return { label, value: `truncated: ${have} of ${needed} header bytes captured`, offset: at, len: have };
}

/** Whatever the recognized headers did not claim. */
function payload(bytes: Uint8Array, offset: number): DissectNode[] {
  const len = bytes.length - offset;
  return len > 0 ? [field(bytes, "Payload", `${len} bytes`, offset, len)] : [];
}

// ------------------------------------------------------------------- layer 4

function dissectTcp(bytes: Uint8Array, offset: number, out: DissectNode[]): void {
  if (!has(bytes, offset, 20)) {
    out.push(cutShort(bytes, "TCP", offset, 20));
    return;
  }
  const srcPort = be16(bytes, offset) ?? 0;
  const dstPort = be16(bytes, offset + 2) ?? 0;
  const dataOffset = ((bytes[offset + 12] ?? 0) >> 4) * 4;
  const flags = bytes[offset + 13] ?? 0;
  const names = ["FIN", "SYN", "RST", "PSH", "ACK", "URG", "ECE", "CWR"];
  const set = names.filter((_, bit) => (flags & (1 << bit)) !== 0);

  out.push({
    label: "TCP",
    value: `${srcPort} → ${dstPort}${set.length > 0 ? ` [${set.join(", ")}]` : ""}`,
    offset,
    len: Math.min(Math.max(dataOffset, 20), bytes.length - offset),
    children: [
      field(bytes, "Source Port", String(srcPort), offset, 2),
      field(bytes, "Destination Port", String(dstPort), offset + 2, 2),
      field(bytes, "Sequence Number", String(be32(bytes, offset + 4) ?? 0), offset + 4, 4),
      field(bytes, "Acknowledgment Number", String(be32(bytes, offset + 8) ?? 0), offset + 8, 4),
      field(bytes, "Header Length", `${dataOffset} bytes`, offset + 12, 1),
      field(bytes, "Flags", set.length > 0 ? set.join(", ") : "none", offset + 13, 1),
      field(bytes, "Window", String(be16(bytes, offset + 14) ?? 0), offset + 14, 2),
      field(bytes, "Checksum", hex(be16(bytes, offset + 16) ?? 0, 2), offset + 16, 2),
      field(bytes, "Urgent Pointer", String(be16(bytes, offset + 18) ?? 0), offset + 18, 2),
    ],
  });
  out.push(...payload(bytes, offset + Math.max(dataOffset, 20)));
}

function dissectUdp(bytes: Uint8Array, offset: number, out: DissectNode[]): void {
  if (!has(bytes, offset, 8)) {
    out.push(cutShort(bytes, "UDP", offset, 8));
    return;
  }
  const srcPort = be16(bytes, offset) ?? 0;
  const dstPort = be16(bytes, offset + 2) ?? 0;
  out.push({
    label: "UDP",
    value: `${srcPort} → ${dstPort}`,
    offset,
    len: 8,
    children: [
      field(bytes, "Source Port", String(srcPort), offset, 2),
      field(bytes, "Destination Port", String(dstPort), offset + 2, 2),
      field(bytes, "Length", String(be16(bytes, offset + 4) ?? 0), offset + 4, 2),
      field(bytes, "Checksum", hex(be16(bytes, offset + 6) ?? 0, 2), offset + 6, 2),
    ],
  });
  out.push(...payload(bytes, offset + 8));
}

function dissectIcmp(bytes: Uint8Array, offset: number, v6: boolean, out: DissectNode[]): void {
  const label = v6 ? "ICMPv6" : "ICMP";
  if (!has(bytes, offset, 4)) {
    out.push(cutShort(bytes, label, offset, 4));
    return;
  }
  const type = bytes[offset] ?? 0;
  const code = bytes[offset + 1] ?? 0;
  out.push({
    label,
    value: `type ${type} code ${code}`,
    offset,
    len: 4,
    children: [
      field(bytes, "Type", String(type), offset, 1),
      field(bytes, "Code", String(code), offset + 1, 1),
      field(bytes, "Checksum", hex(be16(bytes, offset + 2) ?? 0, 2), offset + 2, 2),
    ],
  });
  out.push(...payload(bytes, offset + 4));
}

function dissectL4(bytes: Uint8Array, offset: number, proto: number, out: DissectNode[]): void {
  if (proto === IPPROTO_TCP) dissectTcp(bytes, offset, out);
  else if (proto === IPPROTO_UDP) dissectUdp(bytes, offset, out);
  else if (proto === IPPROTO_ICMP) dissectIcmp(bytes, offset, false, out);
  else if (proto === IPPROTO_ICMPV6) dissectIcmp(bytes, offset, true, out);
  else out.push(...payload(bytes, offset));
}

// ------------------------------------------------------------------- layer 3

function dissectIpv4(bytes: Uint8Array, offset: number, out: DissectNode[]): void {
  if (!has(bytes, offset, 20)) {
    out.push(cutShort(bytes, "IPv4", offset, 20));
    return;
  }
  const headerLen = ((bytes[offset] ?? 0) & 0x0f) * 4;
  const proto = bytes[offset + 9] ?? 0;
  const src = ipv4(bytes, offset + 12);
  const dst = ipv4(bytes, offset + 16);
  const flagsAndFrag = be16(bytes, offset + 6) ?? 0;
  // Bytes, not the wire's 8-byte units — the same convention the `frag_offset` column uses.
  const fragOffset = (flagsAndFrag & 0x1fff) * 8;

  out.push({
    label: "IPv4",
    value: `${src} → ${dst}`,
    offset,
    len: Math.min(Math.max(headerLen, 20), bytes.length - offset),
    children: [
      field(bytes, "Version / Header Length", `4 / ${headerLen} bytes`, offset, 1),
      field(bytes, "DSCP / ECN", hex(bytes[offset + 1] ?? 0, 1), offset + 1, 1),
      field(bytes, "Total Length", String(be16(bytes, offset + 2) ?? 0), offset + 2, 2),
      field(bytes, "Identification", hex(be16(bytes, offset + 4) ?? 0, 2), offset + 4, 2),
      field(bytes, "Flags / Fragment Offset", `${hex(flagsAndFrag, 2)} (${fragOffset} bytes)`, offset + 6, 2),
      field(bytes, "Time to Live", String(bytes[offset + 8] ?? 0), offset + 8, 1),
      field(bytes, "Protocol", String(proto), offset + 9, 1),
      field(bytes, "Checksum", hex(be16(bytes, offset + 10) ?? 0, 2), offset + 10, 2),
      field(bytes, "Source Address", src, offset + 12, 4),
      field(bytes, "Destination Address", dst, offset + 16, 4),
    ],
  });

  // Only the first fragment carries the L4 header; a later one is payload, exactly as the columns say.
  const next = offset + Math.max(headerLen, 20);
  if (fragOffset === 0) dissectL4(bytes, next, proto, out);
  else out.push(...payload(bytes, next));
}

function dissectIpv6(bytes: Uint8Array, offset: number, out: DissectNode[]): void {
  if (!has(bytes, offset, 40)) {
    out.push(cutShort(bytes, "IPv6", offset, 40));
    return;
  }
  const src = ipv6(bytes, offset + 8);
  const dst = ipv6(bytes, offset + 24);
  const next = bytes[offset + 6] ?? 0;

  out.push({
    label: "IPv6",
    value: `${src} → ${dst}`,
    offset,
    len: 40,
    children: [
      field(bytes, "Version / Traffic Class / Flow Label", hex(be32(bytes, offset) ?? 0, 4), offset, 4),
      field(bytes, "Payload Length", String(be16(bytes, offset + 4) ?? 0), offset + 4, 2),
      field(bytes, "Next Header", String(next), offset + 6, 1),
      field(bytes, "Hop Limit", String(bytes[offset + 7] ?? 0), offset + 7, 1),
      field(bytes, "Source Address", src, offset + 8, 16),
      field(bytes, "Destination Address", dst, offset + 24, 16),
    ],
  });

  const l4 = walkIpv6Extensions(bytes, offset + 40, next, out);
  if (l4) dissectL4(bytes, l4.offset, l4.proto, out);
}

/**
 * The extension-header chain from `offset`, one node per header. Returns where the L4 header starts and its
 * protocol, or null when the chain ends the dissection: a header cut short, or a later fragment.
 */
function walkIpv6Extensions(
  bytes: Uint8Array,
  offset: number,
  firstHeader: number,
  out: DissectNode[],
): { offset: number; proto: number } | null {
  let at = offset;
  let next = firstHeader;
  for (let depth = 0; depth < MAX_IPV6_EXT_HEADERS && IPV6_EXT_HEADERS.has(next); depth++) {
    const label = IPV6_EXT_HEADERS.get(next) ?? "Extension";
    if (!has(bytes, at, 8)) {
      out.push(cutShort(bytes, `IPv6 ${label}`, at, 8));
      return null;
    }
    const isFragment = next === IPPROTO_FRAGMENT;
    const len = isFragment ? 8 : ((bytes[at + 1] ?? 0) + 1) * 8;
    // Offset in 8-byte units. Only the first fragment carries the L4 header, exactly as the columns say.
    const laterFragment = isFragment && (be16(bytes, at + 2) ?? 0) >> 3 !== 0;
    next = bytes[at] ?? 0;
    out.push(field(bytes, `IPv6 ${label}`, `${len} bytes, next header ${next}`, at, len));
    at += len;
    if (laterFragment) {
      out.push(...payload(bytes, at));
      return null;
    }
  }
  return { offset: at, proto: next };
}

function dissectArp(bytes: Uint8Array, offset: number, out: DissectNode[]): void {
  if (!has(bytes, offset, 28)) {
    out.push(cutShort(bytes, "ARP", offset, 28));
    return;
  }
  const operation = be16(bytes, offset + 6) ?? 0;
  const senderIp = ipv4(bytes, offset + 14);
  const targetIp = ipv4(bytes, offset + 24);
  out.push({
    label: "ARP",
    value: operation === 1 ? `who has ${targetIp}? tell ${senderIp}` : `${senderIp} is at ${mac(bytes, offset + 8)}`,
    offset,
    len: 28,
    children: [
      field(bytes, "Hardware Type", String(be16(bytes, offset) ?? 0), offset, 2),
      field(bytes, "Protocol Type", hex(be16(bytes, offset + 2) ?? 0, 2), offset + 2, 2),
      field(bytes, "Hardware Size", String(bytes[offset + 4] ?? 0), offset + 4, 1),
      field(bytes, "Protocol Size", String(bytes[offset + 5] ?? 0), offset + 5, 1),
      field(bytes, "Operation", String(operation), offset + 6, 2),
      field(bytes, "Sender MAC", mac(bytes, offset + 8), offset + 8, 6),
      field(bytes, "Sender Address", senderIp, offset + 14, 4),
      field(bytes, "Target MAC", mac(bytes, offset + 18), offset + 18, 6),
      field(bytes, "Target Address", targetIp, offset + 24, 4),
    ],
  });
  out.push(...payload(bytes, offset + 28));
}

function dissectL3(bytes: Uint8Array, offset: number, ethertype: number, out: DissectNode[]): void {
  if (ethertype === ETHERTYPE_IPV4) dissectIpv4(bytes, offset, out);
  else if (ethertype === ETHERTYPE_IPV6) dissectIpv6(bytes, offset, out);
  else if (ethertype === ETHERTYPE_ARP) dissectArp(bytes, offset, out);
  else out.push(...payload(bytes, offset));
}

/** Bare IP, link type or ethertype unknown: the version nibble picks the dissector. */
function dissectIpAuto(bytes: Uint8Array, offset: number, out: DissectNode[]): void {
  const version = (bytes[offset] ?? 0) >> 4;
  if (version === 6) dissectIpv6(bytes, offset, out);
  else dissectIpv4(bytes, offset, out);
}

// ------------------------------------------------------------------- layer 2

/** Walk an 802.1Q/802.1ad tag stack, emitting one node per tag. Returns where the payload starts. */
function stripVlanTags(
  bytes: Uint8Array,
  offset: number,
  ethertype: number,
  out: DissectNode[],
): { offset: number; ethertype: number } {
  let at = offset;
  let type = ethertype;
  for (let depth = 0; depth < MAX_VLAN_TAGS && VLAN_TPIDS.has(type); depth++) {
    if (!has(bytes, at, 4)) {
      out.push(cutShort(bytes, "802.1Q", at, 4));
      return { offset: bytes.length, ethertype: 0 };
    }
    const tci = be16(bytes, at) ?? 0;
    const inner = be16(bytes, at + 2) ?? 0;
    out.push({
      label: "802.1Q",
      value: `VLAN ${tci & 0x0fff}`,
      offset: at,
      len: 4,
      children: [
        field(bytes, "Priority", String(tci >> 13), at, 1),
        field(bytes, "VLAN ID", String(tci & 0x0fff), at, 2),
        field(bytes, "Type", hex(inner, 2), at + 2, 2),
      ],
    });
    type = inner;
    at += 4;
  }
  return { offset: at, ethertype: type };
}

function dissectEthernet(bytes: Uint8Array, out: DissectNode[]): void {
  if (!has(bytes, 0, 14)) {
    out.push(cutShort(bytes, "Ethernet", 0, 14));
    return;
  }
  const dst = mac(bytes, 0);
  const src = mac(bytes, 6);
  const ethertype = be16(bytes, 12) ?? 0;
  out.push({
    label: "Ethernet",
    value: `${src} → ${dst}`,
    offset: 0,
    len: 14,
    children: [
      field(bytes, "Destination", dst, 0, 6),
      field(bytes, "Source", src, 6, 6),
      field(bytes, "Type", hex(ethertype, 2), 12, 2),
    ],
  });

  const tagged = stripVlanTags(bytes, 14, ethertype, out);
  if (tagged.offset < bytes.length) dissectL3(bytes, tagged.offset, tagged.ethertype, out);
}

/** Linux cooked capture. v1 is a 16-byte header ending in the ethertype; v2 leads with it and is 20. */
function dissectSll(bytes: Uint8Array, out: DissectNode[], v2: boolean): void {
  const headerLen = v2 ? 20 : 16;
  const label = v2 ? "Linux cooked v2" : "Linux cooked v1";
  if (!has(bytes, 0, headerLen)) {
    out.push(cutShort(bytes, label, 0, headerLen));
    return;
  }
  const typeOffset = v2 ? 0 : 14;
  const ethertype = be16(bytes, typeOffset) ?? 0;
  const addressOffset = v2 ? 12 : 6;
  out.push({
    label,
    value: mac(bytes, addressOffset),
    offset: 0,
    len: headerLen,
    children: [
      field(bytes, "Address", mac(bytes, addressOffset), addressOffset, 6),
      field(bytes, "Type", hex(ethertype, 2), typeOffset, 2),
    ],
  });

  const tagged = stripVlanTags(bytes, headerLen, ethertype, out);
  if (tagged.offset < bytes.length) dissectL3(bytes, tagged.offset, tagged.ethertype, out);
}

/** BSD/OpenBSD loopback: a 4-byte address-family prefix, then bare IP. */
function dissectLoopback(bytes: Uint8Array, out: DissectNode[]): void {
  if (!has(bytes, 0, 4)) {
    out.push(cutShort(bytes, "Loopback", 0, 4));
    return;
  }
  out.push(field(bytes, "Loopback", "address family prefix", 0, 4));
  dissectIpAuto(bytes, 4, out);
}

/**
 * The captured frame as layer nodes, outermost first. `linkType` is the packet's own `link_type` column
 * (a libpcap DLT number), never assumed: a cooked capture read as Ethernet decodes to nonsense.
 */
export function dissectFrame(bytes: Uint8Array, linkType: number | null): DissectNode[] {
  const out: DissectNode[] = [];
  if (bytes.length === 0) return out;

  switch (linkType) {
    case DLT_EN10MB:
      dissectEthernet(bytes, out);
      break;
    case DLT_LINUX_SLL:
      dissectSll(bytes, out, false);
      break;
    case DLT_LINUX_SLL2:
      dissectSll(bytes, out, true);
      break;
    case DLT_NULL:
    case DLT_LOOP:
      dissectLoopback(bytes, out);
      break;
    case DLT_RAW:
      dissectIpAuto(bytes, 0, out);
      break;
    case DLT_IPV4:
      dissectIpv4(bytes, 0, out);
      break;
    case DLT_IPV6:
      dissectIpv6(bytes, 0, out);
      break;
    default:
      out.push({
        label: linkType === null ? "Unknown link type" : `Link type ${linkType}`,
        value: "not dissected here. The packet's columns carry the decoded fields",
        offset: 0,
        len: bytes.length,
      });
  }
  return out;
}

/** The deepest node whose bytes contain `offset` — what clicking a byte in the hex view selects. */
export function findNodeAtOffset(nodes: readonly DissectNode[], offset: number): DissectNode | null {
  for (const node of nodes) {
    if (offset < node.offset || offset >= node.offset + node.len) continue;
    return findNodeAtOffset(node.children ?? [], offset) ?? node;
  }
  return null;
}
