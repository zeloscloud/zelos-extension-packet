import { describe, expect, it } from "vitest";
import schema from "../../../../public/panels/packet-list.options.json";
import { DEFAULT_PACKET_OPTIONS, MAX_BUFFER_SIZE, resolvePacketPanelOptions } from "../options";
import {
  DEFAULT_GRID_FONT_PX,
  resolveFilterModel,
  resolveGridFontSize,
} from "../grid/use-grid-state";

/** The panel settings' form and the code's defaults must not drift apart. */
describe("packet list options", () => {
  it("declares the code's defaults in the options schema, with the settings' titles", () => {
    const properties = schema.properties as Record<
      string,
      { title: string; description: string; default?: unknown }
    >;
    for (const [key, value] of Object.entries(DEFAULT_PACKET_OPTIONS)) {
      expect(properties[key]?.default, key).toBe(value);
    }
    expect(schema.properties.bufferSize.maximum).toBe(MAX_BUFFER_SIZE);
    // Sentence case, as everywhere else in the app's settings.
    expect(Object.values(properties).map((property) => property.title)).toEqual([
      "Show interface",
      "Show VLAN",
      "Show fragment offset",
      "Font size",
      "Auto-scroll",
      "Buffer size",
    ]);
    expect(schema.properties.fontSize.default).toBe(DEFAULT_GRID_FONT_PX);
    expect(schema.properties.fontSize["ui:options"]).toEqual({ unit: "px" });
  });

  it("reads every option a saved layout holds", () => {
    const filterModel = { proto: { filterType: "text", type: "equals", filter: "TCP" } };
    const saved = {
      showInterface: true,
      showVlan: true,
      showFragOffset: true,
      autoScroll: false,
      bufferSize: 500,
      fontSize: 18,
      grid: { filterModel },
    };
    expect(resolvePacketPanelOptions(saved)).toEqual({
      showInterface: true,
      showVlan: true,
      showFragOffset: true,
      autoScroll: false,
      bufferSize: 500,
    });
    expect(resolveFilterModel(saved)).toEqual(filterModel);
    // Whole px; null is the default size.
    expect(schema.properties.fontSize.type).toBe("integer");
    expect(resolveGridFontSize(saved)).toBe(18);
    expect(resolveGridFontSize({ fontSize: null })).toBe(DEFAULT_GRID_FONT_PX);
  });
});
