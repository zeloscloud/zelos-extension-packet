import type {
  AppBridgePanelData,
  AppBridgePanelSignal,
  PanelSubscribeParams,
} from "@zeloscloud/app-extension-sdk";
import { usePanelData } from "@zeloscloud/app-extension-sdk/react";
import { useMemo, useState } from "react";
import { meltPacketRows, type PacketField, type PacketRow } from "./data";
import { toTimeMode } from "./grid/format";

/** Each bound path once: a signal expanded across segments or producers repeats its path. */
export function uniquePaths(signals: readonly AppBridgePanelSignal[]): string[] {
  return [...new Set(signals.map((signal) => signal.path))];
}

/** The newest `bufferSize` packets in the host's window; `frozen` holds the last frame, and new params fetch one. */
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

  const [held, setHeld] = useState<{ frame: AppBridgePanelData | null; key: string | null }>({
    frame: null,
    key: null,
  });
  const frame = usePanelData(frozen && held.key === paramsKey ? null : params);
  let nextHeld = held;
  if (paramsKey === null) {
    if (held.frame !== null || held.key !== null) nextHeld = { frame: null, key: null };
  } else if (frame && !frame.isLoading && frame !== held.frame) {
    // A replaced subscription returns its last frame until the new one answers: key only a new, answered frame.
    nextHeld = { frame, key: paramsKey };
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
