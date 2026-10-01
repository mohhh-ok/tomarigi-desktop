// Whether the Garden's birds fit, and how far the floating window must grow for them to fit (docs/design.md "Layout").
// The Garden reports whether its actual placement (placeBoxes in lib/garden-place.ts, with the birds on screen kept
// where they are) left a bird without a free spot. The window grows only then, and only by as much as needed.

import { PLACE_GAP_PX, placeBoxes } from "./garden-place";

// Bird icon size limits (px). 26px is the smallest that stays readable (the user's decision; birds are not made
// smaller to fit)
const GLYPH_MIN_PX = 26;
const GLYPH_MAX_PX = 52;
// Least garden height the window growth aims for. The garden itself has no min-height: it never grows past the
// window (docs/design.md "Layout")
export const GARDEN_MIN_HEIGHT_PX = 220;

/** Bird icon size from the garden's size (px) and the number of birds */
export function gardenGlyphSize(w: number, h: number, count: number): number {
  const raw = Math.sqrt((w * h) / Math.max(count, 1)) * 0.16;
  return Math.min(GLYPH_MAX_PX, Math.max(GLYPH_MIN_PX, Math.round(raw)));
}

/** One footprint (a bird or a watch block). Its height is h0 + rows × the icon size, since the icon size depends on the garden size */
export interface FitBox {
  w: number;
  h0: number;
  rows: number;
}

/** What decides whether the birds fit, measured from the current screen (px, CSS pixels) */
export interface GardenFit {
  /** Number of birds (for the icon size) */
  count: number;
  /** Footprints, blocks first */
  boxes: FitBox[];
  /** The actual placement at the current garden size left a bird or block without a free spot */
  overflow: boolean;
  /** Largest footprint that had no free spot (px at the current icon size) */
  overflowW: number;
  overflowH: number;
  /** Garden size the placement was made at (its height without its own stretching) */
  gardenW: number;
  gardenH: number;
  /** Window size minus the garden's size when it isn't stretched (header, tabs, padding) */
  overheadW: number;
  overheadH: number;
  /**
   * The actual placement tried at another garden size (w×h, unstretched), as if the window were resized to it: how
   * many birds or blocks would have no spot, and how many on screen would have to move. Not part of the JSON sent
   */
  simulate?: (w: number, h: number) => { overflow: number; moved: number };
}

/**
 * Whether the footprints fit in an empty garden of w×h px, packed from the top-left (placeBoxes). Used only to find how
 * far to grow; whether to grow at all comes from the actual placement (GardenFit.overflow)
 */
export function gardenFits(w: number, h: number, fit: Pick<GardenFit, "count" | "boxes">): boolean {
  if (w <= 0 || h < GARDEN_MIN_HEIGHT_PX) return false;
  const glyph = gardenGlyphSize(w, h, fit.count);
  // Packed from the top-left (each box at the free spot nearest to the corner): the least room they can take
  const boxes = fit.boxes.map((b, i) => ({ id: String(i), w: b.w, h: b.h0 + b.rows * glyph, want: { x: 0, y: 0 } }));
  return placeBoxes(boxes, w, h).overflow.length === 0;
}

// Step of the scale search. Coarse enough to be cheap, fine enough that the window grows by a few px at a time
const SCALE_STEP = 0.02;
// Upper end of the search. The Rust side caps the window at the display's visible area anyway
export const MAX_FIT_SCALE = 8;

const roundUp = (s: number) => Math.min(MAX_FIT_SCALE, Math.ceil(s / SCALE_STEP - 1e-9) * SCALE_STEP);

/** The smallest scale (≥ 1) of the user's window size at which the footprints fit in an empty garden */
function emptyFitScale(userW: number, userH: number, fit: GardenFit): number {
  const fits = (s: number) => gardenFits(userW * s - fit.overheadW, userH * s - fit.overheadH, fit);
  if (fits(1)) return 1;
  if (!fits(MAX_FIT_SCALE)) return MAX_FIT_SCALE;
  // Binary search over steps (more room never makes them fit worse in practice)
  let lo = 0;
  let hi = Math.round((MAX_FIT_SCALE - 1) / SCALE_STEP);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(1 + mid * SCALE_STEP)) hi = mid;
    else lo = mid;
  }
  return Math.round((1 + hi * SCALE_STEP) * 100) / 100;
}

/**
 * The scale of the user's window size (userW×userH, CSS px) the birds need, given the scale applied now (current).
 * Width and height grow by the same factor, keeping the aspect ratio of the user's size. Never below 1.
 * - Something overflowed at the current size: the smallest larger scale at which the actual placement (fit.simulate,
 *   with the birds on screen kept at the same place on screen) gives everything a spot without moving anyone; failing
 *   that, the smallest at which everything has a spot
 * - Nothing overflowed: never more than current (no growing when they fit; the user's report was a window grown with
 *   the birds sparse). The smallest scale at which nothing would overflow or move, for shrinking back after birds left
 *   (nextGrowScale decides whether to shrink)
 * Without fit.simulate, an estimate: enough for the footprints to fit in an empty garden, and when something
 * overflowed, at least a strip as wide or tall as the footprint that had no spot
 */
export function gardenFitScale(userW: number, userH: number, fit: GardenFit, current = 1): number {
  if (userW <= 0 || userH <= 0) return 1;
  const base = Math.max(1, current);
  const steps = Math.round((MAX_FIT_SCALE - 1) / SCALE_STEP);
  const scaleAt = (i: number) => Math.round((1 + i * SCALE_STEP) * 100) / 100;
  const simulate = fit.simulate;
  if (simulate) {
    const at = (s: number) => simulate(userW * s - fit.overheadW, userH * s - fit.overheadH);
    // Smallest step index in lo..hi for which ok holds, assuming more room never makes it worse (binary search: a
    // placement can take tens of ms with many birds, so not every step is tried)
    const first = (lo: number, hi: number, ok: (s: number) => boolean): number | undefined => {
      if (lo > hi || !ok(scaleAt(hi))) return undefined;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (ok(scaleAt(mid))) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const baseStep = Math.round((base - 1) / SCALE_STEP);
    if (fit.overflow) {
      const placed = first(baseStep + 1, steps, (s) => at(s).overflow === 0);
      if (placed === undefined) return MAX_FIT_SCALE;
      // A little more room may also spare the birds on screen from moving
      for (let i = placed; i <= Math.min(steps, placed + 10); i++) {
        const r = at(scaleAt(i));
        if (r.overflow === 0 && r.moved === 0) return scaleAt(i);
      }
      return scaleAt(placed);
    }
    const keep = first(0, baseStep - 1, (s) => {
      const r = at(s);
      return r.overflow === 0 && r.moved === 0;
    });
    return keep === undefined ? base : scaleAt(keep);
  }
  const empty = emptyFitScale(userW, userH, fit);
  if (!fit.overflow) return Math.min(empty, base);
  const strip = base + Math.min((fit.overflowW + PLACE_GAP_PX) / userW, (fit.overflowH + PLACE_GAP_PX) / userH);
  return Math.round(roundUp(Math.max(empty, strip)) * 100) / 100;
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
 * the number of birds stays the same it doesn't shrink (bubbles and tool-name lines come and go; shrinking on them
 * made the window grow and shrink every few seconds, observed). Shrinks to the needed scale only when birds left.
 * A different user's size starts over from the needed scale
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
