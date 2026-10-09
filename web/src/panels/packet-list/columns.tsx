import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { memo } from "react";
import type { PacketField, PacketRow } from "./data";
import { GridCell, GridTextCell, MONO_VALUE_CELL } from "./grid/chrome";
import { text, type TimeMode } from "./grid/format";
import { gridTimeColumnDef } from "./grid/time-column";
import { endpointLabel, getProtoColor } from "./options";

/**
 * The columns are a fixed schema (Wireshark's packet list, over the fields of `zelos.packet.v1`), not
 * signals, so there is no per-column display format or removal.
 *
 * Filtering is AG Grid's built-in text filter, inherited from the shared default col def; the quick-filter
 * box and the display filter sit above the grid.
 *
 * Sorting is Time only (`useGridPanelState`'s default col def): sorting by another column would shuffle
 * packets out of capture order and break live-follow, which assumes the newest row is always at an end.
 */

/** The protocol, in its family's color: plain text. */
const PacketProtoCell = memo((props: ICellRendererParams<PacketRow>) => {
  const { data } = props;
  if (!data) return null;
  return (
    <GridCell>
      <span className="proto-label" style={{ color: getProtoColor(data.proto) }}>
        {data.proto}
      </span>
    </GridCell>
  );
});
PacketProtoCell.displayName = "PacketProtoCell";

/**
 * The byte count, right-aligned under its header so the digits line up down the column.
 *
 * The alignment is a class on the renderer's OWN flex row, not on the cell: AG Grid puts an
 * `.ag-cell-wrapper` and a `flex: 1 1 auto` `.ag-cell-value` span between `.ag-cell` and the renderer, so a
 * justify rule on the cell lands on the wrapper, whose one item already fills it, and never moves text.
 */
const PacketLengthCell = memo((props: ICellRendererParams<PacketRow>) => {
  const { data, value } = props;
  if (!data) return null;
  return <GridCell className="align-end">{text(value)}</GridCell>;
});
PacketLengthCell.displayName = "PacketLengthCell";

interface PacketColumnDefsParams {
  timeMode: TimeMode;
  /** `visiblePacketFields` — the same set the query projects, so a shown column always has data. */
  fields: ReadonlySet<PacketField>;
}

/**
 * The grid's columns. Built at module scope: a builder closed over the panel's render scope would pin a
 * whole `bufferSize` row buffer alive for as long as AG Grid holds the ColDefs.
 */
export function buildPacketColumnDefs({ timeMode, fields }: PacketColumnDefsParams): ColDef<PacketRow>[] {
  return [
    {
      colId: "no",
      headerName: "No.",
      width: 90,
      pinned: "left",
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => p.data?.frameNo ?? "",
      cellRenderer: GridTextCell,
    },
    {
      ...gridTimeColumnDef<PacketRow>(timeMode),
      width: 310,
      cellRenderer: GridTextCell,
    },
    {
      colId: "iface",
      headerName: "Interface",
      width: 120,
      hide: !fields.has("iface"),
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => p.data?.iface ?? "",
      cellRenderer: GridTextCell,
    },
    {
      colId: "source",
      headerName: "Source",
      width: 180,
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => (p.data ? endpointLabel(p.data.srcIp, p.data.srcPort) : ""),
      cellRenderer: GridTextCell,
    },
    {
      colId: "destination",
      headerName: "Destination",
      width: 180,
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => (p.data ? endpointLabel(p.data.dstIp, p.data.dstPort) : ""),
      cellRenderer: GridTextCell,
    },
    {
      colId: "proto",
      headerName: "Protocol",
      width: 110,
      valueGetter: (p) => p.data?.proto ?? "",
      cellRenderer: PacketProtoCell,
    },
    {
      colId: "length",
      headerName: "Length",
      width: 104,
      // The header and its filter icon, untruncated.
      minWidth: 104,
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => text(p.data?.origLen),
      cellRenderer: PacketLengthCell,
    },
    {
      colId: "vlan_id",
      headerName: "VLAN",
      width: 90,
      hide: !fields.has("vlan_id"),
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => text(p.data?.vlanId),
      cellRenderer: GridTextCell,
    },
    {
      colId: "frag_offset",
      headerName: "Frag Offset",
      width: 136,
      hide: !fields.has("frag_offset"),
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => text(p.data?.fragOffset),
      cellRenderer: GridTextCell,
    },
    {
      colId: "info",
      headerName: "Info",
      flex: 1,
      minWidth: 200,
      cellClass: MONO_VALUE_CELL,
      valueGetter: (p) => p.data?.info ?? "",
      cellRenderer: GridTextCell,
    },
  ];
}
