import type { ColumnState, ValueFormatterParams, ValueGetterParams } from "ag-grid-community";
import { describe, expect, it } from "vitest";
import { formatTimeByMode } from "../grid/format";
import { displayedTimeOrder, gridTimeColumnDef } from "../grid/time-column";

interface TestRow {
  timeS: number;
  timeMode?: "absolute" | "relative" | undefined;
}

const columnState = (overrides: Partial<ColumnState>[]): ColumnState[] =>
  overrides.map((o) => ({
    colId: "x",
    width: 100,
    flex: null,
    hide: false,
    pinned: null,
    sort: null,
    sortIndex: null,
    ...o,
  }));

describe("gridTimeColumnDef", () => {
  const def = gridTimeColumnDef<TestRow>("absolute", undefined);

  // The rest of the grid is unsortable; the tail chase needs the newest row at an end.
  it("re-enables its own sort against the time-ordered default", () => {
    expect(def.sortable).toBe(true);
  });

  it("filters and searches on the rendered time, never the float under it", () => {
    expect(def.filter).toBeUndefined();
    const row = { timeS: 1_700_000_000.5 };
    const rendered = formatTimeByMode(row.timeS, "absolute");
    const filterText = def.filterValueGetter as (p: { data: TestRow }) => string;
    const searchText = def.getQuickFilterText as (p: { data: TestRow }) => string;

    expect(filterText({ data: row })).toBe(rendered);
    expect(searchText({ data: row })).toBe(rendered);
  });

  it("pins itself left, starts ascending, and is the id every time rule keys on", () => {
    expect(def.colId).toBe("time");
    expect(def.headerName).toBe("Time");
    expect(def.pinned).toBe("left");
    expect(def.initialSort).toBe("asc");
  });

  it("sorts by the raw instant, not by the rendered text", () => {
    const node = (timeS: number) => ({ data: { timeS } });
    const compare = def.comparator as (a: unknown, b: unknown, na: unknown, nb: unknown) => number;
    expect(compare(null, null, node(9), node(10))).toBeLessThan(0);
    expect(compare(null, null, node(10), node(9))).toBeGreaterThan(0);
  });

  it("renders the instant in the row's own time mode", () => {
    const row = { timeS: 1_700_000_000 };
    const formatted = def.valueFormatter as (p: ValueFormatterParams<TestRow>) => string;
    const getter = def.valueGetter as (p: ValueGetterParams<TestRow>) => number | undefined;

    expect(getter({ data: row } as ValueGetterParams<TestRow>)).toBe(row.timeS);
    expect(formatted({ data: row } as ValueFormatterParams<TestRow>)).toBe(formatTimeByMode(row.timeS, "absolute"));
    expect(formatted({ data: undefined } as ValueFormatterParams<TestRow>)).toBe("");
    // Just after a mode switch, a row melted under the old mode still reads in it.
    const elapsed = { timeS: 1.25, timeMode: "relative" as const };
    expect(formatted({ data: elapsed } as ValueFormatterParams<TestRow>)).toBe("0:01.250000");
  });
});

describe("displayedTimeOrder", () => {
  it("reads the Time column's sort, ignoring every other column's", () => {
    expect(
      displayedTimeOrder(
        columnState([
          { colId: "proto", sort: "asc" },
          { colId: "time", sort: "desc" },
        ]),
      ),
    ).toBe("desc");
    expect(displayedTimeOrder(columnState([{ colId: "time", sort: "asc" }]))).toBe("asc");
  });

  // AG Grid's sort cycle ends in none, which is row-data order: ascending, so the tail is still last.
  it("falls back to ascending when the sort is cleared, or the grid has no state yet", () => {
    expect(displayedTimeOrder(columnState([{ colId: "time", sort: null }]))).toBe("asc");
    expect(displayedTimeOrder(columnState([{ colId: "proto", sort: "desc" }]))).toBe("asc");
    expect(displayedTimeOrder(null)).toBe("asc");
  });
});

describe("formatTimeByMode", () => {
  it("reads a relative time as elapsed, from the trace's start", () => {
    expect(formatTimeByMode(1.25, "relative")).toBe("0:01.250000");
    expect(formatTimeByMode(112.5, "relative")).toBe("1:52.500000");
  });

  it("reads an absolute time as local wall-clock", () => {
    expect(formatTimeByMode(0, "absolute")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/);
  });
});
