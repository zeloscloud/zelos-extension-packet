import { render, screen } from "@testing-library/react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { buildPacketColumnDefs } from "../columns";
import type { PacketRow } from "../data";
import { type ResolvedPacketOptions, resolvePacketPanelOptions, visiblePacketFields } from "../options";

function row(over: Partial<PacketRow> = {}): PacketRow {
  return {
    id: "1",
    timeS: 1_700_000_000,
    timeMode: "absolute",
    iface: "eth0",
    srcIp: "10.0.0.1",
    dstIp: "10.0.0.2",
    srcPort: 51514,
    dstPort: 443,
    proto: "TCP",
    ipProto: 6,
    origLen: 74,
    capLen: 74,
    truncated: false,
    vlanId: null,
    fragOffset: null,
    info: "51514 → 443 [SYN] Seq=0 Win=64240 Len=0",
    producer: null,
    tracePath: null,
    streamKey: "stream",
    frameNo: 1,
    source: "pkt",
    message: "pkt",
    ...over,
  };
}

const DEFAULTS: ResolvedPacketOptions = resolvePacketPanelOptions(null);

function columns(options: Partial<ResolvedPacketOptions> = {}, forceInterface = false): ColDef<PacketRow>[] {
  return buildPacketColumnDefs({
    timeMode: "absolute",
    fields: visiblePacketFields({ ...DEFAULTS, ...options }, forceInterface),
  });
}

const value = (colId: string, data: PacketRow): unknown => {
  const def = columns().find((c) => c.colId === colId);
  return (def?.valueGetter as (p: never) => unknown)({ data } as never);
};

describe("packet columns", () => {
  // `hide` and the query's projection read the SAME field set, so a column can't be shown without its
  // data. This is the ColDef half; `panel.test` asserts the projection half.
  it("reads as a packet list, hiding the opt-in columns until a toggle or a second capture asks", () => {
    const hidden = (options?: Partial<ResolvedPacketOptions>, forceInterface = false) =>
      Object.fromEntries(columns(options, forceInterface).map((c) => [c.colId, c.hide]));

    expect(hidden()).toEqual({
      no: undefined,
      time: undefined,
      iface: true,
      source: undefined,
      destination: undefined,
      proto: undefined,
      length: undefined,
      vlan_id: true,
      frag_offset: true,
      info: undefined,
    });
    expect(hidden({ showInterface: true, showVlan: true, showFragOffset: true })).toMatchObject({
      iface: false,
      vlan_id: false,
      frag_offset: false,
    });
    // A panel binding two captures needs Interface even with the toggle off.
    expect(hidden({}, true).iface).toBe(false);
  });

  it("joins address and port, and leaves an absent number blank rather than saying null", () => {
    expect(value("source", row())).toBe("10.0.0.1:51514");
    // ARP/ICMP carry no ports — a bare address, never `10.0.0.1:null` and never port 0.
    expect(value("source", row({ srcPort: null }))).toBe("10.0.0.1");
    expect(value("destination", row({ dstIp: "", dstPort: null }))).toBe("");
    expect(value("length", row())).toBe("74");
    expect(value("frag_offset", row({ fragOffset: 0 }))).toBe("0");
    expect(value("vlan_id", row())).toBe("");
  });

  it("colors the protocol chip by family, keyed case-insensitively, spelled as the decoder spelled it", () => {
    const Chip = columns().find((c) => c.colId === "proto")?.cellRenderer as (
      props: ICellRendererParams<PacketRow>,
    ) => ReactElement;
    const chip = (proto: string) => {
      render(<Chip {...({ data: row({ proto }) } as ICellRendererParams<PacketRow>)} />);
      return screen.getByText(proto);
    };

    expect(chip("TCP").style.color).toBe("#3b82f6");
    expect(chip("ICMPv6").style.color).toBe("#f59e0b");
    expect(chip("V2GTP").style.color).toBe("#6366f1");
    expect(chip("Ethernet").style.color).toBe("#9ca3af");
  });
});
