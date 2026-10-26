import { act, renderHook } from "@testing-library/react";
import type { BodyScrollEvent, ColumnState, GridApi, IRowNode, RowClassParams } from "ag-grid-community";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeGrid } from "../grid/time-grid";

interface TestRow {
  readonly id: string;
  readonly timeS: number;
}

const ROW_HEIGHT = 24;
const VIEWPORT_HEIGHT = 240;

const host = vi.hoisted(() => ({
  time: null as { cursorS: number | null; playback: string } | null,
  workspace: { id: "ws-1", name: "Workspace", modeKind: "TRACE" },
  setCursor: vi.fn<(timeS: number) => Promise<void>>(),
}));

vi.mock("@zeloscloud/app-extension-sdk/react", () => ({
  useTimeState: () => host.time,
  useWorkspace: () => host.workspace,
  usePanelActions: () => ({ setCursor: host.setCursor }),
}));

/** Rows at 10, 20 and 30 seconds, ascending by time as the melt guarantees. */
const ROWS: TestRow[] = [
  { id: "a", timeS: 10 },
  { id: "b", timeS: 20 },
  { id: "c", timeS: 30 },
];

/** A grid stand-in with per-row geometry. */
const grid = {
  /** The displayed rows, in display order: a desc Time sort reverses them. */
  displayed: [] as TestRow[],
  viewport: { top: 0, bottom: VIEWPORT_HEIGHT },
  ensureIndexVisible: vi.fn<(index: number, position: string) => void>(),
  api: {} as GridApi<TestRow>,
};

const nodeAt = (index: number): IRowNode<TestRow> | undefined =>
  index < 0
    ? undefined
    : ({
        id: grid.displayed[index]?.id,
        rowIndex: index,
        rowTop: index * ROW_HEIGHT,
        rowHeight: ROW_HEIGHT,
      } as IRowNode<TestRow>);

grid.api = {
  isDestroyed: () => false,
  getRowNode: (id: string) => nodeAt(grid.displayed.findIndex((row) => row.id === id)),
  getDisplayedRowAtIndex: (index: number) => nodeAt(index),
  getDisplayedRowCount: () => grid.displayed.length,
  getVerticalPixelRange: () => grid.viewport,
  getRenderedNodes: () => grid.displayed.map((_, index) => nodeAt(index)),
  ensureIndexVisible: grid.ensureIndexVisible,
} as unknown as GridApi<TestRow>;

const getGridApi = () => grid.api;
const onError = vi.fn();

const sortedByTime = (sort: "asc" | "desc" | null): ColumnState[] => [
  { colId: "time", width: 200, flex: null, hide: false, pinned: "left", sort, sortIndex: sort ? 0 : null },
];

function mount(columnState: ColumnState[] | null = null, rows: readonly TestRow[] = ROWS) {
  return renderHook(
    (props: { rows: readonly TestRow[] }) =>
      useTimeGrid<TestRow>({
        sessionId: "ws-1/panel-1",
        rows: props.rows,
        getGridApi,
        columnState,
        rowHeight: ROW_HEIGHT,
        autoScroll: true,
        onError,
      }),
    { initialProps: { rows } },
  );
}

const scrollAway = (view: ReturnType<typeof mount>) => {
  grid.viewport = { top: 1_000, bottom: 1_000 + VIEWPORT_HEIGHT };
  act(() => view.result.current.gridEvents.onBodyScroll({ direction: "vertical" } as BodyScrollEvent<TestRow>));
};

beforeEach(() => {
  host.time = null;
  host.workspace = { id: "ws-1", name: "Workspace", modeKind: "TRACE" };
  host.setCursor.mockReset();
  host.setCursor.mockResolvedValue();
  onError.mockReset();
  grid.displayed = [...ROWS];
  grid.viewport = { top: 0, bottom: VIEWPORT_HEIGHT };
  grid.ensureIndexVisible.mockReset();
});

describe("the cursor row", () => {
  const markedRow = (): TestRow | undefined => {
    const [rule] = Object.values(mount().result.current.rowClassRules) as ((p: RowClassParams<TestRow>) => boolean)[];
    return ROWS.find((row) => rule?.({ data: row } as RowClassParams<TestRow>));
  };

  // The step-before rule a plot's crosshair reads values with, not the nearest row by distance.
  it.each([
    [10, "a"],
    [19.9, "a"],
    [20, "b"],
    [29, "b"],
    [1_000, "c"],
  ])("at t=%s is the last row at or before it (%s)", (cursorS, expected) => {
    host.time = { cursorS, playback: "PAUSED" };
    expect(markedRow()?.id).toBe(expected);
  });

  it("is nothing before the first row, and nothing at all without a cursor", () => {
    host.time = { cursorS: 5, playback: "PAUSED" };
    expect(markedRow()).toBeUndefined();

    host.time = { cursorS: null, playback: "PAUSED" };
    expect(markedRow()).toBeUndefined();
  });

  it("marks exactly that row, and no other", () => {
    host.time = { cursorS: 25, playback: "PAUSED" };
    const [rule] = Object.values(mount().result.current.rowClassRules) as ((p: RowClassParams<TestRow>) => boolean)[];

    expect(rule?.({ data: ROWS[1] } as RowClassParams<TestRow>)).toBe(true);
    expect(rule?.({ data: ROWS[2] } as RowClassParams<TestRow>)).toBe(false);
  });
});

describe("onSetCursor", () => {
  it("moves the host cursor to the row's instant", () => {
    const { result } = mount();
    act(() => result.current.onSetCursor(42));

    expect(host.setCursor).toHaveBeenCalledWith(42);
  });

  it("reports a cursor move the host refuses", async () => {
    const refusal = new Error("no data range yet");
    host.setCursor.mockRejectedValue(refusal);
    const { result } = mount();
    act(() => result.current.onSetCursor(42));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("Couldn't set the cursor", refusal));
  });
});

describe("follow composition", () => {
  it("follows a live tail at whichever end the Time sort puts it, and jumps back there", () => {
    host.workspace = { ...host.workspace, modeKind: "LIVE" };
    host.time = { cursorS: null, playback: "LIVE" };
    const view = mount(sortedByTime("desc"));
    act(() => view.result.current.gridEvents.onFirstDataRendered());
    grid.ensureIndexVisible.mockClear();

    // The newest row arrives; a desc Time sort displays it first.
    const grown = [...ROWS, { id: "d", timeS: 40 }];
    grid.displayed = [...grown].reverse();
    act(() => view.rerender({ rows: grown }));
    act(() => view.result.current.gridEvents.onModelUpdated());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(0, "bottom");

    scrollAway(view);
    expect(view.result.current.follow?.label).toBe("Jump to latest");

    grid.ensureIndexVisible.mockClear();
    act(() => view.result.current.follow?.onClick());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(0, "bottom");
  });

  it("holds a pinned cursor ahead of the live tail", () => {
    host.workspace = { ...host.workspace, modeKind: "LIVE" };
    host.time = { cursorS: 10, playback: "PAUSED" };
    const view = mount(sortedByTime("asc"));
    act(() => view.result.current.gridEvents.onFirstDataRendered());
    grid.ensureIndexVisible.mockClear();

    const grown = [...ROWS, { id: "d", timeS: 40 }];
    grid.displayed = grown;
    act(() => view.rerender({ rows: grown }));
    act(() => view.result.current.gridEvents.onModelUpdated());
    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();

    scrollAway(view);
    expect(view.result.current.follow?.label).toBe("Jump to cursor");

    act(() => view.result.current.follow?.onClick());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(0, "middle");
  });

  it("leaves a trace window where it is, with nothing to jump to without a cursor", () => {
    const view = mount(sortedByTime("asc"));
    act(() => view.result.current.gridEvents.onFirstDataRendered());

    const grown = [...ROWS, { id: "d", timeS: 40 }];
    grid.displayed = grown;
    act(() => view.rerender({ rows: grown }));
    act(() => view.result.current.gridEvents.onModelUpdated());
    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();

    scrollAway(view);
    expect(view.result.current.follow).toBeUndefined();
  });

  it("does not follow the tail of a live workspace that is paused", () => {
    host.workspace = { ...host.workspace, modeKind: "LIVE" };
    host.time = { cursorS: null, playback: "PAUSED" };
    const view = mount(sortedByTime("asc"));
    act(() => view.result.current.gridEvents.onFirstDataRendered());

    scrollAway(view);
    expect(view.result.current.follow).toBeUndefined();
  });
});
