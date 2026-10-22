// Which birds outside a watch block keep the bubble room (docs/design.md "Layout"). A bubble shows its whole text and is
// drawn above every bird (styles/speech-bubble.css), so it may cover a neighbour, and a bubble that wraps onto more
// lines covers its own bird's status lines; the room stays one line's height. Only a bird in the same row as a bird
// with a bubble keeps the room, so the status lines of a row line up, as in a watch block's row. Each bubble's max
// width stops short of halfway to the bubbles beside it in its row, a block's included (bubbleMaxWidths). Pure
// computation in garden px (no DOM access)
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
// Room kept between bubbles side by side (px): each stops this much short of halfway on each side
const BUBBLE_GAP_PX = 8;

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

/** Max width of each bubble (px), for birds with a bubble outside a block: it reaches at most halfway to the nearest bird
    with a bubble on each side in its row less half of BUBBLE_GAP_PX, so bubbles side by side keep that gap; kept between
    a bird's width and BUBBLE_MAX_PX. range is where the bubbles stay (inside the garden frame): a bubble pushed in from
    one edge would reach further toward the other side, so the room to that edge plus that reach on the other side caps
    it too */
export function bubbleMaxWidths(birds: BubbleBird[], range?: { lo: number; hi: number }): Map<string, number> {
  const max = new Map<string, number>();
  const talking = birds.filter((b) => b.bubble);
  for (const b of talking) {
    if (b.inBlock) continue;
    let left = Infinity;
    let right = Infinity;
    for (const a of talking) {
      if (a === b || Math.abs(a.y - b.y) > ROW_TOLERANCE_PX) continue;
      if (a.x <= b.x) left = Math.min(left, b.x - a.x);
      else right = Math.min(right, a.x - b.x);
    }
    // How far it may reach toward each side
    const reachL = left / 2 - BUBBLE_GAP_PX / 2;
    const reachR = right / 2 - BUBBLE_GAP_PX / 2;
    let width = 2 * Math.min(reachL, reachR);
    if (range) width = Math.min(width, range.hi - b.x + reachL, b.x - range.lo + reachR);
    max.set(b.id, Math.min(BUBBLE_MAX_PX, Math.max(NODE_WIDTH_PX, width)));
  }
  return max;
}
