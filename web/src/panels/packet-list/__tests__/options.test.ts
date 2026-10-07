import { describe, expect, it } from "vitest";
import manifest from "../../../../../extension.toml?raw";
import schema from "../../../../public/panels/packet-list.options.json";
import {
  DEFAULT_PACKET_OPTIONS,
  MAX_BUFFER_SIZE,
  PACKET_TOGGLES,
  packetQueryFields,
  resolvePacketPanelOptions,
  visiblePacketFields,
} from "../options";
import { DEFAULT_GRID_FONT_PX } from "../grid/use-grid-state";

/** The Edit sheet's form, the code's defaults and the manifest's export list must not drift apart. */
describe("packet list options", () => {
  it("declares the code's defaults and the toggles' labels in the options schema", () => {
    const properties = schema.properties as Record<string, { title: string; description: string; default?: unknown }>;
    for (const [key, value] of Object.entries(DEFAULT_PACKET_OPTIONS)) {
      expect(properties[key]?.default, key).toBe(value);
    }
    for (const toggle of PACKET_TOGGLES) {
      expect(properties[toggle.key]).toMatchObject({ title: toggle.label, description: toggle.description });
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

  it("exports what the panel would show with Interface forced on, plus the fields rows need", () => {
    const exportLine = manifest.match(/^export = \{ fields = \[(.*)\], max_rows = (\d+) \}$/m);
    const fields = [...(exportLine?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    const expected = packetQueryFields(visiblePacketFields(resolvePacketPanelOptions(null), true));

    expect(fields).toEqual([...expected]);
    expect(exportLine?.[2]).toBe("100000");
  });
});
