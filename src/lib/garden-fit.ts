// Whether the Garden's birds fit, and how far the floating window must grow for them to fit (docs/design.md "Layout").
// The Garden reports whether its actual placement (placeBoxes in lib/garden-place.ts, with the birds on screen kept
// where they are) left a bird without a free spot. The window grows only then, and only by as much as needed.

import { PLACE_GAP_PX, placeBoxes, type PlaceBox, type Point } from "./garden-place";

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
  /** Counts the user's drops of a bird or block: a new count asks for shrinking once (gardenDropScale) */
  drops?: number;
}

/** What the Garden placed at its current size, for trying the same placement at another size (gardenSimulate) */
export interface PlacedGarden {
  /** Boxes in placement order: what has a spot as `at`, what had no spot (overlapping) as `want` from where it is */
  settled: readonly PlaceBox[];
  /** Footprint height of a box at another icon size (boxes without one keep their height) */
  heightAt: ReadonlyMap<string, (glyph: number) => number>;
  /** Icon size now */
  glyph: number;
  /** Number of birds (for the icon size) */
  count: number;
  /** Garden size now (px) */
  w: number;
  h: number;
  /**
   * Part of the window that stays put on screen when it resizes (gardenGrowAnchor in perch/garden-grow.ts). Read on
   * each try, so the object may be updated after the placement
   */
  anchor: Readonly<Point>;
  /** Boxes that had no spot now: expected to move to the new room, so they don't count as moved */
  overflowIds: ReadonlySet<string>;
  /**
   * Boxes not on screen yet: first placed in this render, which had no spot for something (docs/design.md "Layout":
   * "On screen"). After the window grows they are placed again like boxes that just appeared, so their `want` / `seed`
   * is used as is, not shifted to stay at the same place on screen
   */
  fresh?: ReadonlySet<string>;
}

/**
 * The Garden's actual placement tried at another garden size (gw×gh), as if the window were resized to it: what is on
 * screen shifted to stay at the same place on screen, a box that then sticks out or overlaps moved to the nearest free
 * spot inside, what had no spot placed again (placeBoxes, the same as on the next render). Returns how many have no
 * spot, how many on screen would move, and where everything goes
 */
export function gardenSimulate(placed: PlacedGarden, gw: number, gh: number) {
  const glyph = Math.min(placed.glyph, gardenGlyphSize(gw, gh, placed.count));
  const dx = (gw - placed.w) * placed.anchor.x;
  const dy = (gh - placed.h) * placed.anchor.y;
  const move = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  const tried = placed.settled.map((b): PlaceBox => {
    const h = placed.heightAt.get(b.id)?.(glyph) ?? b.h;
    if (b.at) return { id: b.id, w: b.w, h, at: move(b.at), byUser: b.byUser };
    if (placed.fresh?.has(b.id)) return { id: b.id, w: b.w, h, want: b.want, seed: b.seed };
    return { id: b.id, w: b.w, h, want: b.want && move(b.want) };
  });
  const result = placeBoxes(tried, gw, gh);
  let moved = 0;
  for (const b of tried) {
    const to = result.at.get(b.id)!;
    if (placed.overflowIds.has(b.id)) continue;
    if (b.at && (Math.abs(to.x - b.at.x) > 0.5 || Math.abs(to.y - b.at.y) > 0.5)) moved++;
  }
  return { overflow: result.overflow.length, moved, at: result.at, tried };
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

// Room left for the window's size being rounded to whole pixels (see gardenFitScale)
export const ROUNDING_PX = 1;

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
 *   the birds sparse). shrinkScale, for shrinking back after birds left (nextGrowScale decides whether to shrink).
 *   Unlike a manual shrink, no bird moves for it
 * Without fit.simulate, an estimate when something overflowed: enough for the footprints to fit in an empty garden,
 * and at least a strip as wide or tall as the footprint that had no spot. When nothing overflowed it stays at current,
 * since without the actual placement a smaller size can't be checked to keep everyone in place
 */
export function gardenFitScale(userW: number, userH: number, fit: GardenFit, current = 1): number {
  if (userW <= 0 || userH <= 0) return 1;
  const base = Math.max(1, current);
  const steps = Math.round((MAX_FIT_SCALE - 1) / SCALE_STEP);
  const scaleAt = (i: number) => Math.round((1 + i * SCALE_STEP) * 100) / 100;
  const simulate = fit.simulate;
  if (simulate) {
    // Tried 1px smaller than the exact size: the window takes whole pixels (rounded on the Rust side) and the overhead
    // is measured rounded, so the garden can come out a fraction smaller. Shrinking to a size that fit only by that
    // fraction left a block without a spot and grew the window right back (observed: 574.02 tried, 574 shown)
    const at = (s: number) =>
      simulate(userW * s - fit.overheadW - ROUNDING_PX, userH * s - fit.overheadH - ROUNDING_PX);
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
      let placed = first(baseStep + 1, steps, (s) => at(s).overflow === 0);
      if (placed === undefined) return MAX_FIT_SCALE;
      // More room isn't always better for new birds (their grid cells change with the size), so the binary search can
      // land above a size that fits. A few steps below are tried too, so it grows only by as much as needed (observed:
      // a block and 8 birds fit at 1.5 and 1.58 but not 1.56; the search gave 1.58)
      for (let i = placed - 1; i >= Math.max(baseStep + 1, placed - 10); i--) {
        if (at(scaleAt(i)).overflow === 0) placed = i;
      }
      // A little more room may also spare the birds on screen from moving
      for (let i = placed; i <= Math.min(steps, placed + 10); i++) {
        const r = at(scaleAt(i));
        if (r.overflow === 0 && r.moved === 0) return scaleAt(i);
      }
      return scaleAt(placed);
    }
    return shrinkScale(userW, userH, fit, base);
  }
  // Shrinking needs the actual placement to check that nobody moves (shrinkScale)
  if (!fit.overflow) return base;
  const empty = emptyFitScale(userW, userH, fit);
  const strip = base + Math.min((fit.overflowW + PLACE_GAP_PX) / userW, (fit.overflowH + PLACE_GAP_PX) / userH);
  return Math.round(roundUp(Math.max(empty, strip)) * 100) / 100;
}

/**
 * The one place that decides how far the window may shrink by itself (docs/design.md "Layout": birds leaving, a drop,
 * any render while grown): the smallest scale of the user's window size, from 1 (the user's size) up to upTo, at which
 * the actual placement (fit.simulate) gives everything a spot without moving anyone on screen. undefined when none up to
 * upTo does, or without fit.simulate to check it with. A manual resize is the user's size and doesn't come here
 */
export function keepPlaceScale(userW: number, userH: number, fit: GardenFit, upTo: number): number | undefined {
  const simulate = fit.simulate;
  if (!simulate || userW <= 0 || userH <= 0) return undefined;
  const scaleAt = (i: number) => Math.round((1 + i * SCALE_STEP) * 100) / 100;
  // Tried 1px smaller than the exact size: the window takes whole pixels (rounded on the Rust side) and the overhead
  // is measured rounded, so the garden can come out a fraction smaller. Shrinking to a size that fit only by that
  // fraction left a block without a spot and grew the window right back (observed: 574.02 tried, 574 shown)
  const ok = (i: number) => {
    const s = scaleAt(i);
    const r = simulate(userW * s - fit.overheadW - ROUNDING_PX, userH * s - fit.overheadH - ROUNDING_PX);
    return r.overflow === 0 && r.moved === 0;
  };
  let lo = 0;
  let hi = Math.floor((Math.min(upTo, MAX_FIT_SCALE) - 1) / SCALE_STEP + 1e-9);
  if (hi < 0 || !ok(hi)) return undefined;
  // Binary search, assuming more room never makes anyone move
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return scaleAt(lo);
}

/**
 * Shrinking back from current (birds left, or any render while grown): keepPlaceScale, or current when no smaller size
 * keeps everyone in place. Allowing birds that stick out to move to a free spot inside moved birds the user hadn't
 * touched (the user: 「キャラが消える時に、関係ないキャラも動いてしまってくずれることがある」「てかウィンドウを自動で縮めるときに
 * 鳥がうごくのがもんだいなのはわかってるか？」)
 */
export function shrinkScale(userW: number, userH: number, fit: GardenFit, current: number): number {
  return keepPlaceScale(userW, userH, fit, current) ?? current;
}

/**
 * On a drop (docs/design.md "Layout"): keepPlaceScale over every size, so the window shrinks once and nothing moves.
 * undefined when no size keeps everyone in place (then it doesn't shrink)
 */
export function gardenDropScale(userW: number, userH: number, fit: GardenFit): number | undefined {
  return keepPlaceScale(userW, userH, fit, MAX_FIT_SCALE);
}

/**
 * The fit with the lowest bubble shown below its bird counted too (docs/design.md "Layout"): reach is how far down the
 * garden must go for it (garden px at gardenH, the garden's height the placement was made at, edge room included),
 * undefined without one. A bubble cut by the garden's bottom asks the window to grow like a bird without a spot, and
 * simulate counts it as one at sizes where it would still be cut, so shrinking back (keepPlaceScale) never cuts it and
 * the window doesn't shrink and grow right back. anchor: the part of the window that stays put (gardenGrowAnchor); the
 * garden's bottom moves down by (1 - anchor.y) of what it grows. Pass a reach that growing can give (bubbleGrowH):
 * one it can't would grow the window to the end
 */
export function withBubbleReach<F extends Pick<GardenFit, "overflow" | "simulate">>(
  fit: F,
  reach: number | undefined,
  gardenH: number,
  anchor: Readonly<Point>,
): F {
  if (reach === undefined) return fit;
  const cutAt = (gh: number) => reach > gh - (gh - gardenH) * anchor.y + 0.5;
  const simulate = fit.simulate;
  return {
    ...fit,
    overflow: fit.overflow || cutAt(gardenH),
    simulate:
      simulate &&
      ((w: number, h: number) => {
        const r = simulate(w, h);
        return { ...r, overflow: r.overflow + (cutAt(h) ? 1 : 0) };
      }),
  };
}

/**
 * How far down the garden can reach by growing the window, in garden px now (docs/design.md "Layout": a bubble past the
 * garden's bottom stays below while growing gives it room): the garden at the largest scale the display's visible area
 * (area, CSS px) allows, of which the garden's bottom gets (1 - anchorY) (the rest goes above). The garden's height now
 * when the window grows upward from the display's bottom
 */
export function bubbleGrowH(
  user: { width: number; height: number },
  fit: Pick<GardenFit, "gardenH" | "overheadH">,
  anchorY: number,
  area: { width: number; height: number },
): number {
  const most = Math.min(MAX_FIT_SCALE, area.width / user.width, area.height / user.height);
  const grown = Math.max(fit.gardenH, user.height * most - fit.overheadH);
  return fit.gardenH + (grown - fit.gardenH) * (1 - anchorY);
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

/** What useGardenGrow (src/perch/garden-grow.ts) knows when it decides the scale */
export interface GrowInputs {
  /** Floating window, Garden tab, nothing else shown in its place */
  active: boolean;
  /** The floating window (not the standard one) */
  floating: boolean;
  /** Not growing after a manual resize until a bird joins */
  held: boolean;
  fit: GardenFit | null;
  /** The user's size */
  user: { width: number; height: number } | null;
  birdCount: number;
  /** The scale last applied (GrowKept), null when not grown */
  kept: GrowKept | null;
  /** The user just dropped a bird or block: the scale to shrink to (gardenDropScale) */
  dropScale: number | undefined;
}

/** How far the window is grown now, from the measured garden (the user's size: 1) */
function measuredScale(user: { width: number; height: number }, fit: GardenFit): number {
  return Math.max(1, (fit.gardenW + fit.overheadW) / user.width, (fit.gardenH + fit.overheadH) / user.height);
}

/**
 * The scale to ask for (1 or less: the user's size), what it was decided from, and the GrowKept to remember. quiet:
 * nothing to ask for, only remember kept (the window stays as it is)
 */
export function growStep(i: GrowInputs): {
  scale: number;
  needed: number;
  drop: boolean;
  kept: GrowKept | null;
  quiet: boolean;
} {
  const { active, floating, held, fit, user, birdCount, kept } = i;
  if (i.dropScale !== undefined && fit && user) {
    const scale = i.dropScale;
    const next = { scale, count: birdCount, userW: user.width, userH: user.height };
    return { scale, needed: scale, drop: true, kept: next, quiet: false };
  }
  if (!active || !fit || !user) {
    // Another tab of the floating window: the window keeps its size, so coming back to the Garden moves no bird (the
    // hidden Garden can't check a smaller size)
    if (!active && floating) return { scale: kept?.scale ?? 1, needed: 1, drop: false, kept, quiet: true };
    // Nothing remembered and no birds measured yet (right after a page reload, before the birds are loaded): the window
    // may be grown, and going back to the user's size placed the birds again at that size (observed at a reload)
    if (active && !kept) return { scale: 1, needed: 1, drop: false, kept: null, quiet: true };
    return { scale: 1, needed: 1, drop: false, kept: null, quiet: false };
  }
  // Nothing remembered (the page was reloaded while the window was grown): the growth is worked out from the measured
  // garden instead of taking it as the user's size, which shrank the window and moved the birds sticking out. After a
  // manual resize (another user's size) it starts over from the user's size
  const measured = kept ? 1 : measuredScale(user, fit);
  const sameUser = kept && kept.userW === user.width && kept.userH === user.height;
  const base = sameUser ? kept : measured > 1.01 ? { scale: measured, count: birdCount, userW: user.width, userH: user.height } : null;
  const current = base?.scale ?? 1;
  let needed: number;
  if (held) {
    // Held: no growing, but shrinking is the same as when not held: only when birds leave, and only as far as nobody
    // moves (shrinkScale). Going back to the user's size on any render shrank a window a drop had kept grown a few
    // seconds later, when a bubble changed, and moved the birds that stuck out (observed)
    needed = shrinkScale(user.width, user.height, fit, current);
  } else {
    // An overflow measured before the window reached the current scale (the resize is still on its way, or the
    // Rust side capped it at the display) doesn't ask for more: it would grow twice for one bird
    const stale =
      fit.gardenW < user.width * current - fit.overheadW - 2 || fit.gardenH < user.height * current - fit.overheadH - 2;
    needed = gardenFitScale(user.width, user.height, stale ? { ...fit, overflow: false } : fit, current);
  }
  const scale = nextGrowScale(base, needed, birdCount, user.width, user.height);
  const next = { scale, count: birdCount, userW: user.width, userH: user.height };
  return { scale, needed, drop: false, kept: next, quiet: !kept && base !== null && scale === base.scale };
}

// Ids not yet settled after a placement that left something without a free spot (docs/design.md "Layout"): what was
// unsettled and is still shown (none when the garden changed size, as all of it was placed again), and what was first
// placed in this render. A bird or block the user dropped in this render has its place, so it is neither
export function nextUnsettled(
  previous: Iterable<string>,
  liveIds: readonly string[],
  firstIds: Iterable<string>,
  droppedIds: ReadonlySet<string>,
  replaceAll: boolean,
): Set<string> {
  const still = replaceAll ? [] : [...previous].filter((id) => liveIds.includes(id));
  return new Set([...still, ...firstIds].filter((id) => !droppedIds.has(id)));
}
