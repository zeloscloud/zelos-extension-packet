import type { ColDef, ColumnState } from "ag-grid-community";
import type { SortOrder } from "@zeloscloud/app-extension-sdk";
import { MONO_VALUE_CELL } from "./chrome";
import { formatTimeByMode, type TimeMode } from "./format";
import { GRID_CELL_HORIZONTAL_PADDING_PX } from "./theme";

/** The time column's id. The sort rules below key on it. */
const TIME_COL_ID = "time";

let measureContext: CanvasRenderingContext2D | null | undefined;
let monoFamily: string | undefined;

/** The cells' monospace face, read from their own class, so the measure and the grid never disagree. */
function monoCellFamily(): string {
  if (monoFamily === undefined) {
    const probe = document.createElement("span");
    probe.className = MONO_VALUE_CELL;
    document.body.append(probe);
    monoFamily = getComputedStyle(probe).fontFamily || "monospace";
    probe.remove();
  }
  return monoFamily;
}

/** The Time column's width at a font size: its widest time in the cells' mono face, plus their padding. */
export function timeColumnWidth(
  timeMode: TimeMode,
  fontSizePx: number,
  startS: number,
  endS: number,
): number | undefined {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const measure = measureContext;
  if (!measure) return undefined;
  measure.font = `${fontSizePx}px ${monoCellFamily()}`;
  // Every wall-clock time renders at one width; an elapsed time is widest at an end of the data.
  const times = timeMode === "relative" ? [startS, endS] : [0];
  const widest = Math.max(
    ...times.map((timeS) => measure.measureText(formatTimeByMode(timeS, timeMode)).width),
  );
  return Math.ceil(widest) + 2 * GRID_CELL_HORIZONTAL_PADDING_PX;
}

/** A row's own time mode wins over the panel's: for a moment after a mode switch the two disagree. */
type TimedRow = { timeS: number; timeMode?: TimeMode | undefined };

/** The Time column. Sortable against the grid's default: the tail chase needs the newest row at an end. */
export function gridTimeColumnDef<TRow extends TimedRow>(
  timeMode: TimeMode,
  width: number | undefined,
): ColDef<TRow> {
  const text = (row: TRow | undefined) =>
    row ? formatTimeByMode(row.timeS, row.timeMode ?? timeMode) : "";
  return {
    // A floor, so a larger font or a saved width never cuts the time.
    ...(width === undefined ? {} : { initialWidth: width, minWidth: width }),
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

/** Which end the newest row sits at; a cleared sort is row-data order, which is ascending. */
export function displayedTimeOrder(columnState: readonly ColumnState[] | null): SortOrder {
  return timeSortOf(columnState) ?? "asc";
}
