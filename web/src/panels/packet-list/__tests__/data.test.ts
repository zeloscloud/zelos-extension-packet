import type { AppBridgePanelSignal as PanelSignal, ColumnMetadata, QueryDataMulti } from "@zeloscloud/app-extension-sdk";
import { describe, expect, it } from "vitest";
import { meltPacketRows, packetsLackFrameNumbers } from "../data";

/**
 * The grouping and scope-dropping rules are `buildFieldStreams`'. What's asserted here is the melt: the row
 * shape, and the (streamKey, frame_no) identity the byte view re-fetches by.
 */

/** A field column of one backend packet table. */
function col(over: Partial<ColumnMetadata> & { signal: string }): ColumnMetadata {
  return {
    source: "pkt",
    message: "pkt",
    producer: null,
    tracePath: null,
    dataSegmentId: null,
    startTimeS: null,
    endTimeS: null,
    ...over,
  };
}

const TIME_COL = col({ source: "time_s", message: "", signal: "" });

/** What an event-level drop stores: ONE entry per field of `zelos.packet.v1`, unscoped. */
const PACKET_FIELDS = [
  "frame_no",
  "iface",
  "src_ip",
  "dst_ip",
  "src_port",
  "dst_port",
  "proto",
  "orig_len",
  "cap_len",
  "truncated",
  "vlan_id",
  "frag_offset",
  "info",
  "frame",
] as const;

const SIGNALS = PACKET_FIELDS.map(
  (signal) => ({ source: "pkt", message: "pkt", signal, color: "" }) as unknown as PanelSignal,
);

function dataset(columns: ColumnMetadata[], data: unknown[][]): QueryDataMulti {
  return { columns, data } as unknown as QueryDataMulti;
}

describe("meltPacketRows", () => {
  it("melts two captures into ONE ascending stream, with iface and producer as ROW attributes", () => {
    const columns = [
      TIME_COL,
      col({ signal: "iface", producer: "agent-a" }),
      col({ signal: "src_ip", producer: "agent-a" }),
      col({ signal: "proto", producer: "agent-a" }),
      col({ signal: "orig_len", producer: "agent-a" }),
      col({ signal: "frame_no", producer: "agent-a" }),
      col({ signal: "iface", producer: "agent-b" }),
      col({ signal: "src_ip", producer: "agent-b" }),
      col({ signal: "proto", producer: "agent-b" }),
      col({ signal: "orig_len", producer: "agent-b" }),
      col({ signal: "frame_no", producer: "agent-b" }),
    ];
    // Sparse union: row 0 is agent-a's, row 1 is agent-b's.
    const rows = meltPacketRows(
      dataset(columns, [
        [1, 2],
        ["eth0", null],
        ["10.0.0.1", null],
        ["TCP", null],
        [74, null],
        [1, null],
        [null, "en0"],
        [null, "10.0.0.2"],
        [null, "UDP"],
        [null, 90],
        [null, 1],
      ]),
      "asc",
      SIGNALS,
      "absolute",
    );

    expect(rows.map((r) => [r.timeS, r.producer, r.iface, r.srcIp, r.proto])).toEqual([
      [1, "agent-a", "eth0", "10.0.0.1", "TCP"],
      [2, "agent-b", "en0", "10.0.0.2", "UDP"],
    ]);
  });

  it("melts a partly-null row, carrying the snaplen fields and the mode it melted under", () => {
    // Every packet field but `orig_len` is nullable — an ARP frame has no ports and no IPs. A row must
    // survive on whatever it carries beyond that anchor. The time mode is stamped so a later switch
    // can't re-interpret `timeS`.
    const columns = [
      TIME_COL,
      col({ signal: "orig_len" }),
      col({ signal: "proto" }),
      col({ signal: "info" }),
      col({ signal: "cap_len" }),
      col({ signal: "truncated" }),
      col({ signal: "frame_no" }),
    ];
    const rows = meltPacketRows(
      dataset(columns, [[1], [1514], ["ARP"], ["Who has 10.0.0.1?"], [128], [true], [1]]),
      "asc",
      SIGNALS,
      "relative",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      proto: "ARP",
      srcIp: "",
      srcPort: null,
      dstPort: null,
      origLen: 1514,
      capLen: 128,
      truncated: true,
      timeMode: "relative",
    });
  });

  // `zelos.packet.stats.v1` declares an `iface` field too, and it groups into a stream of its own — so a
  // panel that also carries stats signals would otherwise mint one phantom packet row per stats sample,
  // holding just an interface name.
  it("ignores a stream that carries no `orig_len` — the packet event's NOT NULL anchor", () => {
    const columns = [
      TIME_COL,
      col({ signal: "orig_len" }),
      col({ signal: "info" }),
      col({ signal: "frame_no" }),
      col({ message: "eth0/stats", signal: "iface" }),
    ];
    const rows = meltPacketRows(
      dataset(columns, [
        [1, 2],
        [74, null],
        ["SYN", null],
        [1, null],
        [null, "eth0"],
      ]),
      "asc",
      [...SIGNALS, { source: "pkt", message: "eth0/stats", signal: "iface", color: "" } as unknown as PanelSignal],
      "absolute",
    );

    expect(rows.map((r) => [r.timeS, r.info])).toEqual([[1, "SYN"]]);
  });

  it("tells a window from an older extension, whose packets carry no frame numbers, apart from an empty one", () => {
    expect(packetsLackFrameNumbers(dataset([TIME_COL, col({ signal: "orig_len" })], [[1], [74]]))).toBe(true);
    expect(
      packetsLackFrameNumbers(
        dataset([TIME_COL, col({ signal: "orig_len" }), col({ signal: "frame_no" })], [[1], [74], [1]]),
      ),
    ).toBe(false);
    expect(packetsLackFrameNumbers(dataset([TIME_COL], [[]]))).toBe(false);
  });

  it("addresses each packet by (streamKey, frame_no), so the byte view can re-fetch exactly it", () => {
    // At line rate, back-to-back retransmits sharing a timestamp AND their bytes are ordinary. The capture
    // numbered them, so they stay distinct without positional bookkeeping; another capture's numbering is
    // its own.
    const columns = [
      TIME_COL,
      col({ signal: "orig_len" }),
      col({ signal: "orig_len", producer: "other" }),
      col({ signal: "frame_no" }),
      col({ signal: "frame_no", producer: "other" }),
      col({ signal: "src_ip" }),
      col({ signal: "src_ip", producer: "other" }),
    ];
    const rows = meltPacketRows(
      dataset(columns, [
        [5, 5, 5],
        [74, 74, null],
        [null, null, 90],
        [7, 8, null],
        [null, null, 7],
        ["10.0.0.1", "10.0.0.1", null],
        [null, null, "10.0.0.9"],
      ]),
      "asc",
      SIGNALS,
      "absolute",
    );

    expect(rows.map((r) => r.frameNo)).toEqual([7, 8, 7]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows[0]?.streamKey).toBe(rows[1]?.streamKey);
    expect(rows[0]?.streamKey).not.toBe(rows[2]?.streamKey);
    expect(rows[0]).toMatchObject({ source: "pkt", message: "pkt" });
  });
});
