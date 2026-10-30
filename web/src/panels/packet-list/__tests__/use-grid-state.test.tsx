import { act, renderHook } from "@testing-library/react";
import type {
  ColumnResizedEvent,
  ColumnState,
  FilterModel,
  GridApi,
  GridReadyEvent,
} from "ag-grid-community";
import type { ChangeEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFilterModel, useGridPanelState } from "../grid/use-grid-state";

interface TestRow {
  id: string;
}

const host = vi.hoisted(() => ({
  setOptions: vi.fn<(patch: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock("@zeloscloud/app-extension-sdk/react", () => ({
  useTheme: () => ({ preference: "LIGHT", resolvedDark: false, tokens: {} }),
  usePanelOptions: (defaults: Record<string, unknown>) => [defaults, host.setOptions],
}));

const TCP_ONLY: FilterModel = { proto: { filterType: "text", type: "equals", filter: "TCP" } };
const TCP_OR_UDP: FilterModel = {
  proto: {
    filterType: "text",
    operator: "OR",
    conditions: [
      { filterType: "text", type: "equals", filter: "TCP" },
      { filterType: "text", type: "equals", filter: "UDP" },
    ],
  },
};

const NoRows = () => null;
const Loading = () => null;

/** A grid stand-in: it reports what the test says the user did, and records what was applied to it. */
function fakeGrid() {
  const grid = {
    filterModel: {} as FilterModel,
    columnState: [] as ColumnState[],
    setFilterModel: vi.fn<(model: FilterModel) => void>(),
    applyColumnState: vi.fn<(args: { state: ColumnState[]; applyOrder?: boolean }) => void>(),
    api: {} as GridApi<TestRow>,
  };
  grid.api = {
    isDestroyed: () => false,
    setFilterModel: grid.setFilterModel,
    getFilterModel: () => grid.filterModel,
    getColumnState: () => grid.columnState,
    applyColumnState: grid.applyColumnState,
  } as unknown as GridApi<TestRow>;
  return grid;
}

function mount(options: Record<string, unknown> | null = null, sessionId = "ws-1/panel-1") {
  return renderHook(() =>
    useGridPanelState<TestRow>({
      sessionId,
      options,
      noRowsOverlay: NoRows,
      loadingOverlay: Loading,
    }),
  );
}

const ready = (view: ReturnType<typeof mount>, grid: ReturnType<typeof fakeGrid>) =>
  act(() =>
    view.result.current.gridProps.onGridReady({ api: grid.api } as GridReadyEvent<TestRow>),
  );

const savedFilters = () =>
  host.setOptions.mock.calls.map(([patch]) => (patch.grid as { filterModel: unknown }).filterModel);

beforeEach(() => {
  host.setOptions.mockReset();
  host.setOptions.mockResolvedValue();
});

describe("the filter model, saved in the panel's options", () => {
  it("applies the saved model at mount and saves every change back", () => {
    const grid = fakeGrid();
    const view = mount({ grid: { filterModel: TCP_ONLY } });
    ready(view, grid);
    expect(grid.setFilterModel).toHaveBeenCalledWith(TCP_ONLY);

    grid.filterModel = TCP_OR_UDP;
    act(() => view.result.current.gridProps.onFilterChanged());

    expect(savedFilters()).toEqual([TCP_OR_UDP]);
  });

  // The frame unloads on a tab switch without running cleanups, so a write deferred past the edit is lost.
  it("saves an edit as it happens", () => {
    vi.useFakeTimers();
    try {
      const grid = fakeGrid();
      const view = mount();
      ready(view, grid);

      grid.filterModel = TCP_ONLY;
      act(() => view.result.current.gridProps.onFilterChanged());
      expect(savedFilters()).toEqual([TCP_ONLY]);

      grid.filterModel = TCP_OR_UDP;
      act(() => view.result.current.gridProps.onFilterChanged());
      expect(savedFilters()).toEqual([TCP_ONLY, TCP_OR_UDP]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a no-op filter event, the one AG Grid fires for the restore included", () => {
    const grid = fakeGrid();
    const view = mount({ grid: { filterModel: TCP_ONLY } });
    ready(view, grid);

    grid.filterModel = TCP_ONLY;
    act(() => view.result.current.gridProps.onFilterChanged());
    grid.filterModel = TCP_OR_UDP;
    act(() => view.result.current.gridProps.onFilterChanged());
    act(() => view.result.current.gridProps.onFilterChanged());

    expect(savedFilters()).toEqual([TCP_OR_UDP]);
  });

  it("saves nothing when a filter is cleared on a panel that was never filtered", () => {
    const grid = fakeGrid();
    const view = mount();
    ready(view, grid);

    act(() => view.result.current.gridProps.onFilterChanged());

    expect(host.setOptions).not.toHaveBeenCalled();
  });

  it("saves an empty model when a saved filter is cleared: cleared is a state, not an absence", () => {
    const grid = fakeGrid();
    const view = mount({ grid: { filterModel: TCP_ONLY } });
    ready(view, grid);

    grid.filterModel = {};
    act(() => view.result.current.gridProps.onFilterChanged());

    expect(savedFilters()).toEqual([{}]);
  });

  it("mounts a panel carrying a malformed grid blob, unfiltered", () => {
    const grid = fakeGrid();
    const view = mount({ grid: { filterModel: "everything" } });

    expect(() => ready(view, grid)).not.toThrow();
    expect(grid.setFilterModel).not.toHaveBeenCalled();
  });

  it("keeps the model it mounted with while the user edits", () => {
    const grid = fakeGrid();
    let options: Record<string, unknown> = { grid: { filterModel: TCP_ONLY } };
    const view = renderHook(() =>
      useGridPanelState<TestRow>({
        sessionId: "ws-1/panel-1",
        options,
        noRowsOverlay: NoRows,
        loadingOverlay: Loading,
      }),
    );
    ready(view, grid);

    options = { grid: { filterModel: TCP_OR_UDP } };
    view.rerender();
    const remounted = fakeGrid();
    ready(view, remounted);

    expect(remounted.setFilterModel).toHaveBeenCalledWith(TCP_ONLY);
  });
});

describe("resolveFilterModel", () => {
  it("returns the saved model, `{}` included", () => {
    expect(resolveFilterModel({ grid: { filterModel: TCP_ONLY } })).toEqual(TCP_ONLY);
    expect(resolveFilterModel({ grid: { filterModel: {} } })).toEqual({});
  });

  it.each([
    ["nothing saved", null],
    ["no grid bag", { fontSize: 14 }],
    ["a non-object grid bag", { grid: "everything" }],
    ["a non-object filter model", { grid: { filterModel: 7 } }],
    ["an array filter model", { grid: { filterModel: ["TCP"] } }],
    ["a filter model whose entries are not objects", { grid: { filterModel: { proto: "TCP" } } }],
  ])(
    "returns undefined for %s, so the panel mounts unfiltered instead of throwing",
    (_case, options) => {
      expect(resolveFilterModel(options)).toBeUndefined();
    },
  );
});

describe("the column layout, kept for the session", () => {
  const layout = (sourceWidth: number, hide = false): ColumnState[] => [
    {
      colId: "time",
      width: 120,
      flex: null,
      hide: false,
      pinned: "left",
      sort: "desc",
      sortIndex: 0,
    },
    {
      colId: "source",
      width: sourceWidth,
      flex: null,
      hide,
      pinned: null,
      sort: null,
      sortIndex: null,
    },
  ];
  const persisted = (sourceWidth: number) =>
    layout(sourceWidth).map((state) => {
      const rest = { ...state };
      delete rest.hide;
      return rest;
    });

  it("restores the layout the user has now when the grid remounts, not the one it mounted with", () => {
    const grid = fakeGrid();
    const view = mount();
    ready(view, grid);

    grid.columnState = layout(300);
    act(() =>
      view.result.current.gridProps.onColumnResized({
        finished: true,
      } as ColumnResizedEvent<TestRow>),
    );

    const remounted = fakeGrid();
    ready(view, remounted);

    expect(remounted.applyColumnState).toHaveBeenCalledWith({
      state: persisted(300),
      applyOrder: true,
    });
  });

  it("saves a resize or a move only once the drag finishes", () => {
    const grid = fakeGrid();
    const view = mount();
    ready(view, grid);

    grid.columnState = layout(300);
    act(() =>
      view.result.current.gridProps.onColumnResized({
        finished: false,
      } as ColumnResizedEvent<TestRow>),
    );
    expect(view.result.current.columnState).toBeNull();
  });

  it("saves the sort itself", () => {
    const grid = fakeGrid();
    const view = mount();
    ready(view, grid);

    grid.columnState = layout(120);
    act(() => view.result.current.gridProps.onSortChanged());

    expect(view.result.current.columnState?.find((state) => state.colId === "time")?.sort).toBe(
      "desc",
    );
  });

  // Visibility is a panel option driving `ColDef.hide`; a saved `hide` would fight it.
  it("never saves visibility, so a reload cannot hide or show a column", () => {
    const grid = fakeGrid();
    grid.columnState = layout(80, true);
    const first = mount();
    ready(first, grid);
    act(() => first.result.current.gridProps.onColumnVisible());
    expect(first.result.current.columnState?.every((state) => !("hide" in state))).toBe(true);
    first.unmount();

    const reloaded = fakeGrid();
    const second = mount();
    ready(second, reloaded);

    expect(reloaded.applyColumnState).toHaveBeenCalledWith({
      state: persisted(80),
      applyOrder: true,
    });
  });

  it("does not write back when only visibility changed", () => {
    const grid = fakeGrid();
    grid.columnState = layout(80);
    const view = mount();
    ready(view, grid);
    act(() => view.result.current.gridProps.onColumnVisible());
    const saved = view.result.current.columnState;

    grid.columnState = layout(80, true);
    act(() => view.result.current.gridProps.onColumnVisible());
    expect(view.result.current.columnState).toBe(saved);
  });

  it("keeps the search text across a reload, and each session's apart", () => {
    const first = mount();
    act(() =>
      first.result.current.search.onChange({
        target: { value: "dns" },
      } as ChangeEvent<HTMLInputElement>),
    );
    first.unmount();

    expect(mount().result.current.search.value).toBe("dns");
    expect(mount(null, "ws-2/panel-1").result.current.search.value).toBe("");
  });
});

describe("font size and row height", () => {
  it("defaults to 14 px, and derives the row height from it", () => {
    expect(mount().result.current.gridProps.rowHeight).toBe(24);
  });

  it("grows the rows with the panel's font size", () => {
    expect(mount({ fontSize: 20 }).result.current.gridProps.rowHeight).toBe(34);
  });

  it("grows the header with the font, and never shrinks it below the sort and filter glyphs", () => {
    expect(mount({ fontSize: 128 }).result.current.gridProps.headerHeight).toBe(218);
    expect(mount({ fontSize: 6 }).result.current.gridProps.headerHeight).toBe(32);
  });
});

describe("the grid's fixed configuration", () => {
  it("keeps columns it cannot bring back, the user's order, open popups and a reserved scrollbar", () => {
    const { gridProps } = mount().result.current;

    expect(gridProps.suppressDragLeaveHidesColumns).toBe(true);
    expect(gridProps.maintainColumnOrder).toBe(true);
    expect(gridProps.suppressScrollWhenPopupsAreOpen).toBe(true);
    expect(gridProps.alwaysShowHorizontalScroll).toBe(true);
  });

  it("sorts by Time only, and gives every column a text filter", () => {
    const { defaultColDef } = mount().result.current.gridProps;

    expect(defaultColDef.sortable).toBe(false);
    expect(defaultColDef.filter).toBe("agTextColumnFilter");
  });

  it("hands AG Grid the panel's own overlays, one identity across renders", () => {
    const view = mount();
    view.rerender();

    expect(view.result.current.gridProps.noRowsOverlayComponent).toBe(NoRows);
    expect(view.result.current.gridProps.loadingOverlayComponent).toBe(Loading);
  });

  it("hands the search box one object while the query is unchanged", () => {
    const view = mount();
    const search = view.result.current.search;
    view.rerender();
    expect(view.result.current.search).toBe(search);

    act(() => search.onChange({ target: { value: "dns" } } as ChangeEvent<HTMLInputElement>));
    expect(view.result.current.search.value).toBe("dns");
    expect(view.result.current.gridProps.quickFilterText).toBe("dns");

    act(() => view.result.current.search.onClear());
    expect(view.result.current.search.value).toBe("");
  });
});

describe("glob search", () => {
  const matcher = () => {
    const { quickFilterParser, quickFilterMatcher } = mount().result.current.gridProps;
    return (query: string, rowText: string) =>
      quickFilterMatcher(quickFilterParser(query), rowText);
  };

  it("matches a glob, or a plain word anywhere, with the whole query as one pattern", () => {
    const matches = matcher();

    expect(matches("*retry?2of*", "connection retry 2of5 failed")).toBe(true);
    expect(matches("*retry?2of*", "connection retried later")).toBe(false);
    expect(matches("retry", "connection retry 2of5 failed")).toBe(true);
    expect(matches("retry?2of", "connection retry 2of5 failed")).toBe(true);
    expect(matches("retry failed", "connection retry 2of5 failed")).toBe(false);
    expect(matches("retry 2of5", "connection retry 2of5 failed")).toBe(true);
  });

  it("matches case-insensitively, and treats regex characters as text", () => {
    const matches = matcher();

    expect(matches("*SYN*", "51514 → 443 [syn]")).toBe(true);
    expect(matches("*[syn]*", "51514 → 443 [SYN] Seq=0")).toBe(true);
    expect(matches("*a.b*", "axb")).toBe(false);
    expect(matches("*a.b*", "a.b")).toBe(true);
  });

  it("matches everything when the box is empty", () => {
    const { quickFilterParser } = mount().result.current.gridProps;

    expect(quickFilterParser("   ")).toEqual([]);
    expect(matcher()("   ", "anything at all")).toBe(true);
  });

  // AG Grid hands the matcher the row's searchable columns joined with newlines, and `?` cannot cross one.
  it("matches across the row's columns", () => {
    const matches = matcher();
    const row = ["10.0.0.5:5353", "8.8.8.8:53", "DNS query"].join("\n");

    expect(matches("*5353*", row)).toBe(true);
    expect(matches("*dns*", row)).toBe(true);
    expect(matches("*5353*8.8.8.8*dns*", row)).toBe(true);
    expect(matches("*53?8.8*", row)).toBe(true);
    expect(matches("*icmp*", row)).toBe(false);
  });
});
