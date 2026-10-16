import { type ReactNode, useCallback, useMemo } from "react";
import { parseFrameHex } from "./hex-bytes";

/** Wireshark's byte view: 16 bytes to a line, offset on the left, printable ASCII on the right. */
const BYTES_PER_LINE = 16;

/** How many bytes are rendered: past a few thousand lines the pane is scroll, not information. */
export const FRAME_HEX_MAX_BYTES = 4096;

/** A run of frame bytes, as the dissection tree addresses it. */
export interface ByteRange {
  offset: number;
  len: number;
}

const SELECTED_BYTE_CLASS = "hex-selected";

/**
 * One line: `offset  hex bytes  ascii`, padded so all three columns line up under a mono face.
 *
 * Every byte is its own span carrying `data-offset` — that is what lets a click select the dissection node
 * containing it. The characters are exactly what a plain text dump would be, runs of spaces included.
 */
function hexLine(bytes: Uint8Array, start: number, selection: ByteRange | null, lastLine: boolean): ReactNode[] {
  const chunk = bytes.subarray(start, start + BYTES_PER_LINE);
  const selected = (offset: number) =>
    selection !== null && offset >= selection.offset && offset < selection.offset + selection.len
      ? SELECTED_BYTE_CLASS
      : undefined;

  const parts: ReactNode[] = [`${start.toString(16).padStart(4, "0")}  `];
  for (let i = 0; i < chunk.length; i++) {
    if (i > 0) parts.push(" ");
    const offset = start + i;
    parts.push(
      <span key={`h${offset}`} data-offset={offset} className={selected(offset)}>
        {(chunk[i] ?? 0).toString(16).padStart(2, "0")}
      </span>,
    );
  }

  // A short last line keeps the hex field's width, so the ASCII gutter stays in the same column.
  parts.push(" ".repeat((BYTES_PER_LINE - chunk.length) * 3), "  ");
  for (let i = 0; i < chunk.length; i++) {
    const offset = start + i;
    const byte = chunk[i] ?? 0;
    parts.push(
      <span key={`a${offset}`} data-offset={offset} className={selected(offset)}>
        {byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."}
      </span>,
    );
  }

  if (!lastLine) parts.push("\n");
  return parts;
}

interface FrameHexViewProps {
  hex: string;
  /** The capture's own snaplen flag, and the two lengths that say how much it kept. */
  truncated?: boolean | undefined;
  capLen?: number | undefined;
  origLen?: number | undefined;
  /** The selected dissection node's bytes, highlighted here. */
  selection?: ByteRange | null | undefined;
  /** A byte was clicked — the pane answers by selecting the node that contains it. */
  onSelectByte?: ((offset: number) => void) | undefined;
}

/**
 * What the CAPTURE dropped, distinct from the render cap above. Stated even when the capture forgot to
 * set its own `truncated` flag and only the lengths disagree: a short frame read as a whole one is wrong.
 */
function snaplenNote(
  byteCount: number,
  { truncated, capLen, origLen }: Pick<FrameHexViewProps, "truncated" | "capLen" | "origLen">,
): string | null {
  if (origLen == null) return null;
  const captured = capLen ?? byteCount;
  if (!truncated && captured >= origLen) return null;
  return `truncated at snaplen (${captured} of ${origLen} bytes captured)`;
}

/** The captured frame's bytes, hex + ASCII. */
export function FrameHexView({ hex, truncated, capLen, origLen, selection, onSelectByte }: FrameHexViewProps) {
  const { shown, truncatedBytes, note } = useMemo(() => {
    const bytes = parseFrameHex(hex);
    const shown = bytes.length > FRAME_HEX_MAX_BYTES ? bytes.subarray(0, FRAME_HEX_MAX_BYTES) : bytes;
    return {
      shown,
      truncatedBytes: bytes.length - shown.length,
      note: snaplenNote(bytes.length, { truncated, capLen, origLen }),
    };
  }, [hex, truncated, capLen, origLen]);

  // One handler on the block rather than one per byte: a 4 kB frame is 8192 spans.
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      const offset = event.target instanceof HTMLElement ? event.target.dataset.offset : undefined;
      if (offset !== undefined) onSelectByte?.(Number(offset));
    },
    [onSelectByte],
  );

  const lines = useMemo(() => {
    const parts: ReactNode[] = [];
    for (let start = 0; start < shown.length; start += BYTES_PER_LINE) {
      parts.push(...hexLine(shown, start, selection ?? null, start + BYTES_PER_LINE >= shown.length));
    }
    return parts;
  }, [shown, selection]);

  if (shown.length === 0) {
    return <p className="muted">No frame bytes were captured for this packet.</p>;
  }

  return (
    <>
      {/* Clicking a byte mirrors the tree, which is itself a list of buttons and keyboard-reachable. */}
      <pre
        data-testid="frame-hex-view"
        className="hex-view"
        onClick={handleClick}
      >
        {lines}
        {truncatedBytes > 0 && `\n… ${truncatedBytes} more bytes`}
      </pre>
      {note && <p className="hex-note muted">{note}</p>}
    </>
  );
}
