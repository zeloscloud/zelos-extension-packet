import { type AppBridgePanelData, MockBridge } from "@zeloscloud/app-extension-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meltPacketRows } from "../data";
import { DEV_SIGNALS, startDevFeed } from "../dev-feed";
import { dissectFrame } from "../dissect";
import { fetchPacketEventFields, PACKET_EVENT_FIELDS } from "../event-fetch";
import { parseFrameHex } from "../hex-bytes";

/** `npm run dev` must show a working panel: rows, stats, a moving cursor, and frames the drawer can dissect. */

function connect(): MockBridge {
  return MockBridge.connect(
    {
      currentWindow: window,
      parentWindow: window,
      locationHref: "http://localhost:5173",
      matchMedia: window.matchMedia.bind(window),
    },
    { panel: {}, workspace: { modeKind: "LIVE" } },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the dev feed", () => {
  it("binds one capture, pushes packets and stats, moves the cursor, and answers the frame re-fetch", async () => {
    vi.useFakeTimers();
    const bridge = connect();
    const frames: AppBridgePanelData[] = [];
    bridge.on("panel.data", (frame) => frames.push(frame));
    const original = bridge.invoke;

    const stop = startDevFeed(bridge);
    const firstCursor = bridge.getSnapshot().time?.cursorS;
    vi.advanceTimersByTime(1_000);

    const panel = bridge.getSnapshot().panel;
    expect(panel?.signals).toEqual(DEV_SIGNALS);
    expect(DEV_SIGNALS.filter((signal) => signal.eventType === "zelos.packet.v1")).toHaveLength(PACKET_EVENT_FIELDS.length);
    expect(DEV_SIGNALS.filter((signal) => signal.eventType === "zelos.packet.stats.v1")).toHaveLength(10);
    expect(bridge.getSnapshot().time?.cursorS).not.toBe(firstCursor);

    const rows = frames.filter((frame) => frame.id === "packets").at(-1);
    const melted = meltPacketRows(rows?.dataset, "desc", DEV_SIGNALS, "absolute");
    expect(melted.length).toBeGreaterThan(10);
    expect(new Set(melted.map((row) => row.proto))).toEqual(new Set(["TCP", "UDP", "ICMP"]));
    expect(frames.filter((frame) => frame.id === "stats").at(-1)?.latest?.length).toBe(10);

    // The drawer's re-fetch, through the patched invoke: the packet's own bytes, which dissect cleanly.
    const udp = melted.find((row) => row.proto === "UDP");
    if (!udp) throw new Error("no UDP packet");
    const cells = await fetchPacketEventFields(bridge, udp, ["link_type", "frame"], true);
    const layers = dissectFrame(parseFrameHex(String(cells.frame)), Number(cells.link_type)).map((node) => node.label);
    expect(layers.slice(0, 3)).toEqual(["Ethernet", "IPv4", "UDP"]);

    stop();
    const count = frames.length;
    vi.advanceTimersByTime(1_000);
    expect(frames.length).toBe(count);
    expect(bridge.invoke).toBe(original);
    bridge.destroy();
  });
});
