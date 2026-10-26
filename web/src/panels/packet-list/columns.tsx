import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { memo } from "react";
import type { PacketField, PacketRow } from "./data";
import { GridCell, GridTextCell, MONO_VALUE_CELL } from "./grid/chrome";
import { text, type TimeMode } from "./grid/format";
import { gridTimeColumnDef } from "./grid/time-column";
import { endpointLabel, getProtoColor } from "./options";

// A fixed schema of fields, not signals, so no column has a display format or can be removed.

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

/** Right-aligned on the renderer's own row: a rule on the cell lands on AG Grid's wrapper and moves nothing. */
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
  /** The Time column's measured width; undefined where nothing can measure text. */
  timeWidth: number | undefined;
}

/** Built at module scope: a builder closed over the render scope would pin a whole row buffer in the ColDefs. */
export function buildPacketColumnDefs({ timeMode, fields, timeWidth }: PacketColumnDefsParams): ColDef<PacketRow>[] {
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
      ...gridTimeColumnDef<PacketRow>(timeMode, timeWidth),
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
