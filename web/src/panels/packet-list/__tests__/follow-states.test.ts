import { act, renderHook } from "@testing-library/react";
import type { BodyScrollEvent, GridApi, IRowNode } from "ag-grid-community";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGridFollow } from "../grid/follow";

interface TestRow {
  id: string;
}

type FollowOptions = Parameters<typeof useGridFollow<TestRow>>[0];

/** What the grid is configured with: the height the hook falls back to for a row it can't measure. */
const CONFIGURED_ROW_HEIGHT = 32;
const VIEWPORT_HEIGHT = 320;

/** A row as the grid laid it out; `null` is a row AG Grid hasn't measured. */
interface DisplayedRow {
  id: string;
  height: number | null;
}

/** A grid stand-in that reports each row's own geometry, so the follow math meets a real layout. */
const grid = {
  /** The displayed rows, in display order. */
  rows: [] as DisplayedRow[],
  /** Rows a filter hides: AG Grid keeps their nodes and nulls their geometry. */
  filteredOut: [] as string[],
  viewport: { top: 0, bottom: VIEWPORT_HEIGHT },
  /** Cleared to model rows the grid hasn't positioned yet. */
  positioned: true,
  ensureIndexVisible: vi.fn<(index: number, position: string) => void>(),
  api: {} as GridApi<TestRow>,
};

const FILTERED_NODE = { rowIndex: null, rowTop: null, rowHeight: null } as IRowNode<TestRow>;

function nodeOf(rowId: string): IRowNode<TestRow> | undefined {
  const rowIndex = grid.rows.findIndex((row) => row.id === rowId);
  if (rowIndex < 0) return grid.filteredOut.includes(rowId) ? FILTERED_NODE : undefined;
  let rowTop = 0;
  for (const row of grid.rows.slice(0, rowIndex)) rowTop += row.height ?? CONFIGURED_ROW_HEIGHT;
  return {
    id: rowId,
    rowIndex,
    rowTop: grid.positioned ? rowTop : null,
    rowHeight: grid.rows[rowIndex]?.height ?? null,
  } as IRowNode<TestRow>;
}

grid.api = {
  isDestroyed: () => false,
  getVerticalPixelRange: () => grid.viewport,
  getDisplayedRowCount: () => grid.rows.length,
  getDisplayedRowAtIndex: (index: number) => {
    const row = grid.rows[index];
    return row ? nodeOf(row.id) : undefined;
  },
  getRowNode: nodeOf,
  getRenderedNodes: () => grid.rows.map((row) => nodeOf(row.id)),
  ensureIndexVisible: grid.ensureIndexVisible,
} as unknown as GridApi<TestRow>;

const SHORT = 24;
const TALL = 32;
/** 10 short rows then 10 tall ones: 560 px of content behind a 320 px viewport. */
const ROWS: DisplayedRow[] = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, height: i < 10 ? SHORT : TALL }));
const NEWEST_INDEX = ROWS.length - 1;
const NEWEST = "r19";
/** The newest row occupies [528, 560], so a viewport parked at the tail starts at 240. */
const TAIL_TOP = 240;
/** The cursor row occupies [120, 144]. */
const CURSOR = "r5";

const getGridApi = () => grid.api;

/** Scroll as AG Grid does, then clamp as the browser does: never past the end of the content. */
function scrollIndexIntoView(index: number, position: string) {
  const node = grid.api.getDisplayedRowAtIndex(index);
  const rowTop = node?.rowTop ?? 0;
  const height = node?.rowHeight ?? CONFIGURED_ROW_HEIGHT;
  const content = grid.rows.reduce((sum, row) => sum + (row.height ?? CONFIGURED_ROW_HEIGHT), 0);
  const target =
    position === "top"
      ? rowTop
      : position === "bottom"
        ? rowTop + height - VIEWPORT_HEIGHT
        : rowTop + (height - VIEWPORT_HEIGHT) / 2;
  const top = Math.max(0, Math.min(target, content - VIEWPORT_HEIGHT));
  grid.viewport = { top, bottom: top + VIEWPORT_HEIGHT };
}

function options(overrides: Partial<FollowOptions> = {}): FollowOptions {
  return {
    sessionId: "ws-1/panel-1",
    getGridApi,
    cursorRowId: undefined,
    newestRowId: NEWEST,
    followsTail: true,
    tailOrder: "asc",
    rowHeight: CONFIGURED_ROW_HEIGHT,
    ...overrides,
  };
}

/** Render the hook and, as a mounted grid does, its first rows; then forget the scroll that parked them. */
function renderFollow(overrides: Partial<FollowOptions> = {}, { rendered = true } = {}) {
  const hook = renderHook((props: FollowOptions) => useGridFollow(props), { initialProps: options(overrides) });
  if (rendered) act(() => hook.result.current.gridEvents.onFirstDataRendered());
  grid.ensureIndexVisible.mockClear();
  return hook;
}

/** Scroll the fake viewport and echo the body-scroll event AG Grid would emit. */
function scrollTo(follow: ReturnType<typeof useGridFollow<TestRow>>, top: number) {
  act(() => {
    grid.viewport = { top, bottom: top + VIEWPORT_HEIGHT };
    follow.gridEvents.onBodyScroll({ direction: "vertical" } as BodyScrollEvent<TestRow>);
  });
}

beforeEach(() => {
  grid.ensureIndexVisible.mockReset();
  grid.ensureIndexVisible.mockImplementation(scrollIndexIntoView);
  grid.rows = [...ROWS];
  grid.filteredOut = [];
  grid.viewport = { top: 0, bottom: VIEWPORT_HEIGHT };
  grid.positioned = true;
});

describe("useGridFollow — rows of differing heights", () => {
  it("stays attached at the tail, where uniform-height math would place the newest row past the viewport", () => {
    const { result } = renderFollow();

    scrollTo(result.current, TAIL_TOP);
    expect(result.current.follow).toBeUndefined();
  });

  it("detaches on a real scroll away from the tail", () => {
    const { result } = renderFollow();

    scrollTo(result.current, 0);
    expect(result.current.follow?.label).toBe("Jump to latest");
  });

  it("catches a cursor row leaving the viewport, where uniform-height math would still think it visible", () => {
    const { result } = renderFollow({ cursorRowId: CURSOR, followsTail: false });

    scrollTo(result.current, 160);
    expect(result.current.follow?.label).toBe("Jump to cursor");
  });

  it("measures an unmeasured row at the grid's configured height", () => {
    grid.rows = ROWS.map((row) => ({ ...row, height: null }));
    const { result } = renderFollow();

    scrollTo(result.current, 0);
    expect(result.current.follow).toBeDefined();

    // Every row is 32 px now, so the newest occupies [608, 640] and overlaps a viewport from 630.
    scrollTo(result.current, 630);
    expect(result.current.follow).toBeUndefined();
  });

  it("follows a desc tail at the top, and jumps back there", () => {
    grid.rows = [{ id: NEWEST, height: SHORT }, ...ROWS.slice(0, NEWEST_INDEX).reverse()];
    const { result } = renderFollow({ tailOrder: "desc" });

    scrollTo(result.current, 0);
    expect(result.current.follow).toBeUndefined();

    scrollTo(result.current, 24);
    expect(result.current.follow).toBeDefined();

    act(() => result.current.follow?.onClick());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(0, "bottom");
  });

  it("falls back to uniform math for a row the grid hasn't positioned", () => {
    grid.positioned = false;
    const { result } = renderFollow();

    scrollTo(result.current, 0);
    expect(result.current.follow).toBeDefined();

    scrollTo(result.current, 608);
    expect(result.current.follow).toBeUndefined();
  });
});

describe("useGridFollow — the tail", () => {
  it("keeps the newest row in view as rows arrive", () => {
    const { result, rerender } = renderFollow();
    scrollTo(result.current, TAIL_TOP);

    act(() => {
      grid.rows = [...ROWS.slice(1), { id: "r20", height: TALL }];
    });
    rerender(options({ newestRowId: "r20" }));
    act(() => result.current.gridEvents.onModelUpdated());

    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(NEWEST_INDEX, "bottom");
  });

  it("does not chase the tail once the user has scrolled off it", () => {
    const { result, rerender } = renderFollow();
    scrollTo(result.current, 0);

    act(() => {
      grid.rows = [...ROWS, { id: "r20", height: TALL }];
    });
    rerender(options({ newestRowId: "r20" }));
    act(() => result.current.gridEvents.onModelUpdated());

    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
    expect(result.current.follow).toBeDefined();
  });

  it("resumes when a shrinking buffer brings the tail back into view without a scroll event", () => {
    const { result, rerender } = renderFollow();
    scrollTo(result.current, 0);
    expect(result.current.follow).toBeDefined();

    act(() => {
      grid.rows = ROWS.slice(0, 6);
    });
    rerender(options({ newestRowId: "r5" }));
    act(() => result.current.gridEvents.onModelUpdated());

    expect(result.current.follow).toBeUndefined();
  });

  it("jumps to the newest row wherever the sort put it, and to the displayed end when it is filtered out", () => {
    const { result } = renderFollow({ tailOrder: "desc" });
    scrollTo(result.current, 0);
    grid.ensureIndexVisible.mockClear();

    act(() => result.current.follow?.onClick());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(NEWEST_INDEX, "bottom");

    act(() => {
      grid.rows = ROWS.slice(0, 10);
      grid.filteredOut = ROWS.slice(10).map((row) => row.id);
    });
    scrollTo(result.current, VIEWPORT_HEIGHT);
    expect(result.current.follow?.label).toBe("Jump to latest");

    grid.ensureIndexVisible.mockClear();
    act(() => result.current.follow?.onClick());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(0, "top");
  });

  it("re-pins when rows land above the viewport without a new newest row", () => {
    const { result } = renderFollow();
    scrollTo(result.current, TAIL_TOP);

    act(() => {
      grid.rows = [{ id: "older", height: TALL }, ...ROWS];
    });
    act(() => result.current.gridEvents.onModelUpdated());

    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(NEWEST_INDEX + 1, "bottom");
  });

  it("re-pins the tail when the grid resizes, and leaves a detached one alone", () => {
    const { result } = renderFollow();
    act(() => result.current.gridEvents.onGridSizeChanged());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(NEWEST_INDEX, "bottom");

    scrollTo(result.current, 0);
    grid.ensureIndexVisible.mockClear();
    act(() => result.current.gridEvents.onGridSizeChanged());
    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
  });

  it("does not move a grid that tracks the cursor when it resizes", () => {
    const { result } = renderFollow({ cursorRowId: CURSOR });
    act(() => result.current.gridEvents.onGridSizeChanged());

    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
  });

  it("hands the grid the same handlers on every render", () => {
    const { result, rerender } = renderFollow();
    const first = result.current.gridEvents;
    rerender(options({ newestRowId: "r18" }));

    expect(result.current.gridEvents).toBe(first);
  });

  it("does not read its own scroll, reported after new rows land, as the reader leaving", () => {
    const { result, rerender } = renderFollow();
    grid.ensureIndexVisible.mockImplementation(() => {
      grid.viewport = { top: TAIL_TOP, bottom: TAIL_TOP + VIEWPORT_HEIGHT };
    });
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.rows = [...ROWS, { id: "r20", height: TALL }, { id: "r21", height: TALL }];
    });
    rerender(options({ newestRowId: "r21" }));
    act(() => result.current.gridEvents.onBodyScroll({ direction: "vertical" } as BodyScrollEvent<TestRow>));

    expect(result.current.follow).toBeUndefined();
  });

  it("does not read the browser clamping a shrunk window as the reader leaving", () => {
    const { result, rerender } = renderFollow();
    act(() => result.current.gridEvents.onModelUpdated());

    const rotated = [...ROWS.slice(1), { id: "r20", height: TALL }];
    act(() => {
      grid.rows = rotated.slice(0, -1);
      grid.viewport = { top: TAIL_TOP - SHORT, bottom: TAIL_TOP - SHORT + VIEWPORT_HEIGHT };
    });
    act(() => {
      grid.rows = rotated;
    });
    rerender(options({ newestRowId: "r20" }));
    act(() => result.current.gridEvents.onBodyScroll({ direction: "vertical" } as BodyScrollEvent<TestRow>));
    expect(result.current.follow).toBeUndefined();

    act(() => result.current.gridEvents.onModelUpdated());
    expect(grid.ensureIndexVisible).toHaveBeenLastCalledWith(rotated.length - 1, "bottom");
  });

  it("does not read a chase clamped short of the new row as the reader leaving", () => {
    const { result, rerender } = renderFollow();
    act(() => result.current.gridEvents.onModelUpdated());

    act(() => {
      grid.rows = [...ROWS, { id: "r20", height: TALL }];
    });
    rerender(options({ newestRowId: "r20" }));
    grid.ensureIndexVisible.mockImplementation(() => {});
    act(() => result.current.gridEvents.onModelUpdated());
    act(() => result.current.gridEvents.onBodyScroll({ direction: "vertical" } as BodyScrollEvent<TestRow>));

    expect(result.current.follow).toBeUndefined();
  });

  it("offers no button when the panel is not following the tail", () => {
    const { result } = renderFollow({ followsTail: false });

    scrollTo(result.current, 0);
    expect(result.current.follow).toBeUndefined();
  });

  it("ignores horizontal scrolling", () => {
    const { result } = renderFollow();
    scrollTo(result.current, TAIL_TOP);

    act(() => {
      grid.viewport = { top: 0, bottom: VIEWPORT_HEIGHT };
      result.current.gridEvents.onBodyScroll({ direction: "horizontal" } as BodyScrollEvent<TestRow>);
    });

    expect(result.current.follow).toBeUndefined();
  });
});

describe("useGridFollow — the newest row is filtered out", () => {
  /** The grid displays r0…r18, whose end sits at [496, 528]; r19 is buffered but hidden. */
  function filterOutTheTail() {
    grid.rows = ROWS.slice(0, NEWEST_INDEX);
    grid.filteredOut = [NEWEST];
  }
  const DISPLAYED_END = NEWEST_INDEX - 1;
  /** A viewport whose last row is the displayed end, as the chase leaves it. */
  const DISPLAYED_END_TOP = 208;

  it("detaches on a scroll away from the displayed end and offers the way back", () => {
    filterOutTheTail();
    const { result } = renderFollow();

    scrollTo(result.current, 0);
    expect(result.current.follow?.label).toBe("Jump to latest");
  });

  it("stops chasing the tail once the user has scrolled off it", () => {
    filterOutTheTail();
    const { result, rerender } = renderFollow();
    scrollTo(result.current, 0);

    act(() => {
      grid.filteredOut = [NEWEST, "r20"];
    });
    rerender(options({ newestRowId: "r20" }));
    act(() => result.current.gridEvents.onModelUpdated());

    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
    expect(result.current.follow).toBeDefined();
  });

  it("keeps chasing the displayed end while the user is parked on it", () => {
    filterOutTheTail();
    const { result, rerender } = renderFollow();
    scrollTo(result.current, DISPLAYED_END_TOP);
    expect(result.current.follow).toBeUndefined();

    act(() => {
      grid.filteredOut = [NEWEST, "r20"];
    });
    rerender(options({ newestRowId: "r20" }));
    act(() => result.current.gridEvents.onModelUpdated());

    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(DISPLAYED_END, "bottom");
  });

  it("measures the desc displayed end at the top of the grid, where that sort puts the tail", () => {
    grid.rows = ROWS.slice(0, NEWEST_INDEX).reverse();
    grid.filteredOut = [NEWEST];
    const { result } = renderFollow({ tailOrder: "desc" });

    scrollTo(result.current, 0);
    expect(result.current.follow).toBeUndefined();

    scrollTo(result.current, 32);
    expect(result.current.follow).toBeDefined();
  });

  it("stays attached to a cursor row a filter hides: nothing is chasing it", () => {
    grid.rows = ROWS.filter((row) => row.id !== CURSOR);
    grid.filteredOut = [CURSOR];
    const { result } = renderFollow({ cursorRowId: CURSOR, followsTail: false });

    scrollTo(result.current, 0);
    expect(result.current.follow).toBeUndefined();
  });
});

describe("useGridFollow — a pinned cursor outranks the tail", () => {
  it("does not scroll away from the cursor row when a newer row lands", () => {
    const { result, rerender } = renderFollow({ cursorRowId: CURSOR });

    act(() => {
      grid.rows = [...ROWS, { id: "r20", height: TALL }];
    });
    rerender(options({ cursorRowId: CURSOR, newestRowId: "r20" }));
    act(() => result.current.gridEvents.onModelUpdated());

    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
    expect(result.current.follow).toBeUndefined();
  });

  it("chases the cursor while attached, and jumps back to it on demand once detached", () => {
    const { result, rerender } = renderFollow({ cursorRowId: CURSOR });

    rerender(options({ cursorRowId: "r7" }));
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(7, "middle");

    scrollTo(result.current, TAIL_TOP);
    expect(result.current.follow).toBeDefined();

    grid.ensureIndexVisible.mockClear();
    act(() => result.current.follow?.onClick());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(7, "middle");
  });

  it("re-attaches to the tail when the cursor clears with the tail on screen", () => {
    const { result, rerender } = renderFollow({ cursorRowId: CURSOR });

    scrollTo(result.current, TAIL_TOP);
    expect(result.current.follow?.label).toBe("Jump to cursor");

    rerender(options({ cursorRowId: undefined }));

    expect(result.current.follow).toBeUndefined();
  });

  it("leaves a deliberately scrolled-off viewport where it is when the cursor clears", () => {
    const { result, rerender } = renderFollow({ cursorRowId: CURSOR });

    scrollTo(result.current, 200);
    grid.ensureIndexVisible.mockClear();

    rerender(options({ cursorRowId: undefined }));

    expect(result.current.follow?.label).toBe("Jump to latest");
    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
  });
});

describe("useGridFollow — a reload reopens where the panel was", () => {
  it("reopens a detached panel on the row that was at the top, without chasing the tail", () => {
    const first = renderFollow();
    scrollTo(first.result.current, 200); // r8 occupies [192, 216]: more than half of it is in view
    first.unmount();

    const { result } = renderFollow({}, { rendered: false });
    expect(result.current.follow?.label).toBe("Jump to latest");

    act(() => result.current.gridEvents.onFirstDataRendered());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(8, "top");
    expect(grid.ensureIndexVisible).not.toHaveBeenCalledWith(NEWEST_INDEX, "bottom");
  });

  it("reopens a following panel on the newest row", () => {
    const first = renderFollow();
    scrollTo(first.result.current, TAIL_TOP);
    first.unmount();

    const { result } = renderFollow({}, { rendered: false });
    act(() => result.current.gridEvents.onFirstDataRendered());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(NEWEST_INDEX, "bottom");
  });

  it("opens a fresh panel at the top of its rows, not on the cursor", () => {
    const { result } = renderFollow({ cursorRowId: CURSOR, followsTail: false }, { rendered: false });

    act(() => result.current.gridEvents.onFirstDataRendered());
    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
  });

  it("reopens a panel that followed the cursor on the cursor row", () => {
    // It may reopen at another height, where its old top row would no longer show the cursor row.
    const following = { cursorRowId: CURSOR, followsTail: false };
    const first = renderFollow(following);
    scrollTo(first.result.current, 100);
    first.unmount();

    const { result } = renderFollow(following, { rendered: false });
    act(() => result.current.gridEvents.onFirstDataRendered());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(5, "middle");
  });

  it("reopens a panel that never scrolled as a fresh one", () => {
    const following = { cursorRowId: CURSOR, followsTail: false };
    renderFollow(following).unmount();

    const { result } = renderFollow(following, { rendered: false });
    act(() => result.current.gridEvents.onFirstDataRendered());
    expect(grid.ensureIndexVisible).not.toHaveBeenCalled();
  });

  it("reopens a panel that tracks nothing on the row that was at the top", () => {
    const first = renderFollow({ followsTail: false });
    scrollTo(first.result.current, 200);
    first.unmount();

    const { result } = renderFollow({ followsTail: false }, { rendered: false });
    act(() => result.current.gridEvents.onFirstDataRendered());
    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(8, "top");
  });

  it("reopens on the newest row when the row it was on is gone", () => {
    const first = renderFollow();
    scrollTo(first.result.current, 200);
    first.unmount();

    grid.rows = ROWS.slice(10);
    const { result } = renderFollow({}, { rendered: false });
    act(() => result.current.gridEvents.onFirstDataRendered());

    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(9, "bottom");
    expect(result.current.follow).toBeUndefined();
  });

  it("parks the re-attach new rows bring about, not only a scroll's", () => {
    const first = renderFollow();
    scrollTo(first.result.current, 0);
    act(() => {
      grid.rows = ROWS.slice(0, 6);
    });
    act(() => first.result.current.gridEvents.onModelUpdated());
    expect(first.result.current.follow).toBeUndefined();
    first.unmount();

    const { result } = renderFollow({}, { rendered: false });
    expect(result.current.follow).toBeUndefined();
  });

  it("ignores the grid's events until its first rows render", () => {
    const first = renderFollow();
    scrollTo(first.result.current, 200);
    first.unmount();

    const { result } = renderFollow({}, { rendered: false });
    scrollTo(result.current, 0);
    act(() => result.current.gridEvents.onFirstDataRendered());

    expect(grid.ensureIndexVisible).toHaveBeenCalledWith(8, "top");
  });

  it("keeps each panel's place separately", () => {
    const first = renderFollow();
    scrollTo(first.result.current, 0);
    first.unmount();

    const { result } = renderFollow({ sessionId: "ws-1/panel-2" });
    expect(result.current.follow).toBeUndefined();
  });
});
