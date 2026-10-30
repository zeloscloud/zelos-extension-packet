import {
  type AppBridgePanelData,
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

const SIGNALS: AppBridgePanelSignal[] = ["frame_no", "orig_len", "info", "vlan_id"].map(
  (signal) => ({
    source: "Packet",
    message: "eth0/packets",
    signal,
    color: "#888",
    path: `Packet/eth0/packets.${signal}`,
  }),
);

const FIELDS: ReadonlySet<PacketField> = packetQueryFields(
  visiblePacketFields(resolvePacketPanelOptions(null), false),
);
const WITH_VLAN: ReadonlySet<PacketField> = packetQueryFields(
  visiblePacketFields(resolvePacketPanelOptions({ showVlan: true }), false),
);

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

function Rows({ frozen, fields }: { frozen: boolean; fields: ReadonlySet<PacketField> }) {
  const { rows } = usePacketData(SIGNALS, 100, fields, frozen);
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

/** Waits for the panel's calls so far, then lets the SDK take the host's answers: it drops frames before them. */
async function settled(expected: string[]) {
  await vi.waitFor(() => expect(methods()).toEqual(expected));
  await act(async () => {});
}

/** A window of packets numbered and timed by `frameNos`, newest first, as the panel subscribes. */
function packetsFrame(frameNos: number[], info: string[]): Omit<AppBridgePanelData, "seq"> {
  return {
    id: "packets",
    dataset: {
      columns: ["", "frame_no", "orig_len", "info"].map(column),
      data: [frameNos, frameNos, frameNos.map(() => 60), info],
      range: null,
      queryDurationS: 0,
    },
    latest: null,
    timeMode: "absolute",
    totalRows: frameNos.length,
    isLoading: false,
    error: null,
  };
}

const ui = (frozen: boolean, fields = FIELDS) => (
  <ZelosBridgeProvider
    showDevelopmentBanner={false}
    connectOptions={{ panel: { signals: SIGNALS } }}
  >
    <Rows frozen={frozen} fields={fields} />
  </ZelosBridgeProvider>
);

describe("usePacketData", () => {
  it("holds the rows while parked, and subscribes again on follow", async () => {
    const { rerender } = render(ui(false));
    await settled(["panel.subscribe"]);

    act(() => bridge?.pushData(packetsFrame([2, 1], ["second", "first"])));
    expect(screen.getByTestId("rows").textContent).toBe("first,second");

    rerender(ui(true));
    await settled(["panel.subscribe", "panel.unsubscribe"]);
    expect(screen.getByTestId("rows").textContent).toBe("first,second");

    rerender(ui(false));
    await settled(["panel.subscribe", "panel.unsubscribe", "panel.subscribe"]);
    expect(screen.getByTestId("rows").textContent).toBe("first,second");
  });

  it("subscribes while frozen until a frame lands, so a panel reloaded off the tail still shows rows", async () => {
    render(ui(true));
    await settled(["panel.subscribe"]);

    // The host's first frame is still loading; holding it would park the panel on an empty window.
    act(() => bridge?.pushData({ ...packetsFrame([], []), dataset: null, isLoading: true }));
    await settled(["panel.subscribe"]);

    act(() => bridge?.pushData(packetsFrame([2, 1], ["second", "first"])));
    expect(screen.getByTestId("rows").textContent).toBe("first,second");
    await settled(["panel.subscribe", "panel.unsubscribe"]);
  });

  it("fetches one frame while frozen when the projection changes, then holds it", async () => {
    const { rerender } = render(ui(false));
    await settled(["panel.subscribe"]);
    act(() => bridge?.pushData(packetsFrame([2, 1], ["second", "first"])));
    rerender(ui(true));
    await settled(["panel.subscribe", "panel.unsubscribe"]);

    rerender(ui(true, WITH_VLAN));
    await settled(["panel.subscribe", "panel.unsubscribe", "panel.subscribe"]);
    const widened = calls.filter((call) => call.method === "panel.subscribe").at(-1)
      ?.params as PanelSubscribeParams;
    expect(widened.signals).toContain("Packet/eth0/packets.vlan_id");
    // The old window stays on screen until the new one answers.
    expect(screen.getByTestId("rows").textContent).toBe("first,second");

    act(() => bridge?.pushData(packetsFrame([3, 2, 1], ["third", "second", "first"])));
    expect(screen.getByTestId("rows").textContent).toBe("first,second,third");
    await settled(["panel.subscribe", "panel.unsubscribe", "panel.subscribe", "panel.unsubscribe"]);
  });

  it("asks the host for `bufferSize` rows, which the host fits to the panel's cell budget", async () => {
    render(ui(false));
    await settled(["panel.subscribe"]);
    expect((calls[0]?.params as PanelSubscribeParams).maxRows).toBe(100);
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
    await settled(["panel.subscribe"]);

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
