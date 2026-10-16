import { memo } from "react";

const GLOB_CHARS = /[*?]/;

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * The quick filter's matcher. A plain word matches as a case-insensitive substring; a pattern with `*` or
 * `?` is a GLOB over the whole row, wrapped in `*` so `retry?of` still matches anywhere.
 */
export function createSearchMatcher(searchTerm: string): (text: string) => boolean {
  const trimmed = searchTerm.trim();
  if (!trimmed) return () => true;

  if (!GLOB_CHARS.test(trimmed)) {
    const needle = trimmed.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }

  const wrapped = `${trimmed.startsWith("*") ? "" : "*"}${trimmed}${trimmed.endsWith("*") ? "" : "*"}`;
  const regex = globToRegExp(wrapped);
  return (text) => regex.test(text);
}

/** The literal runs of a search term, wildcards excluded: what {@link Highlight} marks up. */
export function extractHighlightTerms(searchTerm: string): string[] {
  const trimmed = searchTerm.trim();
  if (!trimmed) return [];
  if (!GLOB_CHARS.test(trimmed)) return [trimmed];
  const literals = trimmed
    .split(/[*?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return literals.length > 0 ? literals : [trimmed];
}

/** `text` with every occurrence of `terms` marked, case-insensitively. */
export const Highlight = memo(({ text, terms }: { text: string; terms: readonly string[] }) => {
  const valid = terms.map((term) => term.trim()).filter((term) => term.length > 0);
  if (valid.length === 0) return <>{text}</>;

  const pattern = valid.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi"));
  return (
    <>
      {parts.map((part, index) => {
        const key = `hl-${index}`;
        const isMatch = valid.some((term) => part.toLowerCase() === term.toLowerCase());
        return isMatch ? (
          <span key={key} className="search-hit">
            {part}
          </span>
        ) : (
          <span key={key}>{part}</span>
        );
      })}
    </>
  );
});
Highlight.displayName = "Highlight";
