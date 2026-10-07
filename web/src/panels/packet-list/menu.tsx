import type { PanelMenuItem } from "@zeloscloud/app-extension-sdk";
import type { PacketRow } from "./data";

/** What a right-click on a cell acts on: the packet it landed in, and the cell it landed on. */
export interface PacketMenuTarget {
  readonly row: PacketRow;
  /** The text that cell had on screen: what "Copy value" copies, verbatim. */
  readonly cellText: string;
}

export const PACKET_MENU = {
  setCursor: "set-cursor",
  copyValue: "copy-value",
  copyRowJson: "copy-row-json",
  viewFrame: "view-frame",
} as const;

/**
 * A cell's context menu, which the host draws: set cursor → copy value → copy row, the standard grid
 * order, plus the byte view. Cell-scoped, with no display format or copy path: a column here is a fixed
 * field, not a signal.
 *
 * "Copy value" is absent when the cell shows nothing. "View frame bytes" is absent, not disabled, when
 * the panel doesn't bind the stream's `frame`: there is nothing to go and look at. A stream that IS bound
 * but captured no bytes is a drawer message, not a missing item.
 */
export function packetMenuItems(target: PacketMenuTarget, canViewFrame: boolean): PanelMenuItem[] {
  // The cursor item moves the workspace, the rest act on the packet; a separator keeps the two apart.
  const items: PanelMenuItem[] = [
    { id: PACKET_MENU.setCursor, label: "Set cursor here", icon: "cursor", separatorAfter: true },
  ];
  if (target.cellText) items.push({ id: PACKET_MENU.copyValue, label: "Copy value", icon: "copy" });
  items.push({ id: PACKET_MENU.copyRowJson, label: "Copy row as JSON", icon: "json" });
  if (canViewFrame) items.push({ id: PACKET_MENU.viewFrame, label: "View frame bytes", icon: "bytes" });
  return items;
}
