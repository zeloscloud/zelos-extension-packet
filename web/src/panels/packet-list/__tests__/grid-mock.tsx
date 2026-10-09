import { type ComponentType, useEffect, useReducer, useRef } from "react";
import { vi } from "vitest";

/*
 * `ag-grid-react`, flattened to the props it was handed plus a minimal DOM driven by the panel's REAL
 * columnDefs, rowData and external filter, so the suites exercise the panel's own column building,
 * formatting, filtering and cell rendering. A real grid needs layout APIs happy-dom doesn't provide.
 *
 * The `ag-row` / `ag-cell` markers and their `row-id` / `col-id` attributes are the contract the panel's
 * context menu resolves a right-click through (it reads the DOM), so the fake emits them.
 *
 *   vi.mock("ag-grid-react", async () => (await import("./grid-mock")).mockAgGrid());
 */

interface MockRow {
  id: string;
}

interface MockColDef {
  colId?: string;
  headerName?: string;
  hide?: boolean;
  valueGetter?: (params: { data: MockRow }) => unknown;
  valueFormatter?: (params: { data: MockRow; value: unknown }) => string;
  cellRenderer?: ComponentType<Record<string, unknown>>;
}

interface MockGridProps {
  columnDefs: MockColDef[];
  rowData: MockRow[];
  onGridReady?: (event: { api: unknown }) => void;
  onModelUpdated?: (event: { api: unknown }) => void;
  onRowClicked?: (event: { data: MockRow }) => void;
  isExternalFilterPresent?: () => boolean;
  doesExternalFilterPass?: (node: { data: MockRow }) => boolean;
}

export function mockAgGrid() {
  const AgGridReact = (props: MockGridProps) => {
    const [, refilter] = useReducer((n: number) => n + 1, 0);

    const filtering = props.isExternalFilterPresent?.() ?? false;
    const shown = filtering ? props.rowData.filter((data) => props.doesExternalFilterPass?.({ data }) ?? true) : props.rowData;
    const shownRef = useRef(shown);
    shownRef.current = shown;

    const apiRef = useRef<Record<string, unknown> | null>(null);
    if (apiRef.current === null) {
      apiRef.current = {
        isDestroyed: () => false,
        getDisplayedRowCount: () => shownRef.current.length,
        getDisplayedRowAtIndex: (index: number) => {
          const data = shownRef.current[index];
          return data ? { id: data.id, rowIndex: index, rowTop: null } : undefined;
        },
        getRowNode: (id: string) => {
          const index = shownRef.current.findIndex((row) => row.id === id);
          return { id, rowIndex: index >= 0 ? index : null, rowTop: null, setSelected: vi.fn() };
        },
        getVerticalPixelRange: () => ({ top: 0, bottom: 320 }),
        getRenderedNodes: () => [],
        ensureIndexVisible: vi.fn(),
        deselectAll: vi.fn(),
        onFilterChanged: () => refilter(),
        setFilterModel: vi.fn(),
        getFilterModel: () => ({}),
        applyColumnState: vi.fn(),
        getColumnState: () => [],
      };
    }
    const api = apiRef.current;

    useEffect(() => {
      props.onGridReady?.({ api });
      // Once, as AG Grid does.
    }, []);

    const shownKey = shown.map((row) => row.id).join("\u0000");
    useEffect(() => {
      props.onModelUpdated?.({ api });
      // The model changes when the displayed rows do.
    }, [shownKey]);

    const columns = props.columnDefs.filter((column) => !column.hide);
    return (
      <div data-testid="mock-grid">
        {columns.map((column) => (
          <span key={column.colId} data-testid="header">
            {column.headerName}
          </span>
        ))}
        {shown.map((row) => (
          <div
            key={row.id}
            data-testid="row"
            className="ag-row"
            row-id={row.id}
            onClick={() => props.onRowClicked?.({ data: row })}
          >
            {columns.map((column) => {
              const value = column.valueGetter?.({ data: row });
              const valueFormatted = column.valueFormatter ? column.valueFormatter({ data: row, value }) : null;
              const Cell = column.cellRenderer;
              return (
                <span key={column.colId} data-testid="cell" className="ag-cell" col-id={column.colId}>
                  {Cell ? <Cell data={row} value={value} valueFormatted={valueFormatted} /> : String(value ?? "")}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    );
  };
  return { AgGridReact };
}

/** The cell a suite right-clicks: the same `.ag-cell[col-id]` inside `.ag-row` a real grid renders. */
export function gridCell(colId: string, rowIndex: number): HTMLElement {
  const cell = document.querySelectorAll(".ag-row")[rowIndex]?.querySelector(`.ag-cell[col-id="${colId}"]`);
  if (!(cell instanceof HTMLElement)) throw new Error(`no ${colId} cell in row ${rowIndex}`);
  return cell;
}
