import { colorSchemeDark, colorSchemeLight, themeQuartz } from "ag-grid-community";

// The base colors read the app's theme tokens; the accent and shades the tokens don't name stay literal.

const token = (name: string, fallback?: string) =>
  fallback === undefined ? `hsl(var(${name}))` : `hsl(var(${name}, ${fallback}))`;

/** violet-700: filter icons, sort arrows and range selection, as in the app's own grids. */
const ACCENT = "263.4 70% 50.4%";
const accent = (alpha?: number) => (alpha === undefined ? `hsl(${ACCENT})` : `hsl(${ACCENT} / ${alpha})`);

/** A cell's left and right padding. Quartz's own default. */
export const GRID_CELL_HORIZONTAL_PADDING_PX = 16;

const SHARED = {
  backgroundColor: token("--background"),
  foregroundColor: token("--foreground"),
  borderRadius: 0,
  accentColor: accent(),
  headerBackgroundColor: token("--card"),
  headerFontWeight: 500,
  rangeSelectionBorderColor: accent(),
  cellHorizontalPadding: GRID_CELL_HORIZONTAL_PADDING_PX,
  rowVerticalPaddingScale: 0.9,
} as const;

export const AG_GRID_THEME_LIGHT = themeQuartz.withPart(colorSchemeLight).withParams({
  ...SHARED,
  // AG Grid measures its row borders on mount, before the SDK writes the tokens; unresolved, it warns (#9).
  borderColor: token("--border", "0 0% 63.9%"),
  headerTextColor: "hsl(0, 0%, 20.9%)",
  oddRowBackgroundColor: "hsl(0, 0%, 91.5%)",
  rowHoverColor: token("--secondary"),
  selectedRowBackgroundColor: "hsla(250.5, 95.2%, 91.8%, 0.5)",
  rangeSelectionBackgroundColor: accent(0.1),
  rangeSelectionHighlightColor: accent(0.2),
});

export const AG_GRID_THEME_DARK = themeQuartz.withPart(colorSchemeDark).withParams({
  ...SHARED,
  borderColor: token("--border", "0 0% 14.9%"),
  headerTextColor: token("--muted-foreground"),
  oddRowBackgroundColor: "hsl(0, 0%, 5.5%)",
  rowHoverColor: token("--card"),
  selectedRowBackgroundColor: "hsla(263.5, 67.4%, 34.9%, 0.5)",
  rangeSelectionBackgroundColor: accent(0.15),
  rangeSelectionHighlightColor: accent(0.25),
});
