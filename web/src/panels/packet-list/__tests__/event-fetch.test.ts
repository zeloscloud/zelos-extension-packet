import type { BridgeTransport, ColumnMetadata } from "@zeloscloud/app-extension-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PacketRow } from "../data";
import { fetchPacketEventFields, PacketEventGoneError } from "../event-fetch";
import { streamKeyOf } from "../grid/streams";

/**
 * The re-fetch's whole job is to come back with THE clicked packet or nothing: the packet is picked out of
 * a window around its lossy timestamp by frame number, never by position or nearest neighbor.
 */

const queryApiMocks = vi.hoisted(() => ({
  liveQueryAllMulti: vi.fn(),
  traceQueryAllMulti: vi.fn(),
}));
vi.mock("@zeloscloud/app-extension-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zeloscloud/app-extension-sdk")>()),
  query: queryApiMocks,
}));

/** The calls go through the mocked `query` facade, so the transport is never touched. */
const BRIDGE = {} as BridgeTransport;
const LIVE = true;

const FIELD_COLUMN: ColumnMetadata = {
  source: "pkt",
  message: "pkt",
  signal: "orig_len",
  producer: "agent-a",
  tracePath: null,
  dataSegmentId: null,
  startTimeS: null,
  endTimeS: null,
};
const TIME_COLUMN: ColumnMetadata = { ...FIELD_COLUMN, source: "time_s", message: "", signal: "" };
const FRAME_NO_COLUMN: ColumnMetadata = { ...FIELD_COLUMN, signal: "frame_no" };

function row(over: Partial<PacketRow> = {}): PacketRow {
  return {
    id: "1",
    timeS: 5,
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
    info: "SYN",
    producer: "agent-a",
    tracePath: null,
    streamKey: streamKeyOf(FIELD_COLUMN),
    frameNo: 1,
    source: "pkt",
    message: "pkt",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchPacketEventFields — exactly the clicked packet, by frame number", () => {
  it("picks the row carrying the packet's frame number, whatever else shares its timestamp", async () => {
    queryApiMocks.liveQueryAllMulti.mockResolvedValue({
      columns: [TIME_COLUMN, FIELD_COLUMN, FRAME_NO_COLUMN],
      data: [
        [5, 5],
        [74, 90],
        [1, 2],
      ],
    });

    await expect(
      fetchPacketEventFields(BRIDGE, row({ frameNo: 2 }), ["orig_len"], LIVE),
    ).resolves.toEqual({
      orig_len: 90,
      frame_no: 2,
    });
    // The number is always asked for, even when the caller did not list it.
    const paths = (
      queryApiMocks.liveQueryAllMulti.mock.calls[0]?.[1] as {
        agentSignals: Record<string, string[]>;
      }
    ).agentSignals["agent-a"];
    expect(paths?.some((path) => path.endsWith("frame_no"))).toBe(true);
  });

  it("says the packet is gone when no row carries its frame number, rather than guessing a neighbor", async () => {
    queryApiMocks.liveQueryAllMulti.mockResolvedValue({
      columns: [TIME_COLUMN, FIELD_COLUMN, FRAME_NO_COLUMN],
      data: [[5], [74], [1]],
    });

    await expect(
      fetchPacketEventFields(BRIDGE, row({ frameNo: 9 }), ["orig_len"], LIVE),
    ).rejects.toBeInstanceOf(PacketEventGoneError);
  });
});

describe("fetchPacketEventFields — the window it asks for", () => {
  const TRACE = "/captures/demo.trz";
  const traceColumn = (signal: string): ColumnMetadata => ({
    ...FIELD_COLUMN,
    signal,
    producer: null,
    tracePath: TRACE,
  });
  const tracePacket = (over: Partial<PacketRow>) =>
    row({
      producer: null,
      tracePath: TRACE,
      streamKey: streamKeyOf(traceColumn("orig_len")),
      ...over,
    });

  beforeEach(() => {
    queryApiMocks.traceQueryAllMulti.mockResolvedValue({
      columns: [
        { ...TIME_COLUMN, producer: null, tracePath: TRACE },
        traceColumn("orig_len"),
        traceColumn("frame_no"),
      ],
      data: [[5], [74], [1]],
    });
  });

  it("reads a trace packet through its trace, 2 ms around it in wall-clock time", async () => {
    await fetchPacketEventFields(BRIDGE, tracePacket({ timeS: 20 }), ["orig_len"], false);

    expect(queryApiMocks.liveQueryAllMulti).not.toHaveBeenCalled();
    expect(queryApiMocks.traceQueryAllMulti.mock.calls[0]?.[1]).toMatchObject({
      traceSignals: { [TRACE]: ["*/pkt/pkt.frame_no", "*/pkt/pkt.orig_len"] },
      timeMode: "absolute",
      zoomRelative: null,
      zoomAbsolute: { start: "1970-01-01T00:00:19.999000Z", end: "1970-01-01T00:00:20.001000Z" },
      maxRows: 512,
      sortOrder: "asc",
    });
  });

  // A row melted under `relative` holds elapsed seconds; read as epoch seconds it would point at 1970.
  it("asks for an elapsed window when the row was melted in relative time", async () => {
    await fetchPacketEventFields(
      BRIDGE,
      tracePacket({ timeS: 5, timeMode: "relative" }),
      ["orig_len"],
      false,
    );

    expect(queryApiMocks.traceQueryAllMulti.mock.calls[0]?.[1]).toMatchObject({
      timeMode: "relative",
      zoomRelative: { start: 4.999, end: 5.001 },
      zoomAbsolute: null,
    });
  });

  it("says a packet is gone when it carries no scope to read it through", async () => {
    await expect(
      fetchPacketEventFields(BRIDGE, tracePacket({ tracePath: null }), ["orig_len"], false),
    ).rejects.toBeInstanceOf(PacketEventGoneError);
    await expect(
      fetchPacketEventFields(BRIDGE, row({ producer: null }), ["orig_len"], LIVE),
    ).rejects.toBeInstanceOf(PacketEventGoneError);
    expect(queryApiMocks.traceQueryAllMulti).not.toHaveBeenCalled();
    expect(queryApiMocks.liveQueryAllMulti).not.toHaveBeenCalled();
  });
});

describe("fetchPacketEventFields — a window full to its cap", () => {
  /** A window of `count` packets, none of them the one asked for. */
  const crowded = (count: number) => ({
    columns: [TIME_COLUMN, FIELD_COLUMN, FRAME_NO_COLUMN],
    data: [
      Array(count).fill(5),
      Array(count).fill(74),
      Array.from({ length: count }, (_, i) => 100 + i),
    ],
  });

  it("asks once more with a wider cap, since the packet may sit past the first", async () => {
    queryApiMocks.liveQueryAllMulti.mockResolvedValueOnce(crowded(512)).mockResolvedValueOnce({
      columns: [TIME_COLUMN, FIELD_COLUMN, FRAME_NO_COLUMN],
      data: [[5], [90], [9]],
    });

    await expect(
      fetchPacketEventFields(BRIDGE, row({ frameNo: 9 }), ["orig_len"], LIVE),
    ).resolves.toEqual({
      orig_len: 90,
      frame_no: 9,
    });
    const caps = queryApiMocks.liveQueryAllMulti.mock.calls.map(
      (call) => (call[1] as { maxRows: number }).maxRows,
    );
    expect(caps).toEqual([512, 4_096]);
  });

  it("gives up after the wider cap, and does not widen a window that came back short", async () => {
    queryApiMocks.liveQueryAllMulti
      .mockResolvedValueOnce(crowded(512))
      .mockResolvedValueOnce(crowded(4_096));
    await expect(
      fetchPacketEventFields(BRIDGE, row({ frameNo: 9 }), ["orig_len"], LIVE),
    ).rejects.toBeInstanceOf(PacketEventGoneError);
    expect(queryApiMocks.liveQueryAllMulti).toHaveBeenCalledTimes(2);

    queryApiMocks.liveQueryAllMulti.mockClear();
    queryApiMocks.liveQueryAllMulti.mockResolvedValueOnce(crowded(511));
    await expect(
      fetchPacketEventFields(BRIDGE, row({ frameNo: 9 }), ["orig_len"], LIVE),
    ).rejects.toBeInstanceOf(PacketEventGoneError);
    expect(queryApiMocks.liveQueryAllMulti).toHaveBeenCalledTimes(1);
  });
});
