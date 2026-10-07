import { colorSchemeDark, colorSchemeLight, themeQuartz } from "ag-grid-community";

/*
 * The grid's two color schemes. The base colors read the theme tokens the SDK writes onto the document
 * root (`--background`, `--foreground`, `--border`, `--card`), so the grid follows the app's theme
 * exactly. The accent is the app's grid accent, violet-700, which is darker than `--primary`; it and the
 * shades the token set has no name for stay literal. Font FACE is not set here: only
 * value cells opt into mono (`MONO_VALUE_CELL`). Font SIZE is a panel option `useGridPanelState` applies.
 */

const token = (name: string, fallback?: string) =>
  fallback === undefined ? `hsl(var(${name}))` : `hsl(var(${name}, ${fallback}))`;

/** violet-700: filter icons, sort arrows and range selection, as in the app's own grids. */
const ACCENT = "263.4 70% 50.4%";
const accent = (alpha?: number) => (alpha === undefined ? `hsl(${ACCENT})` : `hsl(${ACCENT} / ${alpha})`);

const SHARED = {
  backgroundColor: token("--background"),
  foregroundColor: token("--foreground"),
  borderRadius: 0,
  accentColor: accent(),
  headerBackgroundColor: token("--card"),
  headerFontWeight: 500,
  rangeSelectionBorderColor: accent(),
  cellHorizontalPadding: 16,
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
