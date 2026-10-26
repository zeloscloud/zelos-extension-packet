import type { SortOrder } from "@zeloscloud/app-extension-sdk";
import type { BodyScrollEvent, GridApi, IRowNode } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readSession, sessionKey, writeSession } from "./session";

/** Runs `onChange` when `value` changes; in an effect, since StrictMode's double render corrupts a render latch. */
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

/** Chase positions remembered: enough to span the scroll reports AG Grid delivers late under load. */
const CHASED_TOPS_KEPT = 8;

/** True when any part of a row's band overlaps the viewport. */
function isRowInViewport(viewport: GridViewport, rowTopPx: number, rowHeightPx: number): boolean {
  return rowTopPx + rowHeightPx > viewport.top && rowTopPx < viewport.bottom;
}

/** Where the viewport was parked, kept for the session so a reload reopens where the reader left off. */
interface ParkedViewport {
  /** Measured on the last scroll, never assumed: a grid that never scrolled reopens as a fresh one. */
  readonly following: boolean;
  /** The row at the top of a detached viewport. */
  readonly topRowId: string | null;
}

const viewportKey = (sessionId: string) => sessionKey(sessionId, "viewport");

function readParkedViewport(sessionId: string): ParkedViewport | undefined {
  const stored = readSession<Partial<ParkedViewport>>(viewportKey(sessionId));
  if (stored === null || typeof stored.following !== "boolean") return undefined;
  return { following: stored.following, topRowId: typeof stored.topRowId === "string" ? stored.topRowId : null };
}

function parkViewport(sessionId: string, patch: Partial<ParkedViewport>): void {
  writeSession(viewportKey(sessionId), {
    following: true,
    topRowId: null,
    ...readParkedViewport(sessionId),
    ...patch,
  });
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

/** The row a scroll toward `target` left on screen: it, or its nearest when the browser clamped the scroll short. */
function landedRowIdOf(api: GridApi, target: IRowNode): string | null {
  const viewport = api.getVerticalPixelRange();
  if (target.rowTop == null) return null;
  if (isRowInViewport(viewport, target.rowTop, target.rowHeight ?? 0)) return target.id ?? null;
  const inView = (rowTop: number, rowHeight: number) => isRowInViewport(viewport, rowTop, rowHeight);
  return edgeRenderedRowId(api, inView, target.rowTop >= viewport.bottom);
}

/** Where the chase lands once a filter hides the newest row; the chase and the attach test must both read it. */
function displayedTailIndex(api: GridApi, tailOrder: SortOrder): number | null {
  const count = api.getDisplayedRowCount();
  if (count === 0) return null;
  return tailOrder === "desc" ? 0 : count - 1;
}

interface GridFollowOptions<TRow extends { id: string }> {
  /** Keys the parked viewport, so a reload reopens where the panel was. */
  sessionId: string;
  getGridApi: () => GridApi<TRow> | null;
  /** The row the panel tracks while a cursor is set; undefined when there is no cursor. */
  cursorRowId: string | undefined;
  /** The newest row's id — rows are always ascending by time, so this is the tail. */
  newestRowId: string | undefined;
  /** True while the panel pins its newest row. */
  followsTail: boolean;
  /** Which end the newest row sits at, from `displayedTimeOrder` on every read: a cached copy goes stale. */
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

/** Keeps the grid on the row it tracks (the cursor row, else the newest) and offers a way back once scrolled off. */
export function useGridFollow<TRow extends { id: string }>({
  sessionId,
  getGridApi,
  cursorRowId,
  newestRowId,
  followsTail,
  tailOrder,
  rowHeight,
}: GridFollowOptions<TRow>): GridFollow<TRow> {
  // Read once, at mount: the new grid's own events overwrite the parked row before its rows render.
  const reopenRef = useRef(readParkedViewport(sessionId));
  const [follow, setFollow] = useState(() => reopenRef.current?.following ?? true);
  // Until the new grid's first rows render, its viewport sits at the top and measures nothing real.
  const renderedRef = useRef(false);
  // Follow as of now, for grid events that run before React re-renders.
  const followRef = useRef(follow);
  // The row the last chase left on screen: AG Grid reports scrolls late, after more rows may have landed.
  const pinnedTailIdRef = useRef<string | null>(null);
  // Where recent chases left the viewport: a late report at any of them is the hook's own scroll.
  const chasedTopsRef = useRef<number[]>([]);

  const setFollowNow = useCallback((following: boolean) => {
    followRef.current = following;
    if (!following) {
      pinnedTailIdRef.current = null;
      chasedTopsRef.current = [];
    }
    setFollow(following);
  }, []);

  /** Set and park together, so a remount reopens in the state the panel was in. */
  const settle = useCallback(
    (following: boolean) => {
      setFollowNow(following);
      parkViewport(sessionId, { following });
    },
    [sessionId, setFollowNow],
  );

  // A pinned cursor outranks the tail: chasing the newest row would drag the cursor row out of view.
  const isTailFollowing = followsTail && cursorRowId === undefined;
  const trackedRowId = cursorRowId ?? (isTailFollowing ? newestRowId : undefined);

  /** Measured by the node's own layout, so rows of differing heights land right; an undisplayed row counts as seen. */
  const isNodeInView = useCallback(
    (api: GridApi<TRow>, node: IRowNode<TRow> | undefined) => {
      if (node?.rowIndex == null) return true;
      const viewport = api.getVerticalPixelRange();
      // A grid not laid out yet measures nothing, so it says nothing about where the reader is.
      if (viewport.bottom <= viewport.top) return true;
      const height = node.rowHeight ?? rowHeight;
      const rowTop = node.rowTop ?? node.rowIndex * height;
      return isRowInViewport(viewport, rowTop, height);
    },
    [rowHeight],
  );

  /** Is the tracked row on screen? Through its node, so it holds under either sort direction. */
  const isAttached = useCallback(() => {
    const api = getGridApi();
    if (!api || trackedRowId === undefined) return true;
    let node = api.getRowNode(trackedRowId);
    // A filtered-out tail is chased at the displayed end, so measure that row; nothing chases a hidden cursor row.
    if (node?.rowIndex == null && isTailFollowing) {
      const index = displayedTailIndex(api, tailOrder);
      node = index === null ? undefined : api.getDisplayedRowAtIndex(index);
    }
    return isNodeInView(api, node);
  }, [trackedRowId, isTailFollowing, tailOrder, getGridApi, isNodeInView]);

  /** A window rotating under the viewport, or past the pin, moved the content, not the reader. */
  const isStillFollowing = useCallback(() => {
    const api = getGridApi();
    const pinned = pinnedTailIdRef.current;
    if (api && isTailFollowing && pinned !== null) {
      if (chasedTopsRef.current.includes(api.getVerticalPixelRange().top)) return true;
      const node = api.getRowNode(pinned);
      // Gone from the data, not filtered out (that keeps its node): the window rotated past it.
      if (node === undefined) return true;
      if (node.rowIndex != null && isNodeInView(api, node)) return true;
    }
    return isAttached();
  }, [getGridApi, isTailFollowing, isNodeInView, isAttached]);

  /** False when the row isn't displayed (gone from the window, or filtered out). */
  const scrollToRow = useCallback(
    (rowId: string, position: "middle" | "top" | "bottom"): boolean => {
      const api = getGridApi();
      const node = api?.getRowNode(rowId);
      if (!api || node?.rowIndex == null) return false;
      api.ensureIndexVisible(node.rowIndex, position);
      pinnedTailIdRef.current = null;
      chasedTopsRef.current = [];
      return true;
    },
    [getGridApi],
  );

  /** The newest row into view, or the displayed end when a filter hides it, so a filtered grid chases its matches. */
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
    chasedTopsRef.current = [...chasedTopsRef.current.slice(-(CHASED_TOPS_KEPT - 1)), api.getVerticalPixelRange().top];
  }, [newestRowId, tailOrder, getGridApi]);

  // A cleared cursor re-derives follow rather than forcing it on, which would yank a reader who scrolled off.
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
        parkViewport(sessionId, { following: attached, topRowId: topRowIdOf(api) });
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
        // Else the row it follows: at another height, the old top row may no longer show it.
        if (tailing) {
          park(true);
          latest.current.scrollToTail();
        } else if (cursor !== undefined && reopen) {
          park(true);
          reveal(cursor, "middle");
        }
      },
      // Rows landing above the viewport move the tail off screen with no scroll and no new newest row.
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
        parkViewport(sessionId, { following: isNowAttached, topRowId: topRowIdOf(api) });
      },
      onGridSizeChanged: () => {
        if (followRef.current && latest.current.isTailFollowing && renderedRef.current) latest.current.scrollToTail();
      },
    }),
    [getGridApi, sessionId, setFollowNow],
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
