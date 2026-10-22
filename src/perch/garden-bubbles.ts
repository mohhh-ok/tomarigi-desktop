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
  inBlock?: boolean;
}

/** Where a bubble goes and how big it is: max is its max width, w and h its size at that width (tail not included),
    shift moves it sideways off its bird's center, above puts it over the icon */
export interface BubblePlace {
  max: number;
  w: number;
  h: number;
  shift: number;
  above: boolean;
}

/** The bubble's size when its max width is max (measured in the DOM by the garden) */
export type MeasureBubble = (id: string, max: number) => { w: number; h: number };

/**
 * Where the bubbles go (docs/design.md "Layout").
 * - Max width: 180px, narrowed so it stops BUBBLE_GAP_PX / 2 short of halfway to the nearest bird on each side whose
 *   bubble overlaps it vertically (its whole wrapped height, below or above its bird), and at an edge to the room to the
 *   edge plus that reach on the other side; never below a bird's width. Bubbles in a block keep their own max
 * - A bubble that would reach past the garden's bottom goes above its icon, or to the side with more room
 * - Width, height and side depend on each other, so they are worked out again until they settle (LAYOUT_ROUNDS)
 * - Then bubbles that still overlap vertically and come closer than BUBBLE_GAP_PX are moved sideways apart, staying
 *   inside the garden, each by at most its half-width less TAIL_INSET_PX so the tail stays under the icon. When that
 *   isn't enough they still overlap
 */
export function layoutBubbles(
  birds: LaidBird[],
  garden: { w: number; h: number },
  measure: MeasureBubble,
): Map<string, BubblePlace> {
  const lo = EDGE_PX;
  const hi = garden.w - EDGE_PX;
  const max = new Map(birds.map((b) => [b.id, b.inBlock ? BLOCK_BUBBLE_MAX_PX : BUBBLE_MAX_PX]));
  let size = new Map<string, { w: number; h: number }>();
  let above = new Map<string, boolean>();
  for (let round = 0; round < LAYOUT_ROUNDS; round++) {
    size = new Map(birds.map((b) => [b.id, measure(b.id, max.get(b.id)!)]));
    above = new Map(birds.map((b) => [b.id, goesAbove(b, size.get(b.id)!.h, garden.h)]));
    const span = (b: LaidBird) => verticalSpan(b, size.get(b.id)!.h, above.get(b.id)!);
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
    if (round === LAYOUT_ROUNDS - 1) {
      size = new Map(birds.map((b) => [b.id, measure(b.id, max.get(b.id)!)]));
      above = new Map(birds.map((b) => [b.id, goesAbove(b, size.get(b.id)!.h, garden.h)]));
    }
  }
  const shift = spreadApart(birds, size, above, lo, hi);
  return new Map(
    birds.map((b) => [
      b.id,
      { max: max.get(b.id)!, ...size.get(b.id)!, shift: shift.get(b.id)!, above: above.get(b.id)! },
    ]),
  );
}

/** Whether a bubble of height h goes above its icon: when it would reach past the garden's bottom, unless there is
    even less room above */
function goesAbove(b: LaidBird, h: number, gardenH: number): boolean {
  const roomBelow = gardenH - EDGE_PX - (b.y + b.iconBottom + TAIL_PX);
  const roomAbove = b.y + b.iconTop - TAIL_PX - EDGE_PX;
  return h > roomBelow && (h <= roomAbove || roomAbove > roomBelow);
}

/** Top and bottom of a bubble of height h, tail not included */
function verticalSpan(b: LaidBird, h: number, above: boolean): [number, number] {
  if (above) return [b.y + b.iconTop - TAIL_PX - h, b.y + b.iconTop - TAIL_PX];
  return [b.y + b.iconBottom + TAIL_PX, b.y + b.iconBottom + TAIL_PX + h];
}

/** Sideways shifts that keep BUBBLE_GAP_PX between bubbles that overlap vertically (see layoutBubbles). Each pair that
    comes too close is pushed apart by halves, a bubble held by its limit passing the rest to the other, until no pair
    moves */
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
  const pairs: [(typeof list)[number], (typeof list)[number]][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [p, q] = [list[i], list[j]];
      if (p.span[0] < q.span[1] && q.span[0] < p.span[1]) pairs.push([p, q]);
    }
  }
  for (let round = 0; round < SPREAD_ROUNDS; round++) {
    let moved = false;
    for (const [p, q] of pairs) {
      const need = p.w / 2 + BUBBLE_GAP_PX + q.w / 2 - (q.center - p.center);
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
  return new Map(list.map((p) => [p.b.id, p.center - p.b.x]));
}
