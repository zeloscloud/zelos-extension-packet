import type { ICellRendererParams } from "ag-grid-community";
import {
  type ChangeEvent,
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";
import { ClearIcon, ErrorIcon, PacketListIcon, SearchIcon } from "../icon";
import { extractHighlightTerms, Highlight } from "./search";

/**
 * Search terms for cell highlighting. Context rather than ColDefs: republishing ColDefs on every
 * keystroke would rebuild the whole column pipeline, while a context update only repaints custom cells.
 */
const GridSearchContext = createContext<string[]>([]);

function useGridSearchTerms(): string[] {
  return useContext(GridSearchContext);
}

/** An icon and a line of text, centered in the panel: the empty, loading and explanatory states. */
export function PanelState({ description }: { description: string }): ReactNode {
  return (
    <div className="panel-state" role="status">
      <PacketListIcon className="panel-state-icon" />
      <p>{description}</p>
    </div>
  );
}

function PanelErrorState({ message }: { message: string }): ReactNode {
  return (
    <div className="panel-state error" role="alert">
      <ErrorIcon />
      <p>{message}</p>
    </div>
  );
}

/** Quick-filter header: the app's search box, a magnifier, the field, and a clear button once there is text. */
function GridPanelSearch({
  value,
  onChange,
  onClear,
  inputRef,
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  /** So {@link GridPanelBody} can point Cmd+F at it. */
  inputRef: Ref<HTMLInputElement>;
}) {
  return (
    <div className="grid-search">
      <label className="search-box">
        <SearchIcon />
        <input ref={inputRef} type="text" placeholder="Search..." aria-label="Search" value={value} onChange={onChange} />
        {value.length > 0 && (
          <button type="button" className="ghost-button" aria-label="Clear search" title="Clear search" onClick={onClear}>
            <ClearIcon />
          </button>
        )}
      </label>
    </div>
  );
}

/**
 * A grid panel's frame: error state, search box, the body the grid fills, the follow button that floats
 * over it, and a footer. `min-height: 0` on the body is load-bearing: without it the grid can't shrink
 * and overflows the panel.
 */
export function GridPanelBody({
  error,
  search,
  toolbar,
  follow,
  footer,
  children,
}: {
  error: string | null;
  search: {
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onClear: () => void;
  };
  /** A row under the search box: the display filter. Search stays the plain substring box. */
  toolbar?: ReactNode | undefined;
  follow?: { label: string; onClick: () => void } | undefined;
  /** The status-bar slot; a panel with nothing to say passes nothing. */
  footer?: ReactNode | undefined;
  children: ReactNode;
}): ReactNode {
  const searchRef = useRef<HTMLInputElement>(null);

  // Cmd+F focuses the search while focus is inside the panel.
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
    }
  }, []);

  const terms = useMemo(() => extractHighlightTerms(search.value), [search.value]);

  if (error) return <PanelErrorState message={error} />;

  return (
    // tabIndex makes any click in the panel count as focus, so Cmd+F and Escape reach it after a click.
    <div className="grid-panel" tabIndex={-1} onKeyDown={handleKeyDown} data-grid-panel="">
      <GridPanelSearch inputRef={searchRef} value={search.value} onChange={search.onChange} onClear={search.onClear} />
      {toolbar}
      <div className="grid-panel-body">
        <GridSearchContext.Provider value={terms}>{children}</GridSearchContext.Provider>
        {follow && (
          <button type="button" className="follow-button" onClick={follow.onClick}>
            <span className="follow-arrow">↓</span>
            {follow.label}
          </button>
        )}
      </div>
      {footer}
    </div>
  );
}

/** The status bar under a grid: one line, its parts separated by `·`. Nothing to say renders nothing. */
export function GridStatusStrip({ testId, parts }: { testId: string; parts: readonly ReactNode[] }): ReactNode {
  const shown = parts.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className="status-strip" data-testid={testId}>
      {shown.flatMap((part, index) => (index === 0 ? [part] : [" · ", part]))}
    </div>
  );
}

/**
 * The window held more rows than the panel asked for, so what is on screen is its newest slice. Said in
 * the panel's own chrome rather than inferred from a row that never appears.
 */
export function windowStatus(shown: number, total: number): string | null {
  if (total <= shown) return null;
  return `window: newest ${shown.toLocaleString()} of ${total.toLocaleString()} rows`;
}

/**
 * A grid cell's content, with search terms highlighted. role/tabIndex compensate for `suppressCellFocus`,
 * so keyboard users can still reach the cell's context menu.
 */
export function GridCell({
  className,
  children,
  style,
}: {
  className?: string | undefined;
  children: ReactNode;
  style?: CSSProperties | undefined;
}) {
  const terms = useGridSearchTerms();
  return (
    <div
      className={className ? `grid-cell ${className}` : "grid-cell"}
      style={style}
      tabIndex={0}
      role="button"
      aria-haspopup="menu"
    >
      {/* Its own box, so overflowing text ends in an ellipsis instead of clipping mid-glyph. */}
      <span className="cell-text">
        {typeof children === "string" ? <Highlight text={children} terms={terms} /> : children}
      </span>
    </div>
  );
}

/** `cellClass` for a VALUE column: monospace with tabular figures, so numbers and times line up. */
export const MONO_VALUE_CELL = "mono-cell";

/** A column whose cell is just its text. */
export const GridTextCell = memo((props: ICellRendererParams) => {
  const { data, value, valueFormatted } = props;
  if (!data) return null;
  return <GridCell>{valueFormatted ?? (value == null ? "" : String(value))}</GridCell>;
});
GridTextCell.displayName = "GridTextCell";

/** The cell a right-click landed on; `text` is what it showed on screen at that moment. */
export interface GridMenuCell {
  readonly colId: string;
  readonly rowId: string;
  readonly text: string;
}

/**
 * The grid's cell context menu, resolved on the grid wrapper rather than inside the cells. AG Grid
 * recycles rows (a live window scrolls them out from under the pointer constantly), so the clicked cell
 * is resolved into a snapshot first; the host then draws the menu, which can outlive the row.
 */
export function GridContextMenu<T>({
  resolveTarget,
  onOpen,
  children,
}: {
  /** The clicked cell → what its menu needs; null where there is no menu (a header, empty space). */
  resolveTarget: (cell: GridMenuCell) => T | null;
  /** `point` is in panel-document coordinates, which is what the host menu takes. */
  onOpen: (target: T, point: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const cell = element?.closest(".ag-cell");
      const colId = cell?.getAttribute("col-id");
      const rowId = cell?.closest(".ag-row")?.getAttribute("row-id");
      // No browser menu inside the grid, on a cell or off one (a header, the space below the rows).
      event.preventDefault();
      if (!cell || !colId || !rowId) return;
      // Read the text on screen now, so "Copy value" can't drift from what was right-clicked.
      const target = resolveTarget({ colId, rowId, text: cell.textContent?.trim() ?? "" });
      if (target !== null) onOpen(target, { x: event.clientX, y: event.clientY });
    },
    [resolveTarget, onOpen],
  );

  return (
    <div className="grid-host" onContextMenu={handleContextMenu}>
      {children}
    </div>
  );
}
