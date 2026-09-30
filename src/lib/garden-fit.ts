// Whether the Garden's birds fit, and how far the floating window must grow for them to fit (docs/design.md "Layout").
// garden.tsx uses the same functions for the bird size and the height the garden needs, so the growth is judged by
// the same rules as the drawing.

// Bird icon size limits (px). 26px is the smallest that stays readable (the user's decision; birds are not made
// smaller to fit)
const GLYPH_MIN_PX = 26;
const GLYPH_MAX_PX = 52;
// min-height of .garden in styles/garden.css (it is overridden via style, so never go below it)
export const GARDEN_MIN_HEIGHT_PX = 220;

/** Bird icon size from the garden's size (px) and the number of birds */
export function gardenGlyphSize(w: number, h: number, count: number): number {
  const raw = Math.sqrt((w * h) / Math.max(count, 1)) * 0.16;
  return Math.min(GLYPH_MAX_PX, Math.max(GLYPH_MIN_PX, Math.round(raw)));
}

/** What decides whether the birds fit, measured from the current screen (px, CSS pixels) */
export interface GardenFit {
  /** Number of birds (for the icon size) */
  count: number;
  /** Birds outside watching blocks (placed on the grid) */
  looseCount: number;
  /** One bird's width including the gap */
  nodeW: number;
  /** One bird's height excluding the icon (name, status lines, bubble room, marks, gap) */
  nodeExtraH: number;
  /** Total height of the watching blocks */
  blocksH: number;
  /** Window size minus the garden's size when it isn't stretched (header, tabs, padding) */
  overheadW: number;
  overheadH: number;
}

/** Height the garden needs for its birds at width w with icon size glyph (px) */
export function gardenNeededHeight(
  w: number,
  glyph: number,
  fit: Pick<GardenFit, "looseCount" | "nodeW" | "nodeExtraH" | "blocksH">,
): number {
  const cols = Math.max(1, Math.floor(w / fit.nodeW));
  return Math.max(GARDEN_MIN_HEIGHT_PX, Math.ceil(fit.looseCount / cols) * (glyph + fit.nodeExtraH) + fit.blocksH);
}

/** Whether the birds fit in a garden of w×h px */
export function gardenFits(w: number, h: number, fit: GardenFit): boolean {
  if (w <= 0 || h <= 0) return false;
  return gardenNeededHeight(w, gardenGlyphSize(w, h, fit.count), fit) <= h;
}

// Step of the scale search. Coarse enough to be cheap, fine enough that the window grows by a few px at a time
const SCALE_STEP = 0.02;
// Upper end of the search. The Rust side caps the window at the display's visible area anyway
export const MAX_FIT_SCALE = 8;

/**
 * The smallest scale (≥ 1) of the user's window size (userW×userH, CSS px) at which the birds fit. Width and height
 * grow by the same factor, keeping the aspect ratio of the user's size. Never below 1 (never smaller than the user's
 * size). MAX_FIT_SCALE when they don't fit even there
 */
export function gardenFitScale(userW: number, userH: number, fit: GardenFit): number {
  if (userW <= 0 || userH <= 0) return 1;
  for (let i = 0; ; i++) {
    const s = 1 + i * SCALE_STEP;
    if (s >= MAX_FIT_SCALE) return MAX_FIT_SCALE;
    if (gardenFits(userW * s - fit.overheadW, userH * s - fit.overheadH, fit)) return Math.round(s * 100) / 100;
  }
}

/** The scale last applied, with the number of birds and the user's size it was decided for */
export interface GrowKept {
  scale: number;
  count: number;
  userW: number;
  userH: number;
}

/**
 * The scale to apply, from the one last applied (kept) and the one needed now. Grows as soon as more is needed. While
 * the number of birds stays the same it doesn't shrink (bubbles and tool-name lines come and go and change the needed
 * height; shrinking on them made the window grow and shrink every few seconds, observed). Shrinks to the needed scale
 * only when birds left. A different user's size starts over from the needed scale
 */
export function nextGrowScale(
  kept: GrowKept | null,
  needed: number,
  count: number,
  userW: number,
  userH: number,
): number {
  if (!kept || kept.userW !== userW || kept.userH !== userH) return needed;
  if (needed >= kept.scale || count < kept.count) return needed;
  return kept.scale;
}
