import { MockBridge } from "@zeloscloud/app-extension-sdk";
import { useZelosBridge, ZelosBridgeProvider } from "@zeloscloud/app-extension-sdk/react";
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { PacketListPanel } from "./panel";
import "../../index.css";
import "./packet-list.css";

/** Feeds the standalone mock host a synthetic capture, from a chunk Zelos never fetches. */
function DevFeed() {
  const { bridge, mode } = useZelosBridge();
  useEffect(() => {
    if (mode !== "standalone" || !(bridge instanceof MockBridge)) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import("./dev-feed").then(({ startDevFeed }) => {
      if (!cancelled) stop = startDevFeed(bridge);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [bridge, mode]);
  return null;
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing #root element");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* Read only in standalone mode; in Zelos the host's handshake describes the panel. */}
    <ZelosBridgeProvider
      connectOptions={{
        extensionId: "local.packet",
        name: "Packet",
        workspace: { name: "Synthetic capture", modeKind: "LIVE" },
        panel: { panelId: "packet-list", instanceId: "dev-packet-list" },
      }}
    >
      <DevFeed />
      <PacketListPanel />
    </ZelosBridgeProvider>
  </React.StrictMode>,
);
