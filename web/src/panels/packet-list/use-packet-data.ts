import type {
  AppBridgePanelData,
  AppBridgePanelSignal,
  AppBridgeWorkspaceInfo,
  PanelSubscribeParams,
} from "@zeloscloud/app-extension-sdk";
import { usePanelData, useWorkspace } from "@zeloscloud/app-extension-sdk/react";
import { useMemo, useState } from "react";
import { meltPacketRows, type PacketField, type PacketRow } from "./data";
import { toTimeMode } from "./grid/format";

/** Each bound path once: a signal expanded across segments or producers repeats its path. */
export function uniquePaths(signals: readonly AppBridgePanelSignal[]): string[] {
  return [...new Set(signals.map((signal) => signal.path))];
}

/** Where the workspace reads its data from: a live agent or its recordings. */
function timeSourceOf(workspace: AppBridgeWorkspaceInfo | null): string {
  return workspace === null
    ? ""
    : [workspace.id, workspace.modeKind, ...workspace.traces].join("\u0000");
}

interface HeldFrame {
  /** The last answered frame of `source`, and the params it answered. */
  frame: AppBridgePanelData | null;
  key: string | null;
  source: string;
  /** The frame on screen when the source changed: the host serves it until the new source answers. */
  stale: AppBridgePanelData | null;
}

/** The newest `bufferSize` packets in the host's window; `frozen` holds the last frame; new params or time source fetch one. */
export function usePacketData(
  signals: AppBridgePanelSignal[],
  bufferSize: number,
  fields: ReadonlySet<PacketField>,
  frozen: boolean,
): {
  rows: PacketRow[];
  totalRows: number;
  isLoading: boolean;
  error: string | null;
} {
  const paths = useMemo(
    () => uniquePaths(signals.filter((signal) => fields.has(signal.signal as PacketField))),
    [signals, fields],
  );
  // `desc`, so the limit keeps the newest packets across every bound capture.
  const params = useMemo<PanelSubscribeParams | null>(
    () =>
      paths.length === 0
        ? null
        : {
            id: "packets",
            shape: "rows",
            signals: paths,
            maxRows: bufferSize,
            sortOrder: "desc",
            endAtCursor: false,
          },
    [paths, bufferSize],
  );
  const paramsKey = params === null ? null : JSON.stringify(params);
  const source = timeSourceOf(useWorkspace());

  const [held, setHeld] = useState<HeldFrame>(() => ({
    frame: null,
    key: null,
    source,
    stale: null,
  }));
  const switched = held.source !== source;
  const latest = usePanelData(frozen && !switched && held.key === paramsKey ? null : params);
  let nextHeld: HeldFrame = switched ? { frame: null, key: null, source, stale: latest } : held;
  const frame = latest === nextHeld.stale ? null : latest;
  if (paramsKey === null) {
    if (nextHeld.frame !== null || nextHeld.key !== null) {
      nextHeld = { ...nextHeld, frame: null, key: null };
    }
  } else if (frame && !frame.isLoading && frame !== nextHeld.frame) {
    // A replaced subscription returns its last frame until the new one answers: key only a new, answered frame.
    nextHeld = { frame, key: paramsKey, source, stale: null };
  }
  if (nextHeld !== held) setHeld(nextHeld);
  const shown = frame ?? nextHeld.frame;

  const dataset = shown?.dataset ?? null;
  // The frame's mode, not the ambient one: the per-packet re-fetch expresses its window in it.
  const timeMode = toTimeMode(shown?.timeMode);

  // Unchanged packets keep their object, so AG Grid skips them.
  const [melted, setMelted] = useState(() => ({
    dataset,
    signals,
    timeMode,
    rows: meltPacketRows(dataset, "desc", signals, timeMode, []),
  }));
  let current = melted;
  if (melted.dataset !== dataset || melted.signals !== signals || melted.timeMode !== timeMode) {
    current = {
      dataset,
      signals,
      timeMode,
      rows: meltPacketRows(dataset, "desc", signals, timeMode, melted.rows),
    };
    setMelted(current);
  }
  const rows = current.rows;

  return {
    rows,
    totalRows: shown?.totalRows ?? 0,
    isLoading: (shown === null || shown.isLoading) && rows.length === 0 && paths.length > 0,
    error: shown?.error ?? null,
  };
}
