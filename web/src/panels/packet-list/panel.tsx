import type { AppBridgePanelInfo } from "@zeloscloud/app-extension-sdk";
import {
  usePanel,
  usePanelActions,
  useTimeState,
  useWorkspace,
  useZelosBridge,
} from "@zeloscloud/app-extension-sdk/react";
import type { IRowNode, ModelUpdatedEvent, RowClickedEvent, RowSelectionOptions } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildPacketColumnDefs } from "./columns";
import type { PacketRow } from "./data";
import { fetchPacketEventFields, PACKET_EVENT_FIELDS, PacketEventGoneError, packetRowJson } from "./event-fetch";
import { parsePacketFilter } from "./filter";
import { PacketFilterBar } from "./filter-bar";
import { PacketFrameDrawer, useFrameQuery } from "./frame-drawer";
import {
  GridContextMenu,
  type GridMenuCell,
  GridPanelBody,
  GridStatusStrip,
  PanelState,
  windowStatus,
} from "./grid/chrome";
import { wasLeftDetached } from "./grid/follow";
import { toTimeMode } from "./grid/format";
import { useGridPanelState, useGridRowLookup } from "./grid/use-grid-state";
import { useTimeGrid } from "./grid/time-grid";
import { PACKET_MENU, type PacketMenuTarget, packetMenuItems } from "./menu";
import { packetQueryFields, resolvePacketPanelOptions, visiblePacketFields } from "./options";
import { splitPacketSignals } from "./stats";
import { usePacketData } from "./use-packet-data";
import { usePacketStats } from "./use-packet-stats";

const PACKET_GONE = "This packet is no longer available.";
/** A window with packets but no `frame_no`: the capture predates the column the panel keys on. */
const UNNUMBERED =
  "This capture carries no frame numbers. Update the Packet extension and restart it to list its packets.";
const EMPTY_MESSAGE = "Drag a packet source here";

/** Clicking a row selects it and opens its frame in the drawer, Wireshark's packet list. */
const ROW_SELECTION: RowSelectionOptions<PacketRow> = {
  mode: "singleRow",
  checkboxes: false,
  enableClickSelection: true,
};

const NoRowsOverlay = () => <PanelState description="No packets in this time range" />;
const LoadingOverlay = () => <PanelState description="Loading packets…" />;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PacketListContent({ panel }: { panel: AppBridgePanelInfo }) {
  const { bridge } = useZelosBridge();
  const actions = usePanelActions();
  const time = useTimeState();
  const workspace = useWorkspace();
  const live = workspace?.modeKind === "LIVE";
  const timeMode = toTimeMode(time?.mode);

  const opts = useMemo(() => resolvePacketPanelOptions(panel.options), [panel.options]);
  // A capture's node binds both its events: the packet fields drive the grid, the stats fields the strip.
  const { packets: packetSignals, stats: statsSignals } = useMemo(
    () => splitPacketSignals(panel.signals),
    [panel.signals],
  );

  const { search, getGridApi, columnState, gridProps } = useGridPanelState<PacketRow>({
    instanceId: panel.instanceId,
    options: panel.options,
    noRowsOverlay: NoRowsOverlay,
    loadingOverlay: LoadingOverlay,
  });

  const needsProducerDisambiguation = panel.environment.needsProducerDisambiguation;

  // Dragging the whole source node binds every capture it holds (eth0 AND wlan0) into one panel, whose
  // rows then interleave. `needsProducerDisambiguation` counts AGENTS, so it does not see this case.
  const bindsMultipleStreams = useMemo(
    () => new Set(packetSignals.map((signal) => `${signal.source}\u0000${signal.message}`)).size > 1,
    [packetSignals],
  );

  // ONE field set drives both the columns' `hide` and the subscription's projection, so the panel can
  // never fetch a field no column shows, nor show a column whose field it forgot to ask for.
  const visibleFields = useMemo(
    () => visiblePacketFields(opts, needsProducerDisambiguation || bindsMultipleStreams),
    [opts, needsProducerDisambiguation, bindsMultipleStreams],
  );
  const queryFields = useMemo(() => packetQueryFields(visibleFields), [visibleFields]);

  // Scrolled off the live tail, the window stops updating: at packet rates the buffered window would
  // otherwise rotate out from under the reader within seconds. `follow` is offered exactly while detached.
  const [frozen, setFrozen] = useState(() => wasLeftDetached(panel.instanceId));
  const { rows, totalRows, isLoading, error, unnumbered } = usePacketData(
    packetSignals,
    opts.bufferSize,
    queryFields,
    frozen,
  );
  const stats = usePacketStats(statsSignals);

  const reportError = useCallback(
    (title: string, cause: unknown) => {
      actions.toast({ tone: "error", title, description: errorMessage(cause) }).catch((failure: unknown) => {
        console.warn(`[packet-list] ${title}`, cause, failure);
      });
    },
    [actions],
  );

  // The display filter runs over the BUFFERED window through AG Grid's external-filter hooks, so it and
  // the plain substring search compose instead of replacing each other. An invalid expression is not
  // applied: `predicate` stays null and the bar marks the offending token.
  const [filterText, setFilterText] = useState("");
  const parsedFilter = useMemo(() => parsePacketFilter(filterText, queryFields), [filterText, queryFields]);
  const predicate = parsedFilter.ok ? parsedFilter.predicate : null;

  // Through a ref: AG Grid holds these callbacks for the panel's life, and a new identity per keystroke
  // would rebuild its filter pipeline. The effect publishes each new predicate and tells the grid to
  // re-run them, so a render React discards cannot change what is filtered.
  const predicateRef = useRef(predicate);
  const isExternalFilterPresent = useCallback(() => predicateRef.current !== null, []);
  const doesExternalFilterPass = useCallback((node: IRowNode<PacketRow>) => {
    const test = predicateRef.current;
    return test === null || node.data === undefined ? true : test(node.data);
  }, []);

  useEffect(() => {
    predicateRef.current = predicate;
    getGridApi()?.onFilterChanged();
  }, [predicate, getGridApi]);

  // What the grid is SHOWING, read from the grid rather than recomputed: the search narrows it too.
  const [displayedRows, setDisplayedRows] = useState(0);

  // The fetched window is the whole scope, so the strip says so rather than implying the capture.
  const filterStatus =
    predicate === null
      ? null
      : `matching ${displayedRows.toLocaleString()} of ${rows.length.toLocaleString()} buffered`;
  // The buffer cut the window: say how much of it is on screen, or a filter over it reads as the truth.
  const windowNote = windowStatus(rows.length, totalRows);

  const { onSetCursor, rowClassRules, gridEvents, follow } = useTimeGrid<PacketRow>({
    instanceId: panel.instanceId,
    rows,
    getGridApi,
    columnState,
    rowHeight: gridProps.rowHeight,
    autoScroll: opts.autoScroll,
    onError: reportError,
  });
  useEffect(() => setFrozen(follow !== undefined), [follow]);

  const onModelUpdated = useCallback(
    (event: ModelUpdatedEvent<PacketRow>) => {
      setDisplayedRows(event.api.getDisplayedRowCount());
      gridEvents.onModelUpdated();
    },
    [gridEvents],
  );

  const columnDefs = useMemo(() => buildPacketColumnDefs({ timeMode, fields: visibleFields }), [timeMode, visibleFields]);

  // The menu resolves the clicked cell itself, and what it gets back is a SNAPSHOT, which lets it (and
  // the drawer it opens) outlive live rows rotating that packet out.
  const lookupRow = useGridRowLookup(rows);
  const resolveMenuTarget = useCallback(
    (cell: GridMenuCell): PacketMenuTarget | null => {
      const row = lookupRow(cell.rowId);
      return row ? { row, cellText: cell.text } : null;
    },
    [lookupRow],
  );

  const [frameRow, setFrameRow] = useState<PacketRow | null>(null);
  const onRowClicked = useCallback((event: RowClickedEvent<PacketRow>) => {
    if (event.data) setFrameRow(event.data);
  }, []);
  // The menu path selects the row as a click would, so the list and the pane always agree on which packet.
  const openFrame = useCallback(
    (row: PacketRow) => {
      getGridApi()?.getRowNode(row.id)?.setSelected(true);
      setFrameRow(row);
    },
    [getGridApi],
  );
  const closeFrame = useCallback(() => {
    setFrameRow(null);
    getGridApi()?.deselectAll();
  }, [getGridApi]);
  const frameQuery = useFrameQuery(bridge, frameRow, live);

  const copyRow = useCallback(
    async (row: PacketRow) => {
      if (!bridge) return;
      let json: Record<string, unknown>;
      try {
        json = packetRowJson(row, await fetchPacketEventFields(bridge, row, PACKET_EVENT_FIELDS, live));
      } catch (error) {
        reportError("Couldn't copy the packet", error instanceof PacketEventGoneError ? PACKET_GONE : error);
        return;
      }
      await actions.copyText(JSON.stringify(json), "Row copied as JSON");
    },
    [bridge, live, actions, reportError],
  );

  // Whether the panel binds this packet's stream's `frame` field at all: gated on the STREAM, not on a
  // per-row value, since the row carries no bytes.
  const canViewFrame = useCallback(
    (row: PacketRow) =>
      packetSignals.some(
        (signal) => signal.signal === "frame" && signal.source === row.source && signal.message === row.message,
      ),
    [packetSignals],
  );

  const openMenu = useCallback(
    (target: PacketMenuTarget, point: { x: number; y: number }) => {
      const run = async () => {
        const choice = await actions.showMenu({ ...point, items: packetMenuItems(target, canViewFrame(target.row)) });
        switch (choice) {
          case PACKET_MENU.setCursor:
            onSetCursor(target.row.timeS);
            return;
          case PACKET_MENU.copyValue:
            await actions.copyText(target.cellText, "Value copied");
            return;
          case PACKET_MENU.copyRowJson:
            await copyRow(target.row);
            return;
          case PACKET_MENU.viewFrame:
            openFrame(target.row);
            return;
          default:
            return;
        }
      };
      run().catch((error: unknown) => reportError("Couldn't complete the menu action", error));
    },
    [actions, canViewFrame, onSetCursor, copyRow, openFrame, reportError],
  );

  return (
    <GridPanelBody
      error={error}
      search={search}
      toolbar={
        <PacketFilterBar value={filterText} onChange={setFilterText} error={parsedFilter.ok ? null : parsedFilter} />
      }
      follow={follow}
      footer={
        <>
          {frameRow && <PacketFrameDrawer row={frameRow} query={frameQuery} onClose={closeFrame} />}
          <GridStatusStrip
            testId="packet-stats-strip"
            parts={[
              filterStatus !== null && (
                <span key="filter" data-testid="packet-filter-status">
                  {filterStatus}
                </span>
              ),
              windowNote !== null && (
                <span key="window" data-testid="packet-window-status">
                  {windowNote}
                </span>
              ),
              stats !== null && <span key="stats">{stats}</span>,
            ]}
          />
        </>
      }
    >
      {unnumbered ? (
        <PanelState description={UNNUMBERED} />
      ) : (
        <GridContextMenu resolveTarget={resolveMenuTarget} onOpen={openMenu}>
          <AgGridReact<PacketRow>
            {...gridProps}
            rowData={rows}
            columnDefs={columnDefs}
            rowClassRules={rowClassRules}
            loading={isLoading}
            {...gridEvents}
            isExternalFilterPresent={isExternalFilterPresent}
            doesExternalFilterPass={doesExternalFilterPass}
            onModelUpdated={onModelUpdated}
            rowSelection={ROW_SELECTION}
            onRowClicked={onRowClicked}
          />
        </GridContextMenu>
      )}
    </GridPanelBody>
  );
}

/** The Packet List: Wireshark's packet list over the packets a capture writes, with its details pane. */
export function PacketListPanel() {
  const panel = usePanel();
  if (!panel) return <PanelState description="Connecting to Zelos…" />;
  if (panel.signals.length === 0) return <PanelState description={EMPTY_MESSAGE} />;
  return <PacketListContent panel={panel} />;
}
