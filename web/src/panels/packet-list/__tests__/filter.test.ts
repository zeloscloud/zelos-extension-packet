import { describe, expect, it } from "vitest";
import type { PacketField, PacketRow } from "../data";
import { parsePacketFilter } from "../filter";

/** What a default panel projects: no VLAN column, so no `vlan.id` to filter on. */
const PROJECTED = new Set<PacketField>(["src_ip", "src_port", "dst_ip", "dst_port", "proto", "orig_len", "info"]);

function row(overrides: Partial<PacketRow>): PacketRow {
  return {
    id: "1",
    timeS: 0,
    timeMode: "absolute",
    iface: "eth0",
    srcIp: "10.0.0.5",
    dstIp: "93.184.216.34",
    srcPort: 51514,
    dstPort: 443,
    proto: "TCP",
    ipProto: 6,
    origLen: 71,
    capLen: 71,
    truncated: false,
    vlanId: null,
    fragOffset: null,
    info: "51514 → 443 [PSH, ACK]",
    producer: null,
    tracePath: null,
    streamKey: "s",
    frameNo: 1,
    source: "Packet",
    message: "capture/packets",
    ...overrides,
  };
}

/** Parse and apply, or fail the test — the happy path in one call. */
function matches(expression: string, packet: PacketRow): boolean {
  const parsed = parsePacketFilter(expression, PROJECTED);
  if (!parsed.ok) throw new Error(`${expression}: ${parsed.message}`);
  return parsed.predicate?.(packet) ?? true;
}

describe("parsePacketFilter", () => {
  it("applies field tests joined by && || not and parens", () => {
    const tcp = row({});
    const dns = row({
      proto: "UDP",
      ipProto: 17,
      srcPort: 53,
      dstPort: 51000,
      srcIp: "8.8.8.8",
      info: "response zeloscloud",
    });

    expect(matches("tcp.port == 443", tcp)).toBe(true);
    expect(matches("tcp.port == 443", dns)).toBe(false);
    // `tcp.port` implies TCP, so a UDP packet on the same port does not match it.
    expect(matches("udp.port == 53", dns)).toBe(true);
    expect(matches("tcp.port == 53", dns)).toBe(false);

    // Addresses are string equality against what the row already renders — no parsing, either side.
    expect(matches("ip.addr == 93.184.216.34", tcp)).toBe(true);
    expect(matches("ip.src == 93.184.216.34", tcp)).toBe(false);
    expect(matches("frame.len > 70 && !(udp)", tcp)).toBe(true);
    expect(matches("arp || udp", dns)).toBe(true);
    expect(matches("not tcp", dns)).toBe(true);
    // Wireshark's spellings, so a filter typed from memory works: `and` / `or` read as `&&` / `||`.
    expect(matches("udp and ip.src == 8.8.8.8 or arp", dns)).toBe(true);
    expect(matches("tcp AND udp", dns)).toBe(false);
    expect(matches("info contains ZELOS", dns)).toBe(true);
    expect(matches("info contains zelos", tcp)).toBe(false);

    // `proto` is a display label; L4 keys on `ip_proto`, so an application-layer label stays TCP.
    const v2gtp = row({ proto: "V2GTP", ipProto: 6, dstPort: 15118 });
    expect(matches("tcp", v2gtp)).toBe(true);
    expect(matches("tcp.port == 15118", v2gtp)).toBe(true);
    expect(matches("udp", v2gtp)).toBe(false);

    // A field the packet does not carry fails every comparison, `!=` included: an ARP frame renders no
    // address, so it is not "an address other than this one".
    expect(matches("ip.addr != 10.0.0.5", row({ proto: "ARP", ipProto: null, srcIp: "", dstIp: "" }))).toBe(false);
    expect(matches("ip.addr != 10.0.0.5", tcp)).toBe(false);
    expect(matches("ip.addr != 10.0.0.5", row({ srcIp: "10.0.0.9" }))).toBe(true);

    // An empty expression is not an error and filters nothing.
    expect(parsePacketFilter("   ", PROJECTED)).toEqual({ ok: true, predicate: null });
  });

  it("refuses an expression it cannot mean, naming the offending token's span", () => {
    // The declared kind exists for exactly this message: it is a shape check, not value semantics.
    const shape = parsePacketFilter("ip.addr == 8080", PROJECTED);
    expect(shape).toMatchObject({ ok: false, start: 11, end: 15 });
    expect(shape.ok === false && shape.message).toContain("ip.addr compares as text");

    // A bare `port` is not a field, and saying only "unknown" would not tell you what is.
    const unknown = parsePacketFilter("port == 123", PROJECTED);
    expect(unknown).toMatchObject({ ok: false, start: 0, end: 4 });
    expect(unknown.ok === false && unknown.message).toContain("tcp.port or udp.port");

    // A field the panel is not projecting would match nothing rather than fail, so it fails here instead.
    const hidden = parsePacketFilter("vlan.id == 100", PROJECTED);
    expect(hidden.ok === false && hidden.message).toContain("Show VLAN");
    expect(parsePacketFilter("vlan.id == 100", new Set([...PROJECTED, "vlan_id"])).ok).toBe(true);

    // `toString` is a word like any other; it must read as an unknown field, not as `Object.prototype`.
    for (const bad of ["tcp ==", "frame.len == abc", "(tcp", "info == dns", "tcp == 1", "toString == 1"]) {
      expect(parsePacketFilter(bad, PROJECTED).ok, bad).toBe(false);
    }
  });
});
