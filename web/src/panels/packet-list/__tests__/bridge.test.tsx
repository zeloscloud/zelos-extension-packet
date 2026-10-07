import {
  type AppBridgePanelSignal,
  type ColumnMetadata,
  MockBridge,
  type PanelSubscribeParams,
  type QueryCellValue,
  type QueryDataMulti,
} from "@zeloscloud/app-extension-sdk";
import { ZelosBridgeProvider } from "@zeloscloud/app-extension-sdk/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacketListPanel } from "../panel";
import { gridCell } from "./grid-mock";

/*
 * The panel against the SDK's own MockBridge: the real provider, the real hooks, the real subscription
 * and frame acknowledgment. Only the grid is the fake one (happy-dom has no layout for AG Grid), and the
 * host's answers come from a stub invoke handler, which is also where the panel's calls are observed.
 */

vi.mock("ag-grid-react", async () => (await import("./grid-mock")).mockAgGrid());

const TRACE = "/captures/demo.trz";

/** The bound packet fields: what dragging a capture's `packets` node binds, minus the ones nobody reads. */
const FIELDS = [
  "frame_no",
  "src_ip",
  "src_port",
  "dst_ip",
  "dst_port",
  "proto",
  "ip_proto",
  "orig_len",
  "cap_len",
  "truncated",
  "info",
  "frame",
];

const SIGNALS: AppBridgePanelSignal[] = FIELDS.map((signal) => ({
  source: "Packet",
  message: "eth0/packets",
  signal,
  color: "#888",
  eventType: "zelos.packet.v1",
  path: `Packet/eth0/packets.${signal}`,
}));

function column(signal: string): ColumnMetadata {
  return {
    source: signal === "" ? "time_s" : "Packet",
    message: signal === "" ? "" : "eth0/packets",
    signal,
    producer: null,
    tracePath: TRACE,
    dataSegmentId: null,
    startTimeS: null,
    endTimeS: null,
  };
}

type Packet = Record<string, QueryCellValue> & { time_s: number };

const PACKETS: Packet[] = [
  { time_s: 10, frame_no: 1, src_ip: "10.0.0.5", src_port: 51514, dst_ip: "93.184.216.34", dst_port: 443,
    proto: "TCP", ip_proto: 6, orig_len: 74, cap_len: 74, truncated: false, info: "51514 → 443 [SYN]" },
  { time_s: 20, frame_no: 2, src_ip: "10.0.0.5", src_port: 5353, dst_ip: "8.8.8.8", dst_port: 53,
    proto: "UDP", ip_proto: 17, orig_len: 42, cap_len: 42, truncated: false, info: "DNS query" },
  { time_s: 30, frame_no: 3, src_ip: "10.0.0.5", src_port: 51514, dst_ip: "93.184.216.34", dst_port: 443,
    proto: "TCP", ip_proto: 6, orig_len: 66, cap_len: 66, truncated: false, info: "51514 → 443 [ACK]" },
];

/** A column-major window, newest first: the order the panel subscribes in. */
function dataset(packets: readonly Packet[], fields: readonly string[]): QueryDataMulti {
  const newestFirst = [...packets].sort((a, b) => b.time_s - a.time_s);
  return {
    columns: [column(""), ...fields.map(column)],
    data: [newestFirst.map((p) => p.time_s), ...fields.map((field) => newestFirst.map((p) => p[field] ?? null))],
    range: null,
    queryDurationS: 0,
  };
}

const be16 = (value: number) => [value >> 8, value & 0xff];
/** Ethernet / IPv4 / UDP, 10.0.0.5:5353 → 8.8.8.8:53: packet 2's frame. */
const UDP_FRAME = [
  ...[0x02, 0, 0, 0, 0, 2, 0x02, 0, 0, 0, 0, 1],
  ...be16(0x0800),
  ...[0x45, 0, ...be16(28), 0, 0, 0x40, 0, 64, 17, 0, 0, 10, 0, 0, 5, 8, 8, 8, 8],
  ...[...be16(5353), ...be16(53), ...be16(8), 0, 0],
];
const UDP_FRAME_HEX = `0x${UDP_FRAME.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

let bridge: MockBridge | null = null;
const calls: Array<{ method: string; params: unknown }> = [];
let menuChoice: string | null = null;

function hostAnswer(method: string, params: unknown): unknown {
  calls.push({ method, params });
  switch (method) {
    case "panel.subscribe":
      return { id: (params as PanelSubscribeParams).id };
    case "panel.showMenu":
      return { itemId: menuChoice };
    case "query.traceQueryAllMulti":
      // The one-packet re-fetch behind the drawer: packet 2 with its link type and bytes.
      return dataset([{ ...(PACKETS[1] as Packet), link_type: 1, frame: UDP_FRAME_HEX }], [
        "frame_no",
        "link_type",
        "frame",
      ]);
    default:
      return null;
  }
}

const callsTo = (method: string) => calls.filter((call) => call.method === method).map((call) => call.params);

beforeEach(() => {
  calls.length = 0;
  menuChoice = null;
  bridge = null;
  const connect = MockBridge.connect.bind(MockBridge);
  vi.spyOn(MockBridge, "connect").mockImplementation((environment, options) => {
    const created = connect(environment, options);
    created.setInvokeHandler(hostAnswer);
    bridge = created;
    return created;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountPanel() {
  render(
    <ZelosBridgeProvider
      showDevelopmentBanner={false}
      connectOptions={{
        extensionId: "local.packet",
        workspace: { modeKind: "TRACE" },
        panel: { panelId: "packet-list", instanceId: "packet-list-1", signals: SIGNALS },
        time: { mode: "absolute", playback: "PAUSED", cursorS: null },
      }}
    >
      <PacketListPanel />
    </ZelosBridgeProvider>,
  );
  await vi.waitFor(() => expect(callsTo("panel.subscribe")).toHaveLength(1));
  const projected = FIELDS.filter((field) => field !== "frame");
  act(() => {
    bridge?.pushData({
      id: "packets",
      dataset: dataset(PACKETS, projected),
      latest: null,
      timeMode: "absolute",
      totalRows: PACKETS.length,
      isLoading: false,
      error: null,
    });
  });
  await screen.findAllByTestId("row");
}

describe("PacketListPanel over a MockBridge", () => {
  it("subscribes to the newest `bufferSize` packets, projected, and renders the pushed frame as rows", async () => {
    await mountPanel();

    const subscribe = callsTo("panel.subscribe")[0] as PanelSubscribeParams;
    expect(subscribe).toMatchObject({ id: "packets", shape: "rows", maxRows: 10_000, sortOrder: "desc" });
    // Never `frame`: up to a snaplen of bytes per packet, fetched one packet at a time instead.
    expect(subscribe.signals).not.toContain("Packet/eth0/packets.frame");
    expect(subscribe.signals).toContain("Packet/eth0/packets.info");

    // Ascending, whatever order the window arrived in.
    expect(screen.getAllByTestId("row").map((row) => row.getAttribute("row-id")?.split(":").at(-1))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(screen.getByText("8.8.8.8:53")).toBeTruthy();
    expect(bridge?.lastAck("packets")).toBe(1);
  });

  it("narrows the rows with the display filter, and says how many of the buffer match", async () => {
    await mountPanel();

    fireEvent.change(screen.getByTestId("packet-filter-input"), { target: { value: "udp.port == 53" } });

    await vi.waitFor(() => expect(screen.getAllByTestId("row")).toHaveLength(1));
    expect(screen.getByText("DNS query")).toBeTruthy();
    expect(screen.getByTestId("packet-filter-status").textContent).toBe("matching 1 of 3 buffered");
  });

  it("opens the drawer on a row and dissects the frame the host returns for that packet", async () => {
    await mountPanel();

    fireEvent.click(screen.getAllByTestId("row")[1] as HTMLElement);

    const tree = await screen.findByTestId("packet-dissect-tree");
    const layers = [...tree.querySelectorAll('[data-testid="dissect-label"]')].map((label) => label.textContent);
    expect(layers).toEqual(expect.arrayContaining(["Ethernet", "IPv4", "UDP"]));
    expect(screen.getByTestId("frame-hex-view").textContent).toContain("0000  02 00 00 00 00 02");

    // A trace workspace re-fetches through the packet's trace, over a 2 ms window around it.
    const refetch = callsTo("query.traceQueryAllMulti")[0] as {
      traceSignals: Record<string, string[]>;
      zoomAbsolute: { start: string; end: string };
    };
    expect(refetch.traceSignals[TRACE]).toEqual(
      expect.arrayContaining(["*/Packet/eth0/packets.frame", "*/Packet/eth0/packets.frame_no"]),
    );
    expect(refetch.zoomAbsolute).toEqual({ start: "1970-01-01T00:00:19.999000Z", end: "1970-01-01T00:00:20.001000Z" });
  });

  it("moves the host cursor through panel.setCursor when the menu's \"Set cursor here\" is chosen", async () => {
    await mountPanel();
    menuChoice = "set-cursor";

    fireEvent.contextMenu(gridCell("info", 2));

    await vi.waitFor(() => expect(callsTo("panel.setCursor")).toEqual([{ timeS: 30 }]));
    const menu = callsTo("panel.showMenu")[0] as { items: Array<{ id: string }> };
    expect(menu.items.map((item) => item.id)).toContain("set-cursor");
  });
});
