import type { AppBridgePanelInfo, AppBridgePanelSignal as PanelSignal } from "@zeloscloud/app-extension-sdk";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PacketField, PacketRow } from "../data";
import { PacketListPanel } from "../panel";
import { gridCell } from "./grid-mock";

vi.mock("ag-grid-react", async () => (await import("./grid-mock")).mockAgGrid());

// The host, as the SDK's React hooks present it. Every action is a spy; the menu resolves with nothing
// chosen unless a test picks an item.
const sdk = vi.hoisted(() => ({
  panel: null as AppBridgePanelInfo | null,
  actions: {
    setCursor: vi.fn(),
    setViewRange: vi.fn(),
    setTitle: vi.fn(),
    copyText: vi.fn(),
    toast: vi.fn(),
    showMenu: vi.fn(),
    plotSignals: vi.fn(),
  },
  setOptions: vi.fn(),
}));
vi.mock("@zeloscloud/app-extension-sdk/react", () => ({
  usePanel: () => sdk.panel,
  useTimeState: () => null,
  useWorkspace: () => ({ id: "ws-1", name: "Workspace", modeKind: "TRACE" }),
  usePanelActions: () => sdk.actions,
  usePanelOptions: (defaults: Record<string, unknown>) => [defaults, sdk.setOptions],
  useZelosBridge: () => ({ bridge: {} }),
  useTheme: () => ({ preference: "LIGHT", resolvedDark: false, tokens: {} }),
  usePanelData: () => null,
}));

const usePacketDataMock = vi.hoisted(() => vi.fn());
vi.mock("../use-packet-data", () => ({ usePacketData: usePacketDataMock }));
const usePacketStatsMock = vi.hoisted(() => vi.fn());
vi.mock("../use-packet-stats", () => ({ usePacketStats: usePacketStatsMock }));

// The drawer goes back to the backend for the one packet that was clicked, so that fetch is what the
// drawer tests drive.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../event-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../event-fetch")>()),
  fetchPacketEventFields: fetchMock,
}));

function packet(over: Partial<PacketRow> & { id: string; timeS: number }): PacketRow {
  return {
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
    info: `packet ${over.id}`,
    producer: null,
    tracePath: "/caps/a.trz",
    streamKey: `stream-${over.id}`,
    frameNo: 1,
    source: "pkt",
    message: "pkt",
    ...over,
  };
}

const ROWS: PacketRow[] = [
  packet({ id: "a", timeS: 10 }),
  packet({ id: "b", timeS: 20, proto: "UDP", ipProto: 17, srcPort: 53, dstPort: 51515 }),
  packet({ id: "c", timeS: 30, proto: "ARP", ipProto: null, srcPort: null, dstPort: null }),
];

const signal = (name: string, message = "pkt"): PanelSignal => ({
  source: "pkt",
  message,
  signal: name,
  color: "#fff",
  path: `pkt/${message}.${name}`,
});

/** What an event-level drop binds: every field of the event, `frame` included. */
const SIGNALS: PanelSignal[] = [signal("info"), signal("frame")];

function panel(options: Record<string, unknown> | null = null, signals = SIGNALS): AppBridgePanelInfo {
  return {
    panelId: "packet-list",
    instanceId: "panel-1",
    title: null,
    signals,
    options,
    environment: { connectedProducers: [], needsProducerDisambiguation: false },
    visible: true,
  };
}

function mount(target = panel(), needsProducerDisambiguation = false) {
  sdk.panel = { ...target, environment: { connectedProducers: [], needsProducerDisambiguation } };
  return render(<PacketListPanel />);
}

/** Right-click a cell, exactly as the panel's context menu sees it: through the rendered DOM. */
const rightClick = (colId: string, rowIndex: number) => fireEvent.contextMenu(gridCell(colId, rowIndex));

/** The labels of the menu the panel asked the host to draw. */
const menuLabels = async (): Promise<string[]> => {
  await vi.waitFor(() => expect(sdk.actions.showMenu).toHaveBeenCalled());
  const menu = sdk.actions.showMenu.mock.calls.at(-1)?.[0] as { items: Array<{ label: string }> };
  return menu.items.map((item) => item.label);
};

/** The field set the panel handed the data hook: the subscription's projection. */
const projectedFields = (): PacketField[] => [...(usePacketDataMock.mock.calls[0]?.[2] as Set<PacketField>)].sort();

beforeEach(() => {
  vi.clearAllMocks();
  sdk.actions.showMenu.mockResolvedValue(null);
  sdk.actions.copyText.mockResolvedValue(null);
  sdk.actions.toast.mockResolvedValue(null);
  sdk.actions.setCursor.mockResolvedValue(null);
  usePacketDataMock.mockReturnValue({ rows: ROWS, totalRows: ROWS.length, isLoading: false, error: null });
  usePacketStatsMock.mockReturnValue(null);
  fetchMock.mockResolvedValue({ frame: "0x4142", orig_len: 74 });
});

describe("PacketListPanel", () => {
  // The capture node binds both events; the stats signals never reach the grid, they feed the strip.
  it("hands the grid only the packet signals and shows the stats strip from the rest", () => {
    const stats = { ...signal("pps", "pkt/stats"), eventType: "zelos.packet.stats.v1" };
    usePacketStatsMock.mockReturnValue("Packets 1,500 · Dropped 2 kernel / 0 agent · 120 pps · 1.5 Mbit/s");
    mount(panel(null, [...SIGNALS, stats]));
    expect(usePacketDataMock).toHaveBeenCalledWith(SIGNALS, expect.any(Number), expect.any(Set), false);
    expect(usePacketStatsMock).toHaveBeenCalledWith([stats]);
    expect(screen.getByTestId("packet-stats-strip").textContent).toContain("Packets 1,500");
  });

  it("says how much of the window the buffer holds, so a filter over it is not mistaken for the whole", () => {
    usePacketDataMock.mockReturnValue({ rows: ROWS, totalRows: 48_213, isLoading: false, error: null });
    mount(panel(null, SIGNALS));
    expect(screen.getByTestId("packet-window-status").textContent).toBe(`window: newest ${ROWS.length} of 48,213 rows`);
  });

  it("shows no strip when nothing answers for the stats", () => {
    mount();
    expect(screen.queryByTestId("packet-stats-strip")).toBeNull();
  });

  it("renders one row per packet, and the panel's fixed column schema", () => {
    mount();

    expect(screen.getAllByTestId("row")).toHaveLength(3);
    // Wireshark's default columns; Interface, VLAN and Frag Offset are off until asked for.
    expect(screen.getAllByTestId("header").map((h) => h.textContent)).toEqual([
      "No.",
      "Time",
      "Source",
      "Destination",
      "Protocol",
      "Length",
      "Info",
    ]);
    expect(screen.getByText("10.0.0.1:51514")).toBeTruthy();
    expect(screen.getByText("UDP")).toBeTruthy();
  });

  // The whole point of the projection: an event-level drop binds all 31 fields of `zelos.packet.v1`, and
  // `frame` alone is up to a snaplen of bytes per packet. The panel must ask for only what it shows.
  it("asks for the newest `bufferSize` packets, projected to the fields on screen and never to `frame`", () => {
    mount(panel({ bufferSize: 500 }));

    expect(usePacketDataMock).toHaveBeenCalledWith(SIGNALS, 500, expect.any(Set), false);
    expect(projectedFields()).toEqual([
      "cap_len",
      "dst_ip",
      "dst_port",
      "frame_no",
      "info",
      "ip_proto",
      "orig_len",
      "proto",
      "src_ip",
      "src_port",
      "truncated",
    ]);
  });

  // Dragging the whole source node binds every capture it holds into ONE panel, whose rows then
  // interleave. One agent, so `needsProducerDisambiguation` is false: it counts agents, not captures.
  it("shows Interface when the panel binds more than one capture, toggle off and one producer", () => {
    mount(panel(null, [signal("info"), signal("info", "wlan0")]));

    expect(screen.getAllByTestId("header").map((h) => h.textContent)).toContain("Interface");
    expect(projectedFields()).toContain("iface");
  });
});

describe("PacketListPanel — the cell menu", () => {
  it("offers the app's menu grammar plus the byte view, and no signal rows (a column is a FIELD)", async () => {
    mount();
    rightClick("info", 0);

    const labels = await menuLabels();
    expect(labels).toEqual(["Set cursor here", "Copy value", "Copy row as JSON", "View frame bytes"]);
    // The host draws each item with its icon; the cursor item stands apart from the packet's own items.
    const items = (sdk.actions.showMenu.mock.calls.at(-1)?.[0] as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((item) => item.icon)).toEqual(["cursor", "copy", "json", "bytes"]);
    expect(items.map((item) => item.separatorAfter ?? false)).toEqual([true, false, false, false]);
    expect(labels).not.toContain("Display format");
    expect(labels).not.toContain("Copy path");
  });

  it("omits the byte view when the panel doesn't bind the stream's `frame`", async () => {
    // Gated on the STREAM, not on a per-row value: the row carries no bytes.
    mount(panel(null, [signal("info")]));
    rightClick("info", 0);
    expect(await menuLabels()).not.toContain("View frame bytes");
  });

  it("fetches and shows the bytes of the packet that was right-clicked", async () => {
    sdk.actions.showMenu.mockResolvedValueOnce("view-frame");
    mount();
    rightClick("info", 1);

    // `0x4142` is "AB". The re-fetch is addressed by the clicked row's own (stream, frame number) identity.
    expect((await screen.findByTestId("frame-hex-view")).textContent).toContain("0000  41 42");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ streamKey: "stream-b", frameNo: 1 });
    expect(screen.getByText("UDP 10.0.0.1:53 → 10.0.0.2:51515")).toBeTruthy();
    // Docked under the list, not a modal: the packet list stays on screen, and Escape dismisses the pane
    // while the panel has focus (a click in it focuses it).
    expect(screen.getByTestId("packet-frame-drawer")).toBeTruthy();
    expect(screen.getAllByTestId("row")).toHaveLength(3);
    (document.querySelector("[data-grid-panel]") as HTMLElement).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("packet-frame-drawer")).toBeNull();
  });

  it("says the packet is gone rather than showing some other packet's bytes", async () => {
    fetchMock.mockRejectedValue(new Error("gone"));
    sdk.actions.showMenu.mockResolvedValueOnce("view-frame");
    mount();
    rightClick("info", 0);

    expect(await screen.findByText(/no longer available/)).toBeTruthy();
    expect(screen.queryByTestId("frame-hex-view")).toBeNull();
  });

  // Copy row as JSON fetches the fields the grid never loaded, so the fetch can fail two ways.
  it("says a packet is gone only when it is gone, and passes any other failure through as the cause", async () => {
    const { PacketEventGoneError } = await import("../event-fetch");
    mount();

    fetchMock.mockRejectedValueOnce(new PacketEventGoneError());
    sdk.actions.showMenu.mockResolvedValueOnce("copy-row-json");
    rightClick("info", 0);
    await vi.waitFor(() =>
      expect(sdk.actions.toast).toHaveBeenCalledWith({
        tone: "error",
        title: "Couldn't copy the packet",
        description: "This packet is no longer available.",
      }),
    );

    fetchMock.mockRejectedValueOnce(new Error("agent unreachable"));
    sdk.actions.showMenu.mockResolvedValueOnce("copy-row-json");
    rightClick("info", 0);
    await vi.waitFor(() =>
      expect(sdk.actions.toast).toHaveBeenCalledWith({
        tone: "error",
        title: "Couldn't copy the packet",
        description: "agent unreachable",
      }),
    );
    expect(sdk.actions.copyText).not.toHaveBeenCalled();
  });
});
