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

const PENDING: FrameQuery = { status: "pending" };

/** The `frame` of `row`, fetched each time it opens; only the open packet's answer is held. */
export function useFrameQuery(bridge: BridgeTransport | null, row: PacketRow | null, live: boolean): FrameQuery {
  const [answer, setAnswer] = useState<{ row: PacketRow; query: FrameQuery } | null>(null);
  if (answer !== null && answer.row !== row) setAnswer(null);

  useEffect(() => {
    if (!row || !bridge) return;
    let current = true;
    fetchPacketEventFields(bridge, row, PACKET_FRAME_FIELDS, live).then(
      (data) => current && setAnswer({ row, query: { status: "success", data } }),
      (error: unknown) => current && setAnswer({ row, query: { status: "error", error } }),
    );
    return () => {
      current = false;
    };
  }, [bridge, row, live]);

  return answer?.row === row ? answer.query : PENDING;
}

function frameSummary(row: PacketRow): string {
  const flow = `${endpointLabel(row.srcIp, row.srcPort)} → ${endpointLabel(row.dstIp, row.dstPort)}`;
  return row.proto ? `${row.proto} ${flow}` : flow;
}

/** A cell as a finite number, or undefined: the pane says nothing rather than guessing. */
function numberCell(value: QueryCellValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Wireshark's details pane; `row` is a snapshot, so a live window rotating the packet out does not blank it. */
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
  // Only while focus is in the panel, so an Escape meant for something else is not also this pane's.
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
