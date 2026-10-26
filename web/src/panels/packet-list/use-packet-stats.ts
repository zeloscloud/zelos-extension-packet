import type { AppBridgePanelSignal } from "@zeloscloud/app-extension-sdk";
import { usePanelData, useWorkspace } from "@zeloscloud/app-extension-sdk/react";
import { useMemo } from "react";
import { formatPacketStats, summarizePacketStats } from "./stats";
import { uniquePaths } from "./use-packet-data";

/** The strip's text, or null; outside live follow the host answers at the cursor, so rates show only live. */
export function usePacketStats(stats: AppBridgePanelSignal[]): string | null {
  const paths = useMemo(() => uniquePaths(stats), [stats]);
  const frame = usePanelData(paths.length === 0 ? null : { id: "stats", shape: "latest", signals: paths });
  const latest = frame?.latest ?? null;
  const live = useWorkspace()?.modeKind === "LIVE";
  return useMemo(() => {
    const summary = latest ? summarizePacketStats(latest) : null;
    return summary ? formatPacketStats(summary, { rates: live }) : null;
  }, [latest, live]);
}
