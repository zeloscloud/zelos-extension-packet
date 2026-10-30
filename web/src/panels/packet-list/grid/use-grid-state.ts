import { usePanelOptions, useTheme } from "@zeloscloud/app-extension-sdk/react";
import type {
  ColDef,
  ColumnMovedEvent,
  ColumnResizedEvent,
  ColumnState,
  FilterModel,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
} from "ag-grid-community";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { readSession, sessionKey, writeSession } from "./session";
import { createSearchMatcher } from "./search";
import { AG_GRID_THEME_DARK, AG_GRID_THEME_LIGHT } from "./theme";

ModuleRegistry.registerModules([AllCommunityModule]);

const GRID_PANEL_PROPS = {
  animateRows: false,
  suppressAnimationFrame: true,
  suppressCellFocus: true,
  enableCellTextSelection: true,
  cacheQuickFilter: true,
  // Community has no columns tool panel, so a column dragged off the grid couldn't be brought back.
  suppressDragLeaveHidesColumns: true,
  // Keep the user's column order when the column defs change.
  maintainColumnOrder: true,
  // A bar that appears later covers a row already pinned to the bottom.
  alwaysShowHorizontalScroll: true,
  // AG Grid closes a filter popup on every body scroll, and a live tail scrolls each poll.
  suppressScrollWhenPopupsAreOpen: true,
} as const;

const MIN_HEADER_HEIGHT = 32;

/** One GLOB, not AG Grid's space-split words: the whole text is the pattern `quickFilterMatcher` takes. */
const quickFilterParser = (quickFilter: string): string[] => {
  const pattern = quickFilter.trim();
  return pattern ? [pattern] : [];
};

/** No per-column sort, since the rows are a sequence; the Time column turns it back on for itself. */
const TIME_ORDERED_COL_DEF: ColDef = {
  resizable: true,
  sortable: false,
  filter: "agTextColumnFilter",
};

// ── Font size ────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_GRID_FONT_PX = 14;
const MIN_FONT_PX = 6;
const MAX_FONT_PX = 128;

/** The stored `fontSize` option in px, clamped, or the grid default when unset. */
export function resolveGridFontSize(options: Record<string, unknown> | null | undefined): number {
  const value = options?.fontSize;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round(value)));
  }
  return DEFAULT_GRID_FONT_PX;
}

/** One row's height at a font size: text plus padding, floored above the sort and filter glyphs. */
function gridRowHeight(fontSizePx: number): number {
  return Math.max(16, Math.round(fontSizePx * 1.7));
}

// ── Persisted grid state ─────────────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The saved `options.grid.filterModel`, checked a level deep since `setFilterModel` is unguarded; `{}` is a state. */
export function resolveFilterModel(
  options: Record<string, unknown> | null | undefined,
): FilterModel | undefined {
  const grid = options?.grid;
  if (!isPlainObject(grid)) return undefined;
  const model = grid.filterModel;
  return isPlainObject(model) && Object.values(model).every(isPlainObject)
    ? (model as FilterModel)
    : undefined;
}

/** Without `hide`: visibility is a panel option, and a saved `hide` would fight it and loop back into writes. */
function sameState(a: ColumnState, b: ColumnState): boolean {
  return (
    a.colId === b.colId &&
    a.width === b.width &&
    a.flex === b.flex &&
    a.pinned === b.pinned &&
    a.sort === b.sort &&
    a.sortIndex === b.sortIndex
  );
}

function columnStatesEqual(a: readonly ColumnState[], b: readonly ColumnState[]): boolean {
  return (
    a.length === b.length && a.every((state, i) => b[i] !== undefined && sameState(state, b[i]))
  );
}

function persistableColumnState(columnState: ColumnState[]): ColumnState[] {
  return columnState.map((state) => {
    const persisted = { ...state };
    delete persisted.hide;
    return persisted;
  });
}

/** A right-clicked row id against the latest rows, scanned on demand: live rows are replaced several times a second. */
export function useGridRowLookup<TRow extends { id: string }>(
  rows: readonly TRow[],
): (rowId: string) => TRow | null {
  const rowsRef = useRef(rows);
  useInsertionEffect(() => {
    rowsRef.current = rows;
  });
  return useCallback(
    (rowId: string) => rowsRef.current.find((row) => row.id === rowId) ?? null,
    [],
  );
}

const NO_OPTION_DEFAULTS: Record<string, unknown> = {};

/** The grid minus its rows; search and column layout are kept for the session, the filter model in the layout. */
export function useGridPanelState<TRow extends { id: string }>({
  sessionId,
  options,
  noRowsOverlay,
  loadingOverlay,
}: {
  /** What the session state is kept under: the workspace and the panel instance. */
  sessionId: string;
  options: Record<string, unknown> | null;
  /** Module-scope components: AG Grid takes an overlay by identity and would remount a fresh one per render. */
  noRowsOverlay: () => ReactNode;
  loadingOverlay: () => ReactNode;
}) {
  const theme = useTheme();
  const [, setOptions] = usePanelOptions(NO_OPTION_DEFAULTS);
  const gridApiRef = useRef<GridApi<TRow> | null>(null);

  const searchKey = sessionKey(sessionId, "search");
  const columnsKey = sessionKey(sessionId, "columns");
  const [quickFilterText, setQuickFilterText] = useState(
    () => readSession<string>(searchKey) ?? "",
  );
  const [columnState, setColumnState] = useState(() => readSession<ColumnState[]>(columnsKey));

  useEffect(() => writeSession(searchKey, quickFilterText || null), [searchKey, quickFilterText]);
  useEffect(() => writeSession(columnsKey, columnState), [columnsKey, columnState]);

  const getGridApi = useCallback(() => {
    const api = gridApiRef.current;
    return api && !api.isDestroyed() ? api : null;
  }, []);

  const getRowId = useCallback((params: GetRowIdParams<TRow>) => params.data.id, []);

  // Font size drives the THEME, not a per-cell style: AG Grid sizes its own chrome from the theme.
  const fontSize = resolveGridFontSize(options);
  const baseTheme = theme?.resolvedDark ? AG_GRID_THEME_DARK : AG_GRID_THEME_LIGHT;
  const gridTheme = useMemo(() => baseTheme.withParams({ fontSize }), [baseTheme, fontSize]);

  // At mount only: every edit writes the options back, so re-applying them would fight the user's edit.
  const [initialFilterModel] = useState(() => resolveFilterModel(options));

  // Read live: a grid remounting inside the panel fires `gridReady` again and must get the current layout.
  const columnStateRef = useRef(columnState);
  useInsertionEffect(() => {
    columnStateRef.current = columnState;
  });

  const onGridReady = useCallback(
    (event: GridReadyEvent<TRow>) => {
      gridApiRef.current = event.api;
      if (initialFilterModel) event.api.setFilterModel(initialFilterModel);
      // `applyOrder` restores the column order too. Visibility is left to `ColDef.hide`.
      const stored = columnStateRef.current;
      if (stored) event.api.applyColumnState({ state: stored, applyOrder: true });
    },
    [initialFilterModel],
  );

  // The last model seen, seeded from the restored one, so AG Grid's echo of it or any no-op writes nothing.
  const lastFilterModelRef = useRef<string | undefined>(undefined);
  lastFilterModelRef.current ??= JSON.stringify(initialFilterModel ?? {});

  const onFilterChanged = useCallback(() => {
    const api = getGridApi();
    if (!api) return;
    const next = api.getFilterModel();
    const nextJson = JSON.stringify(next);
    if (nextJson === lastFilterModelRef.current) return;
    lastFilterModelRef.current = nextJson;
    // At once: the frame unloads on a tab switch and runs no cleanup, so a deferred write would be lost.
    setOptions({ grid: { filterModel: next } }).catch((error: unknown) => {
      console.warn("[packet-list] could not save the grid filter", error);
    });
  }, [getGridApi, setOptions]);

  const persistColumnState = useCallback(() => {
    const api = getGridApi();
    if (!api) return;
    const next = persistableColumnState(api.getColumnState());
    setColumnState((prev) => (prev && columnStatesEqual(prev, next) ? prev : next));
  }, [getGridApi]);

  // A resize or move emits an event per mouse move; only the last carries `finished`.
  const onColumnDragFinished = useCallback(
    (event: ColumnResizedEvent<TRow> | ColumnMovedEvent<TRow>) => {
      if (event.finished) persistColumnState();
    },
    [persistColumnState],
  );

  const search = useMemo(
    () => ({
      value: quickFilterText,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setQuickFilterText(event.target.value),
      onClear: () => setQuickFilterText(""),
    }),
    [quickFilterText],
  );

  // The matcher runs once per ROW, so hold the compiled pattern.
  const compiled = useRef<{ pattern: string; matcher: (text: string) => boolean } | null>(null);
  const quickFilterMatcher = useCallback((quickFilterParts: string[], rowText: string) => {
    const pattern = quickFilterParts[0];
    if (pattern === undefined) return true;
    if (compiled.current?.pattern !== pattern) {
      compiled.current = { pattern, matcher: createSearchMatcher(pattern) };
    }
    // AG Grid joins the row's searchable columns with NEWLINES; a glob's `.` can't cross one.
    return compiled.current.matcher(rowText.replace(/\n/g, " "));
  }, []);

  const rowHeight = gridRowHeight(fontSize);

  return {
    search,
    getGridApi,
    /** Persisted column state, sort included. Derive the sort from it; never mirror it. */
    columnState,
    gridProps: {
      ...GRID_PANEL_PROPS,
      theme: gridTheme,
      rowHeight,
      headerHeight: Math.max(MIN_HEADER_HEIGHT, rowHeight),
      defaultColDef: TIME_ORDERED_COL_DEF,
      noRowsOverlayComponent: noRowsOverlay,
      loadingOverlayComponent: loadingOverlay,
      getRowId,
      quickFilterText,
      quickFilterParser,
      quickFilterMatcher,
      onGridReady,
      onFilterChanged,
      onSortChanged: persistColumnState,
      onColumnResized: onColumnDragFinished,
      onColumnMoved: onColumnDragFinished,
      onColumnVisible: persistColumnState,
      onColumnPinned: persistColumnState,
    },
  };
}
