import {
  type AppBridgePanelSignal,
  type ColumnMetadata,
  MockBridge,
  type PanelSubscribeParams,
} from "@zeloscloud/app-extension-sdk";
import { ZelosBridgeProvider } from "@zeloscloud/app-extension-sdk/react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PacketField } from "../data";
import { packetQueryFields, resolvePacketPanelOptions, visiblePacketFields } from "../options";
import { usePacketData } from "../use-packet-data";
import { usePacketStats } from "../use-packet-stats";

/*
 * Parking the viewport off the tail drops the subscription, so the rows on screen stop rotating under the
 * reader; following again subscribes afresh. The rows must survive the gap in between.
 */

const SIGNALS: AppBridgePanelSignal[] = ["frame_no", "orig_len", "info"].map((signal) => ({
  source: "Packet",
  message: "eth0/packets",
  signal,
  color: "#888",
  path: `Packet/eth0/packets.${signal}`,
}));

const FIELDS: ReadonlySet<PacketField> = packetQueryFields(visiblePacketFields(resolvePacketPanelOptions(null), false));

function column(signal: string): ColumnMetadata {
  return {
    source: signal === "" ? "time_s" : "Packet",
    message: signal === "" ? "" : "eth0/packets",
    signal,
    producer: "agent-a",
    tracePath: null,
    dataSegmentId: null,
    startTimeS: null,
    endTimeS: null,
  };
}

function Rows({ frozen }: { frozen: boolean }) {
  const { rows } = usePacketData(SIGNALS, 100, FIELDS, frozen);
  return <p data-testid="rows">{rows.map((row) => row.info).join(",")}</p>;
}

let bridge: MockBridge | null = null;
const calls: Array<{ method: string; params: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  const connect = MockBridge.connect.bind(MockBridge);
  vi.spyOn(MockBridge, "connect").mockImplementation((environment, options) => {
    const created = connect(environment, options);
    created.setInvokeHandler((method, params) => {
      calls.push({ method, params });
      return method === "panel.subscribe" ? { id: (params as PanelSubscribeParams).id } : null;
    });
    bridge = created;
    return created;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const methods = () => calls.map((call) => call.method).filter((method) => method !== "panel.ack");

describe("usePacketData", () => {
  it("holds the rows while parked, and subscribes again on follow", async () => {
    const ui = (frozen: boolean) => (
      <ZelosBridgeProvider showDevelopmentBanner={false} connectOptions={{ panel: { signals: SIGNALS } }}>
        <Rows frozen={frozen} />
      </ZelosBridgeProvider>
    );
    const { rerender } = render(ui(false));
    await vi.waitFor(() => expect(methods()).toEqual(["panel.subscribe"]));

    act(() => {
      bridge?.pushData({
        id: "packets",
        dataset: {
          columns: ["", "frame_no", "orig_len", "info"].map(column),
          data: [[2, 1], [2, 1], [60, 60], ["second", "first"]],
          range: null,
          queryDurationS: 0,
        },
        latest: null,
        timeMode: "absolute",
        totalRows: 2,
        isLoading: false,
        error: null,
      });
    });
    expect(screen.getByTestId("rows").textContent).toBe("first,second");

    rerender(ui(true));
    await vi.waitFor(() => expect(methods()).toEqual(["panel.subscribe", "panel.unsubscribe"]));
    expect(screen.getByTestId("rows").textContent).toBe("first,second");

    rerender(ui(false));
    await vi.waitFor(() => expect(methods()).toEqual(["panel.subscribe", "panel.unsubscribe", "panel.subscribe"]));
    expect(screen.getByTestId("rows").textContent).toBe("first,second");
  });

  // The host refuses more than a million cells: 336 interfaces at 10,000 rows each would be 3.36 million.
  it.each([
    [10, 10_000],
    [336, 2_976],
  ])("asks for at most a million cells: %i signals get %i rows", async (count, maxRows) => {
    const signals: AppBridgePanelSignal[] = Array.from({ length: count }, (_, index) => ({
      source: "Packet",
      message: `if${index}/packets`,
      signal: "info",
      color: "#888",
      path: `Packet/if${index}/packets.info`,
    }));
    function Many() {
      usePacketData(signals, 10_000, FIELDS, false);
      return null;
    }
    render(
      <ZelosBridgeProvider showDevelopmentBanner={false} connectOptions={{ panel: { signals } }}>
        <Many />
      </ZelosBridgeProvider>,
    );
    await vi.waitFor(() => expect(methods()).toEqual(["panel.subscribe"]));
    const subscribe = calls.find((call) => call.method === "panel.subscribe")?.params as PanelSubscribeParams;
    expect(subscribe.signals).toHaveLength(count);
    expect(subscribe.maxRows).toBe(maxRows);
  });
});

const STATS_SIGNALS: AppBridgePanelSignal[] = ["packets_captured", "pps", "bps"].map((signal) => ({
  source: "Packet",
  message: "eth0/stats",
  signal,
  color: "#888",
  eventType: "zelos.packet.stats.v1",
  path: `Packet/eth0/stats.${signal}`,
}));

function Strip() {
  return <p data-testid="strip">{usePacketStats(STATS_SIGNALS)}</p>;
}

describe("usePacketStats", () => {
  // Rates describe traffic being watched. At a cursor in a recording they read "0 pps", which means nothing.
  it.each([
    ["LIVE", "Packets 1,500 · Dropped 0 kernel / 0 agent · 120 pps · 1.5 Mbit/s"],
    ["TRACE", "Packets 1,500 · Dropped 0 kernel / 0 agent"],
  ])("in a %s workspace shows %s", async (modeKind, expected) => {
    render(
      <ZelosBridgeProvider
        showDevelopmentBanner={false}
        connectOptions={{ workspace: { modeKind }, panel: { signals: STATS_SIGNALS } }}
      >
        <Strip />
      </ZelosBridgeProvider>,
    );
    await vi.waitFor(() => expect(methods()).toEqual(["panel.subscribe"]));

    act(() => {
      bridge?.pushData({
        id: "stats",
        dataset: null,
        latest: [
          ["packets_captured", "1500"],
          ["pps", "120"],
          ["bps", "1500000"],
        ].map(([signal, value]) => ({
          source: "Packet",
          message: "eth0/stats",
          signal: signal as string,
          producer: null,
          value: value as string,
          tracePath: null,
          timeNs: "100",
          dataSegmentId: null,
        })),
        timeMode: "absolute",
        totalRows: 0,
        isLoading: false,
        error: null,
      });
    });
    expect(screen.getByTestId("strip").textContent).toBe(expected);
  });
});
