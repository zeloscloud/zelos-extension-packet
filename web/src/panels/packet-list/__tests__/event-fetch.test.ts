import type { BridgeTransport, ColumnMetadata } from "@zeloscloud/app-extension-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PacketRow } from "../data";
import { fetchPacketEventFields, PacketEventGoneError } from "../event-fetch";
import { streamKeyOf } from "../grid/streams";

/**
 * The re-fetch's whole job is to come back with THE clicked packet or nothing: the packet is picked out of
 * a window around its lossy timestamp by frame number, never by position or nearest neighbor.
 */

const queryApiMocks = vi.hoisted(() => ({ liveQueryAllMulti: vi.fn(), traceQueryAllMulti: vi.fn() }));
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

    await expect(fetchPacketEventFields(BRIDGE, row({ frameNo: 2 }), ["orig_len"], LIVE)).resolves.toEqual({
      orig_len: 90,
      frame_no: 2,
    });
    // The number is always asked for, even when the caller did not list it.
    const paths = (queryApiMocks.liveQueryAllMulti.mock.calls[0]?.[1] as { agentSignals: Record<string, string[]> })
      .agentSignals["agent-a"];
    expect(paths?.some((path) => path.endsWith("frame_no"))).toBe(true);
  });

  it("says the packet is gone when no row carries its frame number, rather than guessing a neighbor", async () => {
    queryApiMocks.liveQueryAllMulti.mockResolvedValue({
      columns: [TIME_COLUMN, FIELD_COLUMN, FRAME_NO_COLUMN],
      data: [[5], [74], [1]],
    });

    await expect(fetchPacketEventFields(BRIDGE, row({ frameNo: 9 }), ["orig_len"], LIVE)).rejects.toBeInstanceOf(
      PacketEventGoneError,
    );
  });
});
