import type { AppBridgePanelData, AppBridgePanelSignal, PanelSubscribeParams } from "@zeloscloud/app-extension-sdk";
import { usePanelData } from "@zeloscloud/app-extension-sdk/react";
import { useMemo, useRef, useState } from "react";
import { meltPacketRows, type PacketField, type PacketRow, packetsLackFrameNumbers } from "./data";
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
): { rows: PacketRow[]; totalRows: number; isLoading: boolean; error: string | null; unnumbered: boolean } {
  const paths = useMemo(
    () => uniquePaths(signals.filter((signal) => fields.has(signal.signal as PacketField))),
    [signals, fields],
  );
  // `desc`, so the limit keeps the newest packets across every bound capture.
  const params = useMemo<PanelSubscribeParams | null>(
    () =>
      paths.length === 0
        ? null
        : { id: "packets", shape: "rows", signals: paths, maxRows: bufferSize, sortOrder: "desc", endAtCursor: false },
    [paths, bufferSize],
  );
  const paramsKey = params === null ? null : JSON.stringify(params);

  const heldRef = useRef<AppBridgePanelData | null>(null);
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const frame = usePanelData(frozen && heldKey === paramsKey ? null : params);
  let nextHeldKey = heldKey;
  if (paramsKey === null) {
    heldRef.current = null;
    nextHeldKey = null;
  } else if (frame && !frame.isLoading && frame !== heldRef.current) {
    // A replaced subscription returns its last frame until the new one answers: key only a new, answered frame.
    heldRef.current = frame;
    nextHeldKey = paramsKey;
  }
  if (nextHeldKey !== heldKey) setHeldKey(nextHeldKey);
  const shown = frame ?? heldRef.current;

  const dataset = shown?.dataset ?? null;
  // The frame's mode, not the ambient one: the per-packet re-fetch expresses its window in it.
  const timeMode = toTimeMode(shown?.timeMode);

  // Unchanged packets keep their object, so AG Grid skips them.
  const previousRowsRef = useRef<PacketRow[]>([]);
  const rows = useMemo(() => {
    const next = meltPacketRows(dataset, "desc", signals, timeMode, previousRowsRef.current);
    previousRowsRef.current = next;
    return next;
  }, [dataset, signals, timeMode]);

  return {
    rows,
    totalRows: shown?.totalRows ?? 0,
    isLoading: (shown === null || shown.isLoading) && rows.length === 0 && paths.length > 0,
    error: shown?.error ?? null,
    unnumbered: rows.length === 0 && packetsLackFrameNumbers(dataset),
  };
}
