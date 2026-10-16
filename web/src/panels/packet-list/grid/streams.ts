import type { AppBridgePanelSignal, ColumnMetadata } from "@zeloscloud/app-extension-sdk";

/** The identity fields a data column is matched against a bound signal by. */
type ColumnIdentity = Pick<ColumnMetadata, "source" | "message" | "signal" | "producer" | "tracePath" | "dataSegmentId">;

/** The fields of a bound signal its ownership of a column depends on. */
export type BoundSignal = Pick<
  AppBridgePanelSignal,
  "source" | "message" | "signal" | "producer" | "tracePath" | "dataSegmentId"
>;

/**
 * Does `signal` own `column`? Same path, and every scope axis the signal pins (producer, trace, segment)
 * agrees; an axis the signal leaves unset admits every value on it.
 */
function ownsColumn(signal: BoundSignal, column: ColumnIdentity): boolean {
  if (column.source !== signal.source || column.message !== signal.message || column.signal !== signal.signal) {
    return false;
  }
  if (signal.producer != null && (column.producer ?? null) !== signal.producer) return false;
  if (signal.tracePath != null && (column.tracePath ?? null) !== signal.tracePath) return false;
  if (signal.dataSegmentId && signal.dataSegmentId !== (column.dataSegmentId ?? null)) return false;
  return true;
}

/**
 * Does the panel still bind this column? The query is wildcard-by-path and answers for EVERY scope of a
 * bound path, including scopes since removed, so the bound signals are the only source of truth. An empty
 * list means no membership to check.
 */
function isColumnOwnedByPanel(column: ColumnIdentity, signals: readonly BoundSignal[]): boolean {
  return signals.length === 0 || signals.some((signal) => ownsColumn(signal, column));
}

/**
 * One bound stream, i.e. one backend table. The query registers a table per
 * `(agent, segment, source, event)` and aliases its columns fully qualified, so each stream owns a
 * disjoint set of column indices.
 */
export interface FieldStream<F extends string> {
  /** Stable identity of the backend table: what makes a row's id unique across concurrent streams. */
  key: string;
  producer: string | null;
  tracePath: string | null;
  /** The stream's catalog coordinates, which name a signal path back to this same table. */
  source: string;
  message: string;
  /** Column index per field, or -1 when this stream doesn't carry that field. */
  fields: Record<F, number>;
}

/**
 * A column's stream identity: `(tracePath, producer, dataSegmentId, source, message)`. The segment is part
 * of the key because concurrent segments of one source are distinct tables with distinct rows.
 */
export function streamKeyOf(column: ColumnMetadata): string {
  return [column.tracePath, column.producer, column.dataSegmentId, column.source, column.message]
    .map((part) => part ?? "")
    .join("\u0000");
}

/**
 * Group a query's scope-exploded columns into the streams they came from.
 *
 * Columns outside `schemaFields` are ignored, and columns the panel no longer binds are dropped. A field
 * the query didn't project keeps its `-1`, so a projected fetch melts the same way a full one does.
 */
export function buildFieldStreams<F extends string>(
  columns: readonly ColumnMetadata[],
  timeColumnIndex: number,
  panelSignals: readonly BoundSignal[],
  schemaFields: readonly F[],
): FieldStream<F>[] {
  const schema = new Set<string>(schemaFields);
  const streams = new Map<string, FieldStream<F>>();

  for (let i = 0; i < columns.length; i++) {
    if (i === timeColumnIndex) continue;
    const column = columns[i];
    if (!column) continue;
    if (!schema.has(column.signal)) continue;
    if (!isColumnOwnedByPanel(column, panelSignals)) continue;

    const key = streamKeyOf(column);
    let stream = streams.get(key);
    if (!stream) {
      const fields = {} as Record<F, number>;
      for (const field of schemaFields) fields[field] = -1;
      stream = {
        key,
        producer: column.producer,
        tracePath: column.tracePath,
        source: column.source,
        message: column.message,
        fields,
      };
      streams.set(key, stream);
    }
    stream.fields[column.signal as F] = i;
  }

  return [...streams.values()];
}
