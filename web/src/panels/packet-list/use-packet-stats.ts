import type { AppBridgePanelSignal } from "@zeloscloud/app-extension-sdk";
import { usePanelData, useWorkspace } from "@zeloscloud/app-extension-sdk/react";
import { useMemo } from "react";
import { formatPacketStats, summarizePacketStats } from "./stats";
import { uniquePaths } from "./use-packet-data";

/**
 * The status strip's text, or null when the panel binds no stats or nothing has answered yet. A `latest`
 * subscription: the host answers with live latest values while following live, and the values at the
 * cursor otherwise, so trace mode shows the counters as they stood at the cursor. The rates are shown
 * only in a live workspace.
 */
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
