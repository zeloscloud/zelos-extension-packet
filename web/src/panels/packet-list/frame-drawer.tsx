import type { BridgeTransport, QueryCellValue } from "@zeloscloud/app-extension-sdk";
import { useEffect, useRef, useState } from "react";
import type { PacketRow } from "./data";
import { PacketDissectView } from "./dissect-view";
import { fetchPacketEventFields, PACKET_FRAME_FIELDS } from "./event-fetch";
import { text } from "./grid/format";
import { ClearIcon } from "./icon";
import { endpointLabel } from "./options";

const FRAME_GONE = "This packet's frame is no longer available.";
const FRAME_LOADING = "Fetching frame bytes…";

/** The one-packet fetch behind the drawer. */
type FrameQuery =
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "success"; data: Record<string, QueryCellValue> };

/** A packet's identity, and the mode its window is expressed in: what the fetch is keyed on. */
const frameKey = (row: PacketRow) => `${row.streamKey}\u0000${row.frameNo}\u0000${row.timeMode}`;

/**
 * The `frame` of `row`, fetched once. A packet is immutable and the fetch is one-shot: an answer is cached
 * for the panel's life, never polled, and a "gone" is never retried.
 */
export function useFrameQuery(bridge: BridgeTransport | null, row: PacketRow | null, live: boolean): FrameQuery {
  const cache = useRef(new Map<string, FrameQuery>());
  const [, rerender] = useState(0);
  const key = row ? frameKey(row) : null;

  useEffect(() => {
    if (!row || !bridge || key === null || cache.current.has(key)) return;
    cache.current.set(key, { status: "pending" });
    fetchPacketEventFields(bridge, row, PACKET_FRAME_FIELDS, live).then(
      (data) => cache.current.set(key, { status: "success", data }),
      (error: unknown) => cache.current.set(key, { status: "error", error }),
    ).finally(() => rerender((n) => n + 1));
  }, [bridge, row, key, live]);

  return (key !== null && cache.current.get(key)) || { status: "pending" };
}

function frameSummary(row: PacketRow): string {
  const flow = `${endpointLabel(row.srcIp, row.srcPort)} → ${endpointLabel(row.dstIp, row.dstPort)}`;
  return row.proto ? `${row.proto} ${flow}` : flow;
}

/** A cell as a finite number, or undefined: the pane says nothing rather than guessing. */
function numberCell(value: QueryCellValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Wireshark's details pane, docked under the packet list: the clicked packet's dissection tree and bytes,
 * fetched for that ONE packet. Clicking another row swaps it in place; the close button or Escape
 * dismisses it. `row` is a snapshot, so a live window rotating the packet out does not blank the pane.
 */
export function PacketFrameDrawer({
  row,
  query,
  onClose,
}: {
  row: PacketRow;
  query: FrameQuery;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // Escape closes the pane only while focus is in the panel (a click in the panel focuses it), so an
  // Escape meant for something else is not also this pane's.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const panel = ref.current?.closest("[data-grid-panel]");
      if (panel?.contains(document.activeElement)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <section ref={ref} aria-label="Frame details" data-testid="packet-frame-drawer" className="frame-drawer">
      <div className="frame-drawer-header">
        <span className="mono muted">No. {row.frameNo}</span>
        <span className="mono truncate">{frameSummary(row)}</span>
        <button type="button" className="ghost-button close-button" aria-label="Close frame details" onClick={onClose}>
          <ClearIcon />
        </button>
      </div>
      <div className="frame-drawer-body">
        {query.status === "pending" && <p className="muted">{FRAME_LOADING}</p>}
        {query.status === "error" && <p className="muted">{FRAME_GONE}</p>}
        {query.status === "success" && (
          <PacketDissectView
            hex={text(query.data.frame)}
            linkType={numberCell(query.data.link_type) ?? null}
            truncated={row.truncated === true}
            capLen={numberCell(row.capLen)}
            origLen={numberCell(row.origLen)}
          />
        )}
      </div>
    </section>
  );
}
