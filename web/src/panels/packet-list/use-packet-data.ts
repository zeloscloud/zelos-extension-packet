import { type AppBridgePanelData, type AppBridgePanelSignal, fitRowBudget } from "@zeloscloud/app-extension-sdk";
import { usePanelData } from "@zeloscloud/app-extension-sdk/react";
import { useMemo, useRef } from "react";
import { meltPacketRows, type PacketField, type PacketRow, packetsLackFrameNumbers } from "./data";
import { toTimeMode } from "./grid/format";

/** Each bound path once: a signal expanded across segments or producers repeats its path. */
export function uniquePaths(signals: readonly AppBridgePanelSignal[]): string[] {
  return [...new Set(signals.map((signal) => signal.path))];
}

/**
 * Captured packets over the host's time window (trace and live), pushed by the host as a `rows`
 * subscription.
 *
 * PROJECTION: an event-level drop binds all 31 fields of `zelos.packet.v1`, but the panel shows at most
 * nine. `signal.signal` is the bare field name and the melt matches on `column.signal`, so filtering the
 * bound signals by field name is exactly the panel's schema, and the subscription follows a toggle. The
 * melt still sees the FULL signal list: ownership is a superset check, so a field that becomes visible
 * mid-flight keeps its attribution while the widened subscription is in flight.
 *
 * Sort order is `desc`: the backend's sort + limit is global across the union, so this is
 * `tail -n bufferSize` merged across every bound capture, and the melt walks it backwards into ascending
 * rows. `bufferSize` is fitted to the host's cell cap, so a capture-heavy binding asks for fewer rows
 * rather than being refused. A live window that follows the tail comes back newest-first whatever was asked, so `desc` is the
 * only order every mode agrees on.
 *
 * FROZEN (the viewport parked off the tail) drops the subscription, so the rows on screen stop rotating
 * under the reader; the last frame is held until following resumes and a new frame arrives.
 */
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

  const frame = usePanelData(
    frozen || paths.length === 0
      ? null
      : {
          id: "packets",
          shape: "rows",
          signals: paths,
          maxRows: fitRowBudget(paths.length, bufferSize),
          sortOrder: "desc",
          endAtCursor: false,
        },
  );

  // A null frame means "no subscription right now" (parked, or between subscriptions), not "no packets".
  const heldRef = useRef<AppBridgePanelData | null>(null);
  if (paths.length === 0) heldRef.current = null;
  else if (frame) heldRef.current = frame;
  const shown = frame ?? heldRef.current;

  const dataset = shown?.dataset ?? null;
  // The FRAME's mode, not the ambient one: `timeS` means epoch seconds under `absolute` and elapsed
  // seconds under `relative`, and the per-packet re-fetch has to express its window the same way.
  const timeMode = toTimeMode(shown?.timeMode);

  // Carries the previous build's rows so unchanged packets keep object identity across frames, letting AG
  // Grid skip them: a whole-window replace then costs only what actually arrived.
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
