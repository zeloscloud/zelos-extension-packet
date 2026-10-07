import { usePanelActions, useTimeState, useWorkspace } from "@zeloscloud/app-extension-sdk/react";
import type { ColumnState, GridApi, RowClassParams, RowClassRules } from "ag-grid-community";
import { useCallback, useMemo } from "react";
import { type GridFollowEvents, useGridFollow } from "./follow";
import { displayedTimeOrder } from "./time-column";

/** A row of a time-ordered grid: an identity, and the instant it happened at. */
interface TimeGridRow {
  readonly id: string;
  readonly timeS: number;
}

interface TimeGrid<TRow extends TimeGridRow> {
  /** Move the host cursor to a row's instant: the context menu's "Set cursor here". */
  onSetCursor: (timeS: number) => void;
  rowClassRules: RowClassRules<TRow>;
  /** Spread onto the grid. */
  gridEvents: GridFollowEvents<TRow>;
  follow: { label: string; onClick: () => void } | undefined;
}

/** The cursor row is marked, not selected: a selection would fight `enableCellTextSelection`. */
const CURSOR_ROW_CLASS = "cursor-row";

/**
 * Index of the last item at or before `targetTime`, by binary search over ascending items; -1 if none.
 * The step-before rule a plot reads values with, so the marked row is the one a crosshair would read.
 */
function findNearestTimeIndexBy<T>(
  items: readonly T[],
  targetTime: number,
  timeOf: (item: T) => number,
): number {
  let left = 0;
  let right = items.length - 1;
  let result = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const item = items[mid];
    if (item !== undefined && timeOf(item) <= targetTime) {
      result = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return result;
}

/**
 * Everything a time-ordered grid does beyond being a grid: mark the cursor row, pin the newest row, and
 * offer a way back. The host's cursor and playback arrive through `useTimeState`; "Set cursor here"
 * goes back through `panel.setCursor`.
 *
 * `rows` must be ascending by time; the tail chase depends on it.
 */
export function useTimeGrid<TRow extends TimeGridRow>({
  instanceId,
  rows,
  getGridApi,
  columnState,
  rowHeight,
  autoScroll,
  onError,
}: {
  instanceId: string;
  rows: readonly TRow[];
  getGridApi: () => GridApi<TRow> | null;
  columnState: readonly ColumnState[] | null;
  /** The height the grid is CONFIGURED with, so the follow math can't drift from what it renders. */
  rowHeight: number;
  autoScroll: boolean;
  /** Reports a cursor move the host refused. */
  onError: (title: string, error: unknown) => void;
}): TimeGrid<TRow> {
  const time = useTimeState();
  const workspace = useWorkspace();
  const { setCursor } = usePanelActions();
  const cursorTime = time?.cursorS ?? null;
  const isLiveWorkspace = workspace?.modeKind === "LIVE";
  const playback = time?.playback;

  const onSetCursor = useCallback(
    (timeS: number) => {
      setCursor(timeS).catch((error: unknown) => onError("Couldn't set the cursor", error));
    },
    [setCursor, onError],
  );

  const cursorRowId = useMemo(() => {
    if (cursorTime == null) return undefined;
    const index = findNearestTimeIndexBy(rows, cursorTime, (row) => row.timeS);
    return index >= 0 ? rows[index]?.id : undefined;
  }, [rows, cursorTime]);

  const rowClassRules = useMemo(
    () => ({ [CURSOR_ROW_CLASS]: (p: RowClassParams<TRow>) => p.data?.id === cursorRowId }),
    [cursorRowId],
  );

  const { gridEvents, follow } = useGridFollow<TRow>({
    instanceId,
    getGridApi,
    cursorRowId,
    // Rows are ascending by time, so the newest is the last one.
    newestRowId: rows[rows.length - 1]?.id,
    followsTail: autoScroll && isLiveWorkspace && playback === "LIVE",
    tailOrder: displayedTimeOrder(columnState),
    rowHeight,
  });

  return { onSetCursor, rowClassRules, gridEvents, follow };
}
