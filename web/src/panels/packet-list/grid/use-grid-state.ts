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
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // AG Grid closes an open filter popup on every `bodyScroll`, and a live panel scrolls its body each
  // poll to chase the tail, so the popup would snap shut the moment it opened.
  suppressScrollWhenPopupsAreOpen: true,
} as const;

const MIN_HEADER_HEIGHT = 32;

/** One GLOB, not AG Grid's space-split words: the whole text is the pattern `quickFilterMatcher` takes. */
const quickFilterParser = (quickFilter: string): string[] => {
  const pattern = quickFilter.trim();
  return pattern ? [pattern] : [];
};

/** A filter popup fires one `filterChanged` per checkbox; each write reaches the layout. */
const FILTER_PERSIST_DEBOUNCE_MS = 250;

/**
 * A time-ordered grid sorts by Time only: its rows are a sequence, so per-column sort is off and
 * `gridTimeColumnDef` re-enables it on itself. Every column gets AG Grid's built-in text filter.
 */
const TIME_ORDERED_COL_DEF: ColDef = { resizable: true, sortable: false, filter: "agTextColumnFilter" };

// ── Font size ────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_GRID_FONT_PX = 14;
const MIN_FONT_PX = 6;
const MAX_FONT_PX = 128;

/** The stored `fontSize` option in px, clamped, or the grid default when unset. */
function resolveGridFontSize(options: Record<string, unknown> | null | undefined): number {
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

/**
 * The filter model persisted under `options.grid.filterModel`, or undefined when nothing usable is
 * there. AG Grid's `setFilterModel` is unguarded, so the shape is checked one level deep first; `{}` (every
 * filter cleared) is a real state and round-trips.
 */
function resolveFilterModel(options: Record<string, unknown> | null | undefined): FilterModel | undefined {
  const grid = options?.grid;
  if (!isPlainObject(grid)) return undefined;
  const model = grid.filterModel;
  return isPlainObject(model) && Object.values(model).every(isPlainObject) ? (model as FilterModel) : undefined;
}

/**
 * The persisted fields. `hide` is excluded: visibility is a panel OPTION driving `ColDef.hide`, and a
 * persisted `hide` would fight it. Excluding it also lets stored state compare equal to
 * `getColumnState()`, so a visibility change can't loop back into a write.
 */
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
  return a.length === b.length && a.every((state, i) => b[i] !== undefined && sameState(state, b[i]));
}

function persistableColumnState(columnState: ColumnState[]): ColumnState[] {
  return columnState.map(({ hide: _hide, ...rest }) => rest);
}

/**
 * Resolve a right-clicked row id against the latest rows. Scans on demand rather than indexing: live rows
 * are replaced wholesale several times a second, for a lookup that only fires on right-click.
 */
export function useGridRowLookup<TRow extends { id: string }>(rows: readonly TRow[]): (rowId: string) => TRow | null {
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  return useCallback((rowId: string) => rowsRef.current.find((row) => row.id === rowId) ?? null, []);
}

/** A debounced call with a `flush`, so the last write inside the window survives an unmount. */
function useDebounced<A>(fn: (arg: A) => void, delayMs: number): { call: (arg: A) => void; flush: () => void } {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pending = useRef<{ arg: A; timer: ReturnType<typeof setTimeout> } | null>(null);
  return useMemo(() => {
    const flush = () => {
      const current = pending.current;
      if (!current) return;
      clearTimeout(current.timer);
      pending.current = null;
      fnRef.current(current.arg);
    };
    const call = (arg: A) => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = { arg, timer: setTimeout(flush, delayMs) };
    };
    return { call, flush };
  }, [delayMs]);
}

const NO_OPTION_DEFAULTS: Record<string, unknown> = {};

/**
 * Everything the grid is, minus its rows: the api handle, theme and font, row height, search, and the
 * filter and column-state round-trips.
 *
 * The quick-filter text and column layout are session state (they survive the frame reloading on a tab
 * switch); the filter model is layout state, saved with the panel's options.
 */
export function useGridPanelState<TRow extends { id: string }>({
  instanceId,
  options,
  noRowsOverlay,
  loadingOverlay,
}: {
  instanceId: string;
  options: Record<string, unknown> | null;
  /** Module-scope components: AG Grid takes an overlay by identity and would remount a fresh one per render. */
  noRowsOverlay: () => ReactNode;
  loadingOverlay: () => ReactNode;
}) {
  const theme = useTheme();
  const [, setOptions] = usePanelOptions(NO_OPTION_DEFAULTS);
  const gridApiRef = useRef<GridApi<TRow> | null>(null);

  const searchKey = sessionKey(instanceId, "search");
  const columnsKey = sessionKey(instanceId, "columns");
  const [quickFilterText, setQuickFilterText] = useState(() => readSession<string>(searchKey) ?? "");
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

  // Snapshotted at MOUNT: re-applying the options whenever they changed would fight the filter the user
  // is editing, since every edit writes the bag it would read back.
  const [initialFilterModel] = useState(() => resolveFilterModel(options));

  // The column layout is read LIVE: AgGridReact can remount inside a living panel and fires `gridReady`
  // again, where a mount-time snapshot would drop every width and sort set since.
  const columnStateRef = useRef(columnState);
  columnStateRef.current = columnState;

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

  const persistFilterModel = useDebounced((filterModel: FilterModel) => {
    setOptions({ grid: { filterModel } }).catch((error: unknown) => {
      console.warn("[packet-list] could not save the grid filter", error);
    });
  }, FILTER_PERSIST_DEBOUNCE_MS);

  // The frame unloads on a tab switch; without this the last filter click inside the window is lost.
  useEffect(() => () => persistFilterModel.flush(), [persistFilterModel]);

  // AG Grid re-fires `filterChanged` for the model applied at mount; compare against the last model SEEN,
  // seeded with `{}` (an unfiltered grid), so a no-op event writes nothing.
  const lastFilterModelRef = useRef<string | undefined>(undefined);
  lastFilterModelRef.current ??= JSON.stringify(initialFilterModel ?? {});

  const onFilterChanged = useCallback(() => {
    const api = getGridApi();
    if (!api) return;
    const next = api.getFilterModel();
    const nextJson = JSON.stringify(next);
    if (nextJson === lastFilterModelRef.current) return;
    lastFilterModelRef.current = nextJson;
    persistFilterModel.call(next);
  }, [getGridApi, persistFilterModel]);

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
