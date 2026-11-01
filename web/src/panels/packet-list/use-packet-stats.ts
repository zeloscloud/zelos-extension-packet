import type { AppBridgePanelData, AppBridgePanelSignal } from "@zeloscloud/app-extension-sdk";
import { usePanelData, useWorkspace } from "@zeloscloud/app-extension-sdk/react";
import { useMemo, useState } from "react";
import { formatPacketStats, summarizePacketStats } from "./stats";
import { timeSourceOf, uniquePaths } from "./use-packet-data";

/** The strip's text, or null; outside live follow the host answers at the cursor, so rates show only live. */
export function usePacketStats(stats: AppBridgePanelSignal[]): string | null {
  const paths = useMemo(() => uniquePaths(stats), [stats]);
  const frame = usePanelData(
    paths.length === 0 ? null : { id: "stats", shape: "latest", signals: paths },
  );
  const workspace = useWorkspace();
  const live = workspace?.modeKind === "LIVE";
  // The host serves the frame it last sent until the new time source answers.
  const source = timeSourceOf(workspace);
  const [switched, setSwitched] = useState<{
    source: string;
    stale: AppBridgePanelData | null;
  }>({ source, stale: null });
  let stale = switched.stale;
  if (switched.source !== source) {
    stale = frame;
    setSwitched({ source, stale });
  }
  const latest = frame === stale ? null : (frame?.latest ?? null);
  return useMemo(() => {
    const summary = latest ? summarizePacketStats(latest) : null;
    return summary ? formatPacketStats(summary, { rates: live }) : null;
  }, [latest, live]);
}
