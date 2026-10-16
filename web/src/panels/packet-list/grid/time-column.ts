import type { ColDef, ColumnState } from "ag-grid-community";
import type { SortOrder } from "@zeloscloud/app-extension-sdk";
import { MONO_VALUE_CELL } from "./chrome";
import { formatTimeByMode, type TimeMode } from "./format";

/** The time column's id. The sort rules below key on it. */
const TIME_COL_ID = "time";

/** A row's own time mode wins over the panel's: for a moment after a mode switch the two disagree. */
type TimedRow = { timeS: number; timeMode?: TimeMode | undefined };

/**
 * The Time column, whole. A panel spreads this and appends only its own concerns (width, renderer).
 *
 * `sortable` is set explicitly because a time-ordered grid turns the shared default off; Time re-enables
 * it. This is load-bearing: the tail chase can only find the newest row if sorting always leaves it at
 * one end of the grid. Filters and search match the rendered time, never the underlying float.
 */
export function gridTimeColumnDef<TRow extends TimedRow>(timeMode: TimeMode): ColDef<TRow> {
  const text = (row: TRow | undefined) => (row ? formatTimeByMode(row.timeS, row.timeMode ?? timeMode) : "");
  return {
    colId: TIME_COL_ID,
    headerName: "Time",
    pinned: "left",
    initialSort: "asc",
    sortable: true,
    cellClass: MONO_VALUE_CELL,
    comparator: (_a, _b, nodeA, nodeB) => (nodeA.data?.timeS ?? 0) - (nodeB.data?.timeS ?? 0),
    valueGetter: (p) => p.data?.timeS,
    valueFormatter: (p) => text(p.data),
    filterValueGetter: (p) => text(p.data),
    getQuickFilterText: (p) => text(p.data),
  };
}

/** The grid's sort on the Time column, or null when it isn't sorted by time at all. */
function timeSortOf(columnState: readonly ColumnState[] | null): SortOrder | null {
  const sort = columnState?.find((column) => column.colId === TIME_COL_ID)?.sort;
  return sort === "asc" || sort === "desc" ? sort : null;
}

/**
 * Which end of the grid the newest row sits at. Derived from grid state on every read, never mirrored:
 * AG Grid's sort cycle is asc → desc → none, so a mirrored flag goes stale silently. Cleared means
 * row-data order, which the row builder guarantees ascending.
 */
export function displayedTimeOrder(columnState: readonly ColumnState[] | null): SortOrder {
  return timeSortOf(columnState) ?? "asc";
}
