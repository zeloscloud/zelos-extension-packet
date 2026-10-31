import { act, renderHook } from "@testing-library/react";
import type { BodyScrollEvent, GridApi, IRowNode } from "ag-grid-community";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGridFollow } from "../grid/follow";

interface Row {
  id: string;
}

const ROW_HEIGHT = 24;
const VIEWPORT_HEIGHT = 240;

/** A grid stand-in that lays rows out at a fixed height and reports the scroll window it was left at. */
const grid = {
  rows: [] as string[],
  viewport: { top: 0, bottom: VIEWPORT_HEIGHT },
  ensureIndexVisible: vi.fn<(index: number, position: string) => void>(),
  api: {} as GridApi<Row>,
};

function nodeOf(id: string): IRowNode<Row> | undefined {
  const rowIndex = grid.rows.indexOf(id);
  if (rowIndex < 0) return undefined;
  return { id, rowIndex, rowTop: rowIndex * ROW_HEIGHT, rowHeight: ROW_HEIGHT } as IRowNode<Row>;
}

grid.api = {
  getVerticalPixelRange: () => grid.viewport,
  getDisplayedRowCount: () => grid.rows.length,
  getDisplayedRowAtIndex: (index: number) => {
    const id = grid.rows[index];
    return id === undefined ? undefined : nodeOf(id);
  },
  getRowNode: nodeOf,
  getRenderedNodes: () => grid.rows.map((id) => nodeOf(id)),
  ensureIndexVisible: grid.ensureIndexVisible,
} as unknown as GridApi<Row>;

/** Park the viewport at the content's end, as the browser clamps a scroll past it. */
function scrollToEnd() {
  const content = grid.rows.length * ROW_HEIGHT;
  const top = Math.max(0, content - VIEWPORT_HEIGHT);
  grid.viewport = { top, bottom: top + VIEWPORT_HEIGHT };
}

const ids = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `p${from + i}`);

function renderFollow(newestRowId: string) {
  const options = {
    sessionId: "ws-1/panel-1",
    getGridApi: () => grid.api,
    cursorRowId: undefined,
    newestRowId,
    followsTail: true,
    tailOrder: "asc" as const,
    rowHeight: ROW_HEIGHT,
  };
  const hook = renderHook((props: typeof options) => useGridFollow<Row>(props), {
    initialProps: options,
  });
  act(() => hook.result.current.gridEvents.onFirstDataRendered());
  return { ...hook, options };
}

const bodyScroll = { direction: "vertical" } as BodyScrollEvent<Row>;

beforeEach(() => {
  sessionStorage.clear();
  grid.rows = ids(0, 40);
  grid.viewport = { top: 0, bottom: VIEWPORT_HEIGHT };
  grid.ensureIndexVisible.mockReset();
  grid.ensureIndexVisible.mockImplementation(scrollToEnd);
});

describe("useGridFollow", () => {
  // A busy live window rotates past more rows than the viewport holds in one update: the browser clamps to
  // the new end, and AG Grid reports that clamp before the chase re-pins. The newest row is on screen.
  it("keeps following when the window rotates past its pin in one update", () => {
    const { result, rerender, options } = renderFollow("p39");
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.rows = ids(25, 60);
      scrollToEnd();
    });
    rerender({ ...options, newestRowId: "p59" });
    act(() => result.current.gridEvents.onBodyScroll(bodyScroll));

    expect(result.current.follow).toBeUndefined();
  });

  it("keeps following when the pinned row leaves the window in one update", () => {
    const { result, rerender, options } = renderFollow("p39");
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.rows = ids(100, 140);
      grid.viewport = { top: 200, bottom: 200 + VIEWPORT_HEIGHT };
    });
    rerender({ ...options, newestRowId: "p139" });
    act(() => result.current.gridEvents.onBodyScroll(bodyScroll));
    expect(result.current.follow).toBeUndefined();

    act(() => result.current.gridEvents.onModelUpdated());
    expect(grid.ensureIndexVisible).toHaveBeenLastCalledWith(39, "bottom");
  });

  it("keeps following while rows rotate under an unmoved viewport", () => {
    const { result, rerender, options } = renderFollow("p39");
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.rows = ids(20, 60);
    });
    rerender({ ...options, newestRowId: "p59" });
    act(() => result.current.gridEvents.onBodyScroll(bodyScroll));

    expect(result.current.follow).toBeUndefined();
  });

  it("does not read a late report of an earlier chase as the reader leaving", () => {
    const { result, rerender, options } = renderFollow("p39");
    act(() => result.current.gridEvents.onModelUpdated());
    const firstTop = grid.viewport.top;

    act(() => {
      grid.rows = ids(0, 46);
    });
    rerender({ ...options, newestRowId: "p45" });
    act(() => result.current.gridEvents.onModelUpdated());
    act(() => {
      grid.viewport = { top: firstTop, bottom: firstTop + VIEWPORT_HEIGHT };
      result.current.gridEvents.onBodyScroll(bodyScroll);
    });

    expect(result.current.follow).toBeUndefined();
  });

  it("decides nothing from a grid that has no height yet", () => {
    const { result } = renderFollow("p39");
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.viewport = { top: 0, bottom: 0 };
      result.current.gridEvents.onBodyScroll(bodyScroll);
    });

    expect(result.current.follow).toBeUndefined();
  });

  it("detaches, and offers the way back, when the reader scrolls off the newest row", () => {
    const { result } = renderFollow("p39");
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.viewport = { top: 0, bottom: VIEWPORT_HEIGHT };
      result.current.gridEvents.onBodyScroll(bodyScroll);
    });

    expect(result.current.follow?.label).toBe("Jump to latest");
  });
});
