import type { SortOrder } from "@zeloscloud/app-extension-sdk";
import type { BodyScrollEvent, GridApi, IRowNode } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readSession, sessionKey, writeSession } from "./session";

/**
 * Runs `onChange` only when `value` differs from the last value it ran with. Lives in the effect, not
 * render: a render-phase latch would be corrupted by StrictMode's double render.
 */
function useOnChange<T>(value: T, onChange: (value: T) => void): void {
  const lastRef = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (Object.is(value, lastRef.current)) return;
    lastRef.current = value;
    onChange(value);
  }, [value, onChange]);
}

/** The grid's vertical scroll window, in content pixels (AG Grid's `getVerticalPixelRange`). */
interface GridViewport {
  readonly top: number;
  readonly bottom: number;
}

/** True when any part of a row's band overlaps the viewport. */
function isRowInViewport(viewport: GridViewport, rowTopPx: number, rowHeightPx: number): boolean {
  return rowTopPx + rowHeightPx > viewport.top && rowTopPx < viewport.bottom;
}

/**
 * Where the panel's viewport was parked. The frame unloads on a tab switch, so this lives in
 * sessionStorage, keyed by the panel instance, and a reload reopens where the reader left off.
 */
interface ParkedViewport {
  /** Measured on the last scroll, never assumed: a grid that never scrolled reopens as a fresh one. */
  readonly following: boolean;
  /** The row at the top of a detached viewport. */
  readonly topRowId: string | null;
}

const viewportKey = (instanceId: string) => sessionKey(instanceId, "viewport");

function readParkedViewport(instanceId: string): ParkedViewport | undefined {
  const stored = readSession<Partial<ParkedViewport>>(viewportKey(instanceId));
  if (stored === null || typeof stored.following !== "boolean") return undefined;
  return { following: stored.following, topRowId: typeof stored.topRowId === "string" ? stored.topRowId : null };
}

function parkViewport(instanceId: string, patch: Partial<ParkedViewport>): void {
  writeSession(viewportKey(instanceId), {
    following: true,
    topRowId: null,
    ...readParkedViewport(instanceId),
    ...patch,
  });
}

/** Was the panel left scrolled off its tracked row? A reload that polls before knowing would move the rows. */
export function wasLeftDetached(instanceId: string): boolean {
  return readParkedViewport(instanceId)?.following === false;
}

/** The id of the rendered row `keep` accepts that sits highest in the grid, or lowest with `lowest`. */
function edgeRenderedRowId(
  api: GridApi,
  keep: (rowTop: number, rowHeight: number) => boolean,
  lowest = false,
): string | null {
  let best: { id: string; rowTop: number } | null = null;
  for (const node of api.getRenderedNodes()) {
    if (node.id == null || node.rowTop == null || !keep(node.rowTop, node.rowHeight ?? 0)) continue;
    if (!best || (lowest ? node.rowTop > best.rowTop : node.rowTop < best.rowTop)) {
      best = { id: node.id, rowTop: node.rowTop };
    }
  }
  return best?.id ?? null;
}

/** The row the reader sees at the top: the first at least half in view, not a sliver above it. */
function topRowIdOf(api: GridApi): string | null {
  const { top } = api.getVerticalPixelRange();
  return edgeRenderedRowId(api, (rowTop, rowHeight) => rowTop + rowHeight / 2 > top);
}

/**
 * The row a scroll toward `target` actually left on screen: the target, or the row nearest it when the
 * browser clamped the scroll short of it (the grid hadn't grown to hold it yet).
 */
function landedRowIdOf(api: GridApi, target: IRowNode): string | null {
  const viewport = api.getVerticalPixelRange();
  if (target.rowTop == null) return null;
  if (isRowInViewport(viewport, target.rowTop, target.rowHeight ?? 0)) return target.id ?? null;
  const inView = (rowTop: number, rowHeight: number) => isRowInViewport(viewport, rowTop, rowHeight);
  return edgeRenderedRowId(api, inView, target.rowTop >= viewport.bottom);
}

/**
 * Where the tail chase lands once a filter hides the newest row: whichever end the sort put it at, or
 * null if the grid shows nothing. `scrollToTail` and the attach test both read this and must agree — if
 * they disagree, the panel re-scrolls to an unmeasured row every poll and can never be scrolled away from.
 */
function displayedTailIndex(api: GridApi, tailOrder: SortOrder): number | null {
  const count = api.getDisplayedRowCount();
  if (count === 0) return null;
  return tailOrder === "desc" ? 0 : count - 1;
}

interface GridFollowOptions<TRow extends { id: string }> {
  /** Keys the parked viewport, so a reload reopens where the panel was. */
  instanceId: string;
  getGridApi: () => GridApi<TRow> | null;
  /** The row the panel tracks while a cursor is set; undefined when there is no cursor. */
  cursorRowId: string | undefined;
  /** The newest row's id — rows are always ascending by time, so this is the tail. */
  newestRowId: string | undefined;
  /** True while the panel pins its newest row. */
  followsTail: boolean;
  /**
   * Which end the newest row sits at. Derive with `displayedTimeOrder` on every read — AG Grid's sort
   * cycle is asc → desc → none, so a cached copy goes stale and the chase walks to the wrong end.
   */
  tailOrder: SortOrder;
  /** The row height the grid is configured with — the fallback for a row it hasn't measured. */
  rowHeight: number;
}

/** The grid events the follow hook listens to. Stable, so spreading them onto the grid never re-registers. */
export interface GridFollowEvents<TRow extends { id: string }> {
  onBodyScroll: (event: BodyScrollEvent<TRow>) => void;
  /** Parks a mounted grid where the panel was left, or a fresh one on the row it follows. */
  onFirstDataRendered: () => void;
  /** New rows, a filter, a sort: a following tail re-pins, a detached one re-checks. */
  onModelUpdated: () => void;
  onGridSizeChanged: () => void;
}

interface GridFollow<TRow extends { id: string }> {
  gridEvents: GridFollowEvents<TRow>;
  follow: { label: string; onClick: () => void } | undefined;
}

/**
 * Keeps the grid parked on the row it tracks (the cursor row, else the newest row) and offers a way back
 * once the user scrolls off it. Like tmux: at the tail, new rows, filters and resizes keep it there;
 * scrolled back, it stays put.
 *
 * Height-agnostic: pixel math reads the row node's own geometry, never an assumed uniform height.
 */
export function useGridFollow<TRow extends { id: string }>({
  instanceId,
  getGridApi,
  cursorRowId,
  newestRowId,
  followsTail,
  tailOrder,
  rowHeight,
}: GridFollowOptions<TRow>): GridFollow<TRow> {
  // Follow = viewport attached to the tracked row, derived from scroll POSITION: AG Grid also emits scroll
  // events for our own ensureIndexVisible calls and for clamping as rows rotate.
  // Read once, at mount: the new grid's own events overwrite the parked row before its rows render.
  const reopenRef = useRef(readParkedViewport(instanceId));
  const [follow, setFollow] = useState(() => reopenRef.current?.following ?? true);
  // Until the new grid's first rows render, its viewport sits at the top and measures nothing real.
  const renderedRef = useRef(false);
  // Follow as of now, for grid events that run before React re-renders: a chase queued just before the
  // reader scrolled away must see that they did.
  const followRef = useRef(follow);
  // The row the last tail chase left on screen. AG Grid reports scrolls a task late, and rows can land in
  // that gap: a following tail is judged against this row, so neither a late echo of the chase nor the
  // browser clamping a shrunk window reads as the reader leaving. Detaching or any other own scroll clears it.
  const pinnedTailIdRef = useRef<string | null>(null);

  const setFollowNow = useCallback((following: boolean) => {
    followRef.current = following;
    if (!following) pinnedTailIdRef.current = null;
    setFollow(following);
  }, []);

  /** Set and park together, so a remount reopens in the state the panel was in. */
  const settle = useCallback(
    (following: boolean) => {
      setFollowNow(following);
      parkViewport(instanceId, { following });
    },
    [instanceId, setFollowNow],
  );

  // A pinned cursor outranks the tail: chasing the newest row would drag the cursor row out of view and
  // read as a detach.
  const isTailFollowing = followsTail && cursorRowId === undefined;
  const trackedRowId = cursorRowId ?? (isTailFollowing ? newestRowId : undefined);

  /**
   * The node reports where the grid actually laid the row out, so differing row heights land correctly.
   * `rowIndex × height` is only a fallback for an unpositioned row, where it's exact anyway. A row that
   * isn't displayed can't be scrolled away from.
   */
  const isNodeInView = useCallback(
    (api: GridApi<TRow>, node: IRowNode<TRow> | undefined) => {
      if (node?.rowIndex == null) return true;
      const height = node.rowHeight ?? rowHeight;
      const rowTop = node.rowTop ?? node.rowIndex * height;
      return isRowInViewport(api.getVerticalPixelRange(), rowTop, height);
    },
    [rowHeight],
  );

  /**
   * Is the tracked row on screen? Resolved through the row's node so it holds under either sort direction —
   * a desc Time sort puts the newest row at the top, so a "viewport parked at the bottom" test would
   * measure the wrong end.
   */
  const isAttached = useCallback(() => {
    const api = getGridApi();
    if (!api || trackedRowId === undefined) return true;
    let node = api.getRowNode(trackedRowId);
    // A filter hides the tracked row: AG Grid keeps the node but nulls its geometry. While chasing the
    // tail, that's exactly when `scrollToTail` falls back to the displayed end — measure that row too, or
    // the panel yanks the viewport back every poll and can never offer a way back. A hidden cursor
    // row is the opposite case: nothing is chasing it, so nothing can be detached.
    if (node?.rowIndex == null && isTailFollowing) {
      const index = displayedTailIndex(api, tailOrder);
      node = index === null ? undefined : api.getDisplayedRowAtIndex(index);
    }
    return isNodeInView(api, node);
  }, [trackedRowId, isTailFollowing, tailOrder, getGridApi, isNodeInView]);

  /** Is a following viewport still where the hook left it? The tail is judged by its pin, while the pin holds. */
  const isStillFollowing = useCallback(() => {
    const api = getGridApi();
    const pinned = pinnedTailIdRef.current;
    const node = api && isTailFollowing && pinned !== null ? api.getRowNode(pinned) : undefined;
    return api && node?.rowIndex != null ? isNodeInView(api, node) : isAttached();
  }, [getGridApi, isTailFollowing, isNodeInView, isAttached]);

  /** False when the row isn't displayed (gone from the window, or filtered out). */
  const scrollToRow = useCallback(
    (rowId: string, position: "middle" | "top" | "bottom"): boolean => {
      const api = getGridApi();
      const node = api?.getRowNode(rowId);
      if (!api || node?.rowIndex == null) return false;
      api.ensureIndexVisible(node.rowIndex, position);
      pinnedTailIdRef.current = null;
      return true;
    },
    [getGridApi],
  );

  /** Bring the newest row into view, at whichever end the sort put it. A filtered-out row has no index, so
   *  fall back to the displayed end — keeps a filtered grid ("only errors") chasing its newest match
   *  instead of stranding on whatever it was parked at. */
  const scrollToTail = useCallback(() => {
    const api = getGridApi();
    if (!api) return;
    let target = newestRowId ? api.getRowNode(newestRowId) : undefined;
    if (target?.rowIndex != null) {
      api.ensureIndexVisible(target.rowIndex, "bottom");
    } else {
      const index = displayedTailIndex(api, tailOrder);
      if (index === null) return;
      target = api.getDisplayedRowAtIndex(index);
      api.ensureIndexVisible(index, tailOrder === "desc" ? "top" : "bottom");
    }
    // Where it landed, not where it aimed: a chase clamped short of new rows pins the old tail, still in view.
    pinnedTailIdRef.current = target ? landedRowIdOf(api, target) : null;
  }, [newestRowId, tailOrder, getGridApi]);

  // Chase the cursor while attached. When it disappears, re-derive rather than forcing follow back on —
  // that would yank the viewport away from someone who deliberately scrolled off.
  useOnChange(cursorRowId, (rowId) => {
    if (rowId === undefined) {
      settle(isAttached());
      return;
    }
    if (followRef.current) scrollToRow(rowId, "middle");
  });

  // AG Grid can fire these before it adopts this render's props, so they read the render through a ref.
  const latest = useRef({
    cursorRowId,
    isTailFollowing,
    isAttached,
    isStillFollowing,
    scrollToTail,
    scrollToRow,
    settle,
  });
  latest.current = { cursorRowId, isTailFollowing, isAttached, isStillFollowing, scrollToTail, scrollToRow, settle };

  const gridEvents = useMemo<GridFollowEvents<TRow>>(
    () => ({
      onBodyScroll: (event) => {
        const api = getGridApi();
        if (event.direction === "horizontal" || !api || !renderedRef.current) return;
        const attached = followRef.current ? latest.current.isStillFollowing() : latest.current.isAttached();
        setFollowNow(attached);
        parkViewport(instanceId, { following: attached, topRowId: topRowIdOf(api) });
      },
      onFirstDataRendered: () => {
        renderedRef.current = true;
        const { cursorRowId: cursor, isTailFollowing: tailing, scrollToRow: reveal, settle: park } = latest.current;
        // Once: a grid remounting inside a living panel (a new query window) starts fresh.
        const reopen = reopenRef.current;
        reopenRef.current = undefined;
        // Left scrolled back, or tracking nothing: the row the reader was on, while the window still holds it.
        const leftWhereTheyRead = reopen && (!reopen.following || (!tailing && cursor === undefined));
        if (leftWhereTheyRead && reopen.topRowId && reveal(reopen.topRowId, "top")) return;
        // Fresh, left following, or that row is gone: the row it follows. A panel can reopen at another
        // height, where the old top row no longer shows the followed one.
        if (tailing) {
          park(true);
          latest.current.scrollToTail();
        } else if (cursor !== undefined && reopen) {
          park(true);
          reveal(cursor, "middle");
        }
      },
      // Rows landing ABOVE the viewport (a window filling in) move the tail off screen without a scroll event
      // or a new newest row, so the pin rides the model, not the newest row's identity.
      onModelUpdated: () => {
        const { isTailFollowing: tailing, isAttached: attached } = latest.current;
        if (!tailing || !renderedRef.current) return;
        if (followRef.current) {
          latest.current.scrollToTail();
          return;
        }
        // Detached: a shrinking buffer can bring the tail back into view, and new rows change the top line.
        const api = getGridApi();
        if (!api?.getDisplayedRowCount()) return;
        const isNowAttached = attached();
        setFollowNow(isNowAttached);
        parkViewport(instanceId, { following: isNowAttached, topRowId: topRowIdOf(api) });
      },
      onGridSizeChanged: () => {
        if (followRef.current && latest.current.isTailFollowing && renderedRef.current) latest.current.scrollToTail();
      },
    }),
    [getGridApi, instanceId, setFollowNow],
  );

  const onJumpToFollow = useCallback(() => {
    settle(true);
    // The button only shows while a cursor or the tail is tracked.
    if (cursorRowId !== undefined) scrollToRow(cursorRowId, "middle");
    else scrollToTail();
  }, [settle, cursorRowId, scrollToRow, scrollToTail]);

  const followVisible = !follow && (cursorRowId !== undefined || followsTail);
  const followLabel = cursorRowId !== undefined ? "Jump to cursor" : "Jump to latest";
  const followAction = useMemo(
    () => (followVisible ? { label: followLabel, onClick: onJumpToFollow } : undefined),
    [followVisible, followLabel, onJumpToFollow],
  );

  return { gridEvents, follow: followAction };
}
