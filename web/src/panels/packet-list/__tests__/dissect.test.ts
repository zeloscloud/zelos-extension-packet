import { describe, expect, it } from "vitest";
import { type DissectNode, dissectFrame, findNodeAtOffset } from "../dissect";

/** DLT_EN10MB. Every frame here is Ethernet, which is what the captures produce. */
const ETHERNET = 1;

const be = (value: number) => [value >> 8, value & 0xff];
const ip4 = (text: string) => text.split(".").map(Number);

// dst 02:00:00:00:00:02, src 02:00:00:00:00:01.
const ETH_HEADER = [0x02, 0, 0, 0, 0, 2, 0x02, 0, 0, 0, 0, 1];
const IPV4_TCP_HEADER = [
  0x45,
  0x00,
  ...be(40),
  ...be(0x1234),
  0x40,
  0x00,
  64,
  6,
  0,
  0,
  ...ip4("10.0.0.5"),
  ...ip4("93.184.216.34"),
];
const TCP_HEADER = [
  ...be(51514),
  ...be(443),
  0x11,
  0x22,
  0x33,
  0x44,
  0x55,
  0x66,
  0x77,
  0x88,
  0x50,
  0x18,
  ...be(0x2000),
  0,
  0,
  0,
  0,
];

const frame = (...parts: number[][]) => new Uint8Array(parts.flat());

function child(nodes: readonly DissectNode[], layer: string, label: string): DissectNode | undefined {
  return nodes.find((node) => node.label === layer)?.children?.find((node) => node.label === label);
}

describe("dissectFrame", () => {
  it("renders Ethernet/IPv4/TCP as layers whose offsets address the frame", () => {
    const nodes = dissectFrame(frame(ETH_HEADER, be(0x0800), IPV4_TCP_HEADER, TCP_HEADER), ETHERNET);

    expect(nodes.map((node) => node.label)).toEqual(["Ethernet", "IPv4", "TCP"]);
    expect(child(nodes, "IPv4", "Source Address")).toMatchObject({ value: "10.0.0.5", offset: 26, len: 4 });
    expect(child(nodes, "IPv4", "Destination Address")).toMatchObject({ value: "93.184.216.34", offset: 30 });
    expect(child(nodes, "TCP", "Source Port")).toMatchObject({ value: "51514", offset: 34, len: 2 });
    expect(child(nodes, "TCP", "Destination Port")).toMatchObject({ value: "443", offset: 36 });
    expect(child(nodes, "TCP", "Flags")?.value).toBe("PSH, ACK");

    // Clicking a byte selects the deepest node holding it — the other half of the two-way selection.
    expect(findNodeAtOffset(nodes, 27)?.label).toBe("Source Address");
    expect(findNodeAtOffset(nodes, 2)?.label).toBe("Destination");
  });

  it("renders a layer the snaplen cut short as truncated, never as a partial parse", () => {
    const cut = frame(ETH_HEADER, be(0x0800), IPV4_TCP_HEADER).subarray(0, 20);
    const nodes = dissectFrame(cut, ETHERNET);

    expect(nodes.map((node) => node.label)).toEqual(["Ethernet", "IPv4"]);
    expect(nodes[1]).toMatchObject({ value: "truncated: 6 of 20 header bytes captured", offset: 14, len: 6 });
    expect(nodes[1]?.children).toBeUndefined();

    // A header that DECLARES more than was captured (IHL 15, but 20 bytes on hand) must not put the layer
    // behind it at an offset the frame does not reach — nothing can select a byte that is not there.
    const lying = frame(ETH_HEADER, be(0x0800), [0x4f, ...IPV4_TCP_HEADER.slice(1)]);
    const after = dissectFrame(lying, ETHERNET);
    expect(after.map((node) => node.label)).toEqual(["Ethernet", "IPv4", "TCP"]);
    expect(after[2]).toMatchObject({
      value: "truncated: 0 of 20 header bytes captured",
      offset: lying.length,
      len: 0,
    });
  });

  it("walks an 802.1Q tag, so the layers behind it keep the right offsets", () => {
    const nodes = dissectFrame(
      frame(ETH_HEADER, be(0x8100), be(0x0064), be(0x0800), IPV4_TCP_HEADER, TCP_HEADER),
      ETHERNET,
    );

    expect(nodes.map((node) => node.label)).toEqual(["Ethernet", "802.1Q", "IPv4", "TCP"]);
    expect(child(nodes, "802.1Q", "VLAN ID")?.value).toBe("100");
    expect(child(nodes, "IPv4", "Source Address")).toMatchObject({ value: "10.0.0.5", offset: 30 });
  });

  it("writes IPv6 the way the `src_ip` column does, so the same address never reads two ways", () => {
    const address = [0x20, 0x01, 0x0d, 0xb8, ...Array(10).fill(0), 0, 1];
    const ipv6Header = [0x60, 0, 0, 0, ...be(8), 17, 64, ...address, ...address];
    const udpHeader = [...be(5353), ...be(53), ...be(8), 0, 0];
    const nodes = dissectFrame(frame(ETH_HEADER, be(0x86dd), ipv6Header, udpHeader), ETHERNET);

    expect(nodes.map((node) => node.label)).toEqual(["Ethernet", "IPv6", "UDP"]);
    expect(child(nodes, "IPv6", "Source Address")?.value).toBe("2001:db8::1");
    expect(child(nodes, "UDP", "Source Port")).toMatchObject({ value: "5353", offset: 54 });

    // Rust's `Ipv6Addr` Display writes the mapped form as a dotted quad. Read as plain groups it would
    // say `::ffff:c000:201`, and the tree would disagree with the column it is supposed to be rendering.
    const mapped = [...Array(10).fill(0), 0xff, 0xff, ...ip4("192.0.2.1")];
    const mappedNodes = dissectFrame(
      frame(ETH_HEADER, be(0x86dd), [0x60, 0, 0, 0, ...be(8), 17, 64, ...mapped, ...mapped], udpHeader),
      ETHERNET,
    );
    expect(child(mappedNodes, "IPv6", "Source Address")?.value).toBe("::ffff:192.0.2.1");

    // A later fragment carries no L4 header, and the Rust columns say so (no ports). Reading its payload
    // as UDP would put a port in the tree that the Source column does not have.
    const fragment = [17, 0, ...be(2 << 3), 0, 0, 0, 1];
    const later = dissectFrame(
      frame(ETH_HEADER, be(0x86dd), [0x60, 0, 0, 0, ...be(16), 44, 64, ...address, ...address], fragment, udpHeader),
      ETHERNET,
    );
    expect(later.map((node) => node.label)).toEqual(["Ethernet", "IPv6", "IPv6 Fragment", "Payload"]);
  });
});
