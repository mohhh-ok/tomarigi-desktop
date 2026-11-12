// Cutting a text short so its line fits a number of lines (docs/design.md "Concierge": each state line shows at most 2
// lines and ends with 「…」 when cut). Whether a candidate fits is asked of the caller (the page lays it out and measures
// it), so the choice of where to cut is kept apart from the page and tested on its own

export const ELLIPSIS = "…";

/** The text in user-perceived characters (graphemes), so a cut never splits an emoji or a letter with its mark */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/** The text cut at `count` graphemes, with the spaces before the cut dropped and 「…」 after it */
function cutAt(parts: string[], count: number): string {
  return parts.slice(0, count).join("").trimEnd() + ELLIPSIS;
}

/**
 * The longest form of `text` for which `fits` holds: the whole text if it fits, else its longest start that fits with
 * 「…」 after it (found by halving, so a long text costs a few layouts, not one per character), else 「…」 alone. `fits`
 * must not fit a longer text where it doesn't fit a shorter one
 */
export function clampText(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const parts = graphemes(text);
  // lo graphemes are known to fit (0: 「…」 alone, taken even when it doesn't fit, since there is nothing shorter);
  // hi is known not to
  let lo = 0;
  let hi = parts.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(cutAt(parts, mid))) lo = mid;
    else hi = mid;
  }
  return cutAt(parts, lo);
}

/** How many lines a box of this height holds at this line height (a half line's slack, for rounding) */
export function linesIn(height: number, lineHeight: number): number {
  return lineHeight > 0 ? Math.round(height / lineHeight) : 0;
}
