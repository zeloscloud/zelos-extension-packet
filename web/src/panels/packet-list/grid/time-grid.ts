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

/** The last item at or before `targetTime`, or -1: the step-before rule a plot's crosshair reads values with. */
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

/** Marks the cursor row, pins the newest one and offers a way back; `rows` must be ascending by time. */
export function useTimeGrid<TRow extends TimeGridRow>({
  sessionId,
  rows,
  getGridApi,
  columnState,
  rowHeight,
  autoScroll,
  onError,
}: {
  sessionId: string;
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
    sessionId,
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
