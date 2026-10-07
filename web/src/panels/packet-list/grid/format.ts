/**
 * Text helpers the grid and the row builders share. Pure: no React, no bridge.
 *
 * Times are seconds on the way in. A float holds epoch nanoseconds to about a microsecond, so every
 * printed instant stops at microseconds.
 */

/** What a row's `timeS` means: epoch seconds (`absolute`) or seconds from the trace start (`relative`). */
export type TimeMode = "absolute" | "relative";

/** The SDK carries time modes as an open union; anything but `relative` reads as wall-clock. */
export function toTimeMode(mode: string | null | undefined): TimeMode {
  return mode === "relative" ? "relative" : "absolute";
}

/**
 * A melted event field as text: null/absent renders as `""`, not `"null"`. Every field of an event
 * schema is nullable (an ARP frame has no ports), so cells are always read through this.
 */
export function text(value: unknown): string {
  return value == null ? "" : String(value);
}

const pad = (n: number, width = 2) => Math.floor(n).toString().padStart(width, "0");

/** The local zone's UTC offset at `date`, as `±HH:mm`. */
function utcOffsetOf(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  return `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
}

/** Local wall-clock with microseconds and the zone offset: `2026-01-15T14:30:45.123456+01:00`. */
function formatLocal(sec: number): string {
  if (!Number.isFinite(sec)) return "";
  // Whole nanoseconds through BigInt, so the microsecond digits are truncated, never carried by a float.
  const ns = BigInt(Math.trunc(sec * 1e9));
  const wholeSec = ns / 1_000_000_000n;
  const micros = (ns % 1_000_000_000n) / 1_000n;
  const d = new Date(Number(wholeSec * 1_000n));
  const base =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${base}.${micros.toString().padStart(6, "0")}${utcOffsetOf(d)}`;
}

/** Elapsed time with microseconds: `m:ss.uuuuuu`, or `h:mm:ss.uuuuuu` past an hour. */
function formatElapsed(sec: number): string {
  if (!Number.isFinite(sec)) return "";
  const sign = sec < 0 ? "-" : "";
  // Round to the microsecond first, then decompose with integer arithmetic, so 0.9999995 s cannot carry
  // into a "1:00.000000" that is off by a whole second.
  const totalUs = Math.round(Math.abs(sec * 1e9) / 1_000);
  const h = Math.floor(totalUs / 3_600_000_000);
  const m = Math.floor((totalUs % 3_600_000_000) / 60_000_000);
  const s = Math.floor((totalUs % 60_000_000) / 1_000_000);
  const frac = pad(totalUs % 1_000_000, 6);
  if (h > 0) return `${sign}${h}:${pad(m)}:${pad(s)}.${frac}`;
  return `${sign}${m}:${pad(s)}.${frac}`;
}

/** A row's instant as the time mode reads it: elapsed in a relative trace, local wall-clock otherwise. */
export function formatTimeByMode(sec: number, timeMode: TimeMode): string {
  return timeMode === "relative" ? formatElapsed(sec) : formatLocal(sec);
}

/**
 * Epoch seconds as a UTC ISO string with microseconds. `Date.toISOString` stops at milliseconds, which
 * would round a 2 ms query window down to nothing.
 */
export function secToISOString(sec: number): string {
  const ns = sec * 1e9;
  const wholeSec = Math.floor(ns / 1e9);
  const d = new Date(wholeSec * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const fracNs = ns - wholeSec * 1e9;
  const ms = Math.floor(fracNs / 1e6);
  const us = Math.floor((fracNs % 1e6) / 1e3);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(ms, 3)}${pad(us, 3)}Z`
  );
}
