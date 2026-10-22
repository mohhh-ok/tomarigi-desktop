// Which birds outside a watch block keep the bubble room (docs/design.md "Layout"). A bubble shows its whole text and is
// drawn above every bird (styles/speech-bubble.css), so it may cover a neighbour, and a bubble that wraps onto more
// lines covers its own bird's status lines; the room stays one line's height. Only a bird in the same row as a bird
// with a bubble keeps the room, so the status lines of a row line up, as in a watch block's row. Where each bubble goes
// and how wide it may be is layoutBubbles. Pure computation in garden px (no DOM access: layoutBubbles is given a
// measure function)
import { BUBBLE_MAX_PX, NODE_WIDTH_PX } from "./garden-watch-layout";

/** A bird: x is its center, y its top edge (px) */
export interface BubbleBird {
  id: string;
  x: number;
  y: number;
  bubble: boolean;
  // In a watch block: its bubble keeps the block's max width and the block's rows keep their own bubble room, but it
  // still narrows the bubbles of birds outside beside it
  inBlock?: boolean;
}

// Birds whose top edges are this close stand in one row (px)
const ROW_TOLERANCE_PX = 12;
// Room kept between bubbles side by side (px): each stops half of it short of halfway on each side
const BUBBLE_GAP_PX = 8;
// Keep bubbles this far inside the garden frame (px; BUBBLE_EDGE_PX in garden.tsx)
const EDGE_PX = 4;
// Between the icon and the bubble: the tail's height (px; .speech-bubble-below in styles/speech-bubble.css)
const TAIL_PX = 7;
// The tail stays this far from either end of the bubble, off its rounded corners (px)
const TAIL_INSET_PX = 12;
// Max width of a bubble inside a watch block (.in-watch-block in styles/speech-bubble.css)
const BLOCK_BUBBLE_MAX_PX = NODE_WIDTH_PX;
// Width, place and height depend on each other, so they are worked out again until they settle, at most this often
const LAYOUT_ROUNDS = 5;
// Rounds of moving overlapping bubbles apart (each round settles every pair a little more)
const SPREAD_ROUNDS = 100;

/** Birds without a bubble that keep the bubble room, so their status lines line up with the row's */
export function bubbleRoomFor(birds: BubbleBird[]): Set<string> {
  const room = new Set<string>();
  const free = birds.filter((b) => !b.inBlock);
  for (const b of free) {
    if (b.bubble) continue;
    if (free.some((a) => a.bubble && Math.abs(a.y - b.y) <= ROW_TOLERANCE_PX)) room.add(b.id);
  }
  return room;
}

/** A bird with a bubble, in garden px: x is its center and y its top edge; iconTop and iconBottom are where its icon is,
    from its top edge */
export interface LaidBird {
  id: string;
  x: number;
  y: number;
  iconTop: number;
  iconBottom: number;
  // Where its name's top is, from its top edge: a bubble above goes above the name. iconTop without a name
  nameTop?: number;
  inBlock?: boolean;
}

/** Where a bubble goes and how big it is: max is its max width, w and h its size at that width (tail not included),
    shift moves it sideways off its bird's center, above puts it over the icon, bottom is its bottom edge (garden px) */
export interface BubblePlace {
  max: number;
  w: number;
  h: number;
  shift: number;
  above: boolean;
  bottom: number;
}

/** The bubble's size when its max width is max (measured in the DOM by the garden) */
export type MeasureBubble = (id: string, max: number) => { w: number; h: number };

/**
 * Where the bubbles go (docs/design.md "Layout").
 * - Max width: 180px, narrowed so it stops BUBBLE_GAP_PX / 2 short of halfway to the nearest bird on each side whose
 *   bubble overlaps it vertically (its whole wrapped height, below or above its bird), and at an edge to the room to the
 *   edge plus that reach on the other side; never below a bird's width. Bubbles in a block keep their own max
 * - Width, height and side depend on each other, so they are worked out again until they settle (LAYOUT_ROUNDS)
 * - Then bubbles that still overlap vertically and come closer than BUBBLE_GAP_PX are moved sideways apart, staying
 *   inside the garden, each by at most its half-width less TAIL_INSET_PX so the tail stays under the icon. A pair that
 *   can't be moved apart is moved apart only as far as that makes no new overlap with other bubbles
 * - A bubble that would reach past the garden's bottom goes above its bird's name when it fits there without
 *   overlapping another bubble. Otherwise it stays below while growing the window gives it room, and at that limit goes
 *   on the side where less of it is cut or covered. growH is how far down the garden can reach and growUp how far above
 *   its top, by growing the window (bubbleGrowRoom in lib/garden-fit.ts); a bubble above fits up to that far. The
 *   garden asks for the room with bubbleReach and bubbleReachUp
 * - Bubbles that still overlap: one of a pair goes above its icon when it fits there without overlapping another
 *   bubble, the one whose move clears more overlap first
 */
export function layoutBubbles(
  birds: LaidBird[],
  garden: { w: number; h: number; growH?: number; growUp?: number },
  measure: MeasureBubble,
): Map<string, BubblePlace> {
  // Trying sides lays them out again and again with the same widths: measure each width once
  const sizes = new Map<string, { w: number; h: number }>();
  const sized: MeasureBubble = (id, max) => {
    const key = `${id}\n${max}`;
    if (!sizes.has(key)) sizes.set(key, measure(id, max));
    return sizes.get(key)!;
  };
  const limit = Math.max(garden.h, garden.growH ?? garden.h) - EDGE_PX;
  let above = new Set<string>();
  let out = arrange(birds, garden, sized, above);
  const withAbove = (id: string) => arrange(birds, garden, sized, new Set([...above, id]));
  const top = EDGE_PX - Math.max(0, garden.growUp ?? 0);
  const fitsAbove = (b: LaidBird, o: Map<string, BubblePlace>) => verticalSpan(b, o.get(b.id)!.h, true)[0] >= top;
  // Past the garden's bottom
  for (const b of birds) {
    const { h, w } = out.get(b.id)!;
    const bottom = verticalSpan(b, h, false)[1];
    if (bottom <= garden.h - EDGE_PX) continue;
    const up = withAbove(b.id);
    const covered = coveredArea(birds, up, b);
    if (fitsAbove(b, up) && covered === 0) {
      above.add(b.id);
      out = up;
      continue;
    }
    if (bottom <= limit) continue;
    // At the limit: the side that loses less of it
    const cutBelow = (bottom - limit) * w;
    const upPlace = up.get(b.id)!;
    const cutAbove = Math.max(0, top - verticalSpan(b, upPlace.h, true)[0]) * upPlace.w;
    if (cutAbove + covered < cutBelow) {
      above.add(b.id);
      out = up;
    }
  }
  // Pairs that still overlap, the most first; each pair is tried once
  const tried = new Set<string>();
  for (let round = 0; round < birds.length; round++) {
    const pairs = overlappingPairs(birds, out).filter(([p, q]) => !tried.has(`${p.id}\n${q.id}`));
    if (pairs.length === 0) break;
    const [p, q] = pairs[0];
    tried.add(`${p.id}\n${q.id}`);
    const before = totalOverlap(birds, out);
    let best: { id: string; out: Map<string, BubblePlace>; cleared: number } | undefined;
    for (const b of [p, q]) {
      if (above.has(b.id)) continue;
      const up = withAbove(b.id);
      if (!fitsAbove(b, up) || coveredArea(birds, up, b) > 0) continue;
      const cleared = before - totalOverlap(birds, up);
      if (cleared > 0 && (!best || cleared > best.cleared)) best = { id: b.id, out: up, cleared };
    }
    if (best) {
      above = new Set([...above, best.id]);
      out = best.out;
    }
  }
  return out;
}

/** How far down the garden must reach for the bubbles shown below their birds (their bottom plus the edge room, garden
    px), capped at growH (how far growing the window can take it); undefined without a bubble below */
export function bubbleReach(places: Map<string, BubblePlace>, growH: number): number | undefined {
  const below = [...places.values()].filter((p) => !p.above);
  if (below.length === 0) return undefined;
  return Math.min(growH, Math.max(...below.map((p) => p.bottom)) + EDGE_PX);
}

/** How far above the garden's top it must reach for the bubbles shown above their birds (px past the top, the edge
    room included), capped at growUp (how far growing the window can take it); undefined when none reaches past it */
export function bubbleReachUp(places: Map<string, BubblePlace>, growUp: number): number | undefined {
  const tops = [...places.values()].filter((p) => p.above).map((p) => p.bottom - p.h);
  if (tops.length === 0) return undefined;
  const past = EDGE_PX - Math.min(...tops);
  return past > 0 ? Math.min(growUp, past) : undefined;
}

/** Widths, sizes and sideways shifts with each bubble's side given (above: the ones over their icon) */
function arrange(
  birds: LaidBird[],
  garden: { w: number; h: number },
  measure: MeasureBubble,
  above: ReadonlySet<string>,
): Map<string, BubblePlace> {
  const lo = EDGE_PX;
  const hi = garden.w - EDGE_PX;
  const max = new Map(birds.map((b) => [b.id, b.inBlock ? BLOCK_BUBBLE_MAX_PX : BUBBLE_MAX_PX]));
  let size = new Map<string, { w: number; h: number }>();
  const side = new Map(birds.map((b) => [b.id, above.has(b.id)]));
  for (let round = 0; round < LAYOUT_ROUNDS; round++) {
    size = new Map(birds.map((b) => [b.id, measure(b.id, max.get(b.id)!)]));
    const span = (b: LaidBird) => verticalSpan(b, size.get(b.id)!.h, side.get(b.id)!);
    let settled = true;
    for (const b of birds) {
      if (b.inBlock) continue;
      let left = Infinity;
      let right = Infinity;
      const [top, bottom] = span(b);
      for (const a of birds) {
        if (a === b) continue;
        const [aTop, aBottom] = span(a);
        if (aTop >= bottom || top >= aBottom) continue;
        if (a.x <= b.x) left = Math.min(left, b.x - a.x);
        else right = Math.min(right, a.x - b.x);
      }
      // How far it may reach toward each side
      const reachL = left / 2 - BUBBLE_GAP_PX / 2;
      const reachR = right / 2 - BUBBLE_GAP_PX / 2;
      const width = Math.min(2 * Math.min(reachL, reachR), hi - b.x + reachL, b.x - lo + reachR);
      const next = Math.min(BUBBLE_MAX_PX, Math.max(NODE_WIDTH_PX, width));
      if (next !== max.get(b.id)) settled = false;
      max.set(b.id, next);
    }
    if (settled) break;
    if (round === LAYOUT_ROUNDS - 1) size = new Map(birds.map((b) => [b.id, measure(b.id, max.get(b.id)!)]));
  }
  const shift = spreadApart(birds, size, side, lo, hi);
  return new Map(
    birds.map((b) => {
      const { w, h } = size.get(b.id)!;
      const bottom = verticalSpan(b, h, side.get(b.id)!)[1];
      return [b.id, { max: max.get(b.id)!, w, h, shift: shift.get(b.id)!, above: side.get(b.id)!, bottom }];
    }),
  );
}

/** Area two laid-out bubbles overlap (px²) */
function overlap(a: LaidBird, p: BubblePlace, b: LaidBird, q: BubblePlace): number {
  const across =
    Math.min(a.x + p.shift + p.w / 2, b.x + q.shift + q.w / 2) - Math.max(a.x + p.shift - p.w / 2, b.x + q.shift - q.w / 2);
  const down = Math.min(p.bottom, q.bottom) - Math.max(p.bottom - p.h, q.bottom - q.h);
  return across > 1e-6 && down > 1e-6 ? across * down : 0;
}

/** Area of b's bubble covered by the other bubbles */
function coveredArea(birds: LaidBird[], out: Map<string, BubblePlace>, b: LaidBird): number {
  return birds.reduce((sum, a) => (a === b ? sum : sum + overlap(a, out.get(a.id)!, b, out.get(b.id)!)), 0);
}

/** Pairs of bubbles that overlap, the largest overlap first */
function overlappingPairs(birds: LaidBird[], out: Map<string, BubblePlace>): [LaidBird, LaidBird][] {
  const pairs: [LaidBird, LaidBird, number][] = [];
  for (let i = 0; i < birds.length; i++) {
    for (let j = i + 1; j < birds.length; j++) {
      const area = overlap(birds[i], out.get(birds[i].id)!, birds[j], out.get(birds[j].id)!);
      if (area > 0) pairs.push([birds[i], birds[j], area]);
    }
  }
  return pairs.sort((x, y) => y[2] - x[2]).map(([a, b]) => [a, b]);
}

function totalOverlap(birds: LaidBird[], out: Map<string, BubblePlace>): number {
  return overlappingPairs(birds, out).reduce(
    (sum, [a, b]) => sum + overlap(a, out.get(a.id)!, b, out.get(b.id)!),
    0,
  );
}

/** Top and bottom of a bubble of height h, tail not included. Above, it ends above the name (docs/design.md "Layout") */
function verticalSpan(b: LaidBird, h: number, above: boolean): [number, number] {
  const top = b.nameTop ?? b.iconTop;
  if (above) return [b.y + top - TAIL_PX - h, b.y + top - TAIL_PX];
  return [b.y + b.iconBottom + TAIL_PX, b.y + b.iconBottom + TAIL_PX + h];
}

/** Sideways shifts that keep BUBBLE_GAP_PX between bubbles that overlap vertically (see layoutBubbles). A pair that can
    be moved apart within its limits is pushed apart by halves, a bubble held by its limit passing the rest to the other,
    until no pair moves. Then each pair that can't be moved apart (birds too close) is moved apart only as far as the
    other bubbles let it without coming closer than BUBBLE_GAP_PX to them, pushing them along as far as they can go, so
    the overlap that can't be helped doesn't make a new one */
function spreadApart(
  birds: LaidBird[],
  size: Map<string, { w: number; h: number }>,
  above: Map<string, boolean>,
  lo: number,
  hi: number,
): Map<string, number> {
  const list = birds
    .map((b) => {
      const { w, h } = size.get(b.id)!;
      // Centered under the bird, pushed only to stay inside the garden (as the CSS does without a shift)
      const want = Math.min(Math.max(b.x, lo + w / 2), hi - w / 2);
      return {
        b,
        w,
        span: verticalSpan(b, h, above.get(b.id)!),
        center: want,
        // How far its center may go: its tail limit and the garden, never ruling out where it already is
        min: Math.min(want, Math.max(b.x - (w / 2 - TAIL_INSET_PX), lo + w / 2)),
        max: Math.max(want, Math.min(b.x + (w / 2 - TAIL_INSET_PX), hi - w / 2)),
      };
    })
    .sort((p, q) => p.b.x - q.b.x);
  type Item = (typeof list)[number];
  const apart = (p: Item, q: Item) => p.w / 2 + BUBBLE_GAP_PX + q.w / 2;
  // Pairs that overlap vertically, left one first; those that can't keep the gap even at their limits are kept apart
  const pairs: [Item, Item][] = [];
  const stuck: [Item, Item][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [p, q] = [list[i], list[j]];
      if (!(p.span[0] < q.span[1] && q.span[0] < p.span[1])) continue;
      (q.max - p.min >= apart(p, q) - 1e-6 ? pairs : stuck).push([p, q]);
    }
  }
  for (let round = 0; round < SPREAD_ROUNDS; round++) {
    let moved = false;
    for (const [p, q] of pairs) {
      const need = apart(p, q) - (q.center - p.center);
      if (need <= 1e-6) continue;
      const left = Math.min(need / 2, p.center - p.min);
      const right = Math.min(need - left, q.max - q.center);
      const rest = Math.min(need - left - right, p.center - left - p.min);
      if (left + right + rest <= 1e-6) continue;
      p.center -= left + rest;
      q.center += right;
      moved = true;
    }
    if (!moved) break;
  }
  // How far a bubble can move left (right) with the bubbles on that side of it that it would push along, keeping the
  // gap to each; and moving it that way, pushing them along
  const leftOf = (p: Item) => pairs.filter(([, q]) => q === p).map(([r]) => r);
  const rightOf = (p: Item) => pairs.filter(([q]) => q === p).map(([, r]) => r);
  // (remembered while nothing moves, so a crowd doesn't walk the same bubbles over and over)
  let known = new Map<Item, number>();
  const roomLeft = (p: Item): number => {
    if (!known.has(p)) {
      const via = leftOf(p).map((r) => Math.max(0, p.center - r.center - apart(r, p)) + roomLeft(r));
      known.set(p, Math.min(p.center - p.min, ...via));
    }
    return known.get(p)!;
  };
  let knownR = new Map<Item, number>();
  const roomRight = (p: Item): number => {
    if (!knownR.has(p)) {
      const via = rightOf(p).map((r) => Math.max(0, r.center - p.center - apart(p, r)) + roomRight(r));
      knownR.set(p, Math.min(p.max - p.center, ...via));
    }
    return knownR.get(p)!;
  };
  const moveLeft = (p: Item, d: number) => {
    p.center -= d;
    for (const r of leftOf(p)) {
      const over = apart(r, p) - (p.center - r.center);
      if (over > 1e-9) moveLeft(r, Math.min(over, d));
    }
  };
  const moveRight = (p: Item, d: number) => {
    p.center += d;
    for (const r of rightOf(p)) {
      const over = apart(p, r) - (r.center - p.center);
      if (over > 1e-9) moveRight(r, Math.min(over, d));
    }
  };
  for (const [p, q] of stuck) {
    const need = apart(p, q) - (q.center - p.center);
    if (need <= 1e-6) continue;
    known = new Map();
    knownR = new Map();
    const roomL = Math.max(0, roomLeft(p));
    const roomR = Math.max(0, roomRight(q));
    const left = Math.min(need / 2, roomL);
    const right = Math.min(need - left, roomR);
    moveLeft(p, Math.min(roomL, need - right));
    moveRight(q, right);
  }
  return new Map(list.map((p) => [p.b.id, p.center - p.b.x]));
}

// Half the width of the tail's stem of a bubble above its bird, and the room it keeps from the name and the icon and
// from the bubble's ends (px)
const TAIL_HALF_PX = 3;
const TAIL_NAME_GAP_PX = 2;
const TAIL_END_PX = 10;

/**
 * The tail of a bubble above its bird (docs/design.md "Layout"): a stem from the bubble's bottom edge straight down
 * beside the name, on the side where the bubble has more room, to the name's bottom (knee), then a tip pointing at the
 * icon's side halfway down it, so it covers neither the name nor the icon. base and tip are px from the bubble's left
 * edge; knee and h are px down from the bubble's bottom edge to the knee and to the tip. place: the bubble's width and
 * shift (BubblePlace); name: its size (0 without one); icon: its size; iconFromName: from the name's top to the icon's
 */
export function aboveTail(
  place: { w: number; shift: number },
  name: { w: number; h: number },
  icon: { w: number; h: number },
  iconFromName: number,
): { base: number; knee: number; tip: number; h: number } {
  const center = place.w / 2 - place.shift;
  const side = place.w - center >= center ? 1 : -1;
  const clear = Math.max(name.w, icon.w) / 2 + TAIL_NAME_GAP_PX + TAIL_HALF_PX;
  const base = Math.min(place.w - TAIL_END_PX, Math.max(TAIL_END_PX, center + side * clear));
  return {
    base,
    knee: TAIL_PX + name.h,
    tip: center + side * (icon.w / 2 + 1),
    h: TAIL_PX + iconFromName + icon.h / 2,
  };
}
