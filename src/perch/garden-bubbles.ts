// Where the speech bubbles of birds outside a watch block may reach (docs/design.md "Layout"). A bird's footprint is a
// bird's width, and its bubble may be wider and reach into a neighbour's footprint, but it stops short of the
// neighbour's icon and marks, of the neighbour's bubble, and of watch blocks. A neighbour whose status lines would be
// under the bubble keeps the bubble room too, so its status lines go below the bubble, and so does one in the same row as
// a bird with a bubble, so the status lines of a row line up. Widths of the bubbles' text and
// of the status lines are measured after rendering (garden.tsx), so a short bubble neither narrows its neighbour's
// nor moves a status line it doesn't reach. Pure computation in garden px
// (no DOM access)
import { BUBBLE_MAX_PX, BUBBLE_ROOM_PX, NODE_WIDTH_PX } from "./garden-watch-layout";

/** A bird outside a block: x is its center, y its top edge (px) */
export interface BubbleBird {
  id: string;
  x: number;
  y: number;
  bubble: boolean;
  /** The bubble's width with its whole text, as measured (px). Until measured, the widest bubble */
  bubbleW?: number;
  /** The status lines' width, as measured (px). Until measured, a bird's width */
  statusW?: number;
}

export interface BubbleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BubbleSpace {
  /** Horizontal range (px) each bubble must stay in, for birds with a bubble */
  ranges: Map<string, { lo: number; hi: number }>;
  /** Birds without a bubble that keep the bubble room, so their status lines go below a neighbour's bubble */
  roomFor: Set<string>;
}

// Room kept between a bubble and what it must not reach (px)
const CLEAR_PX = 4;
// Room kept between two bubbles side by side, so they don't read as one strip (px)
const BUBBLE_GAP_PX = 8;
// The least a bubble reaches from the bird's center on either side, so its tail stays on the bubble (px)
const TAIL_ROOM_PX = 14;
// Height of the status lines (both lines, with the top margin) under a bird without bubble room (px)
const STATUS_PX = 34;
// Birds whose top edges are this close stand in one row (px)
const ROW_TOLERANCE_PX = 12;

const overlapsY = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * nameRow: height of the name row above the icon (px), glyph: the icon size (px), frame: the range every bubble stays
 * in (inside the garden frame), blocks: footprints of watch blocks
 */
export function bubbleSpace(
  birds: BubbleBird[],
  blocks: BubbleRect[],
  glyph: number,
  nameRow: number,
  frame: { lo: number; hi: number },
): BubbleSpace {
  // The bubble sits right below the icon, in the bubble room
  const band = (b: BubbleBird) => {
    const top = b.y + nameRow + glyph;
    return [top, top + BUBBLE_ROOM_PX] as const;
  };
  // The "?" sticks out at the top right and the anger mark at the top left, about half the icon's size
  // (styles/bird-badge.css), so the icon and its marks take about twice the icon's width
  const iconHalf = glyph;

  // Status lines of a bird (with or without the bubble room above them), horizontally centered under it
  const statusOf = (b: BubbleBird, room: boolean) => {
    const top = b.y + nameRow + glyph + (room ? BUBBLE_ROOM_PX : 0);
    const half = Math.min(b.statusW ?? NODE_WIDTH_PX, NODE_WIDTH_PX) / 2;
    return { top, bottom: top + STATUS_PX, l: b.x - half, r: b.x + half };
  };

  /** Ranges of the bubbles. With roomFor, also short of every neighbour's status lines where they end up */
  const rangesOf = (roomFor?: Set<string>) => {
    const ranges = new Map<string, { lo: number; hi: number }>();
    for (const a of birds) {
      if (!a.bubble) continue;
      const [top, bottom] = band(a);
      let lo = frame.lo;
      let hi = frame.hi;
      const limit = (edge: number, left: boolean) => {
        if (left) lo = Math.max(lo, edge);
        else hi = Math.min(hi, edge);
      };
      for (const b of birds) {
        if (b === a) continue;
        const left = b.x < a.x;
        const iconTop = b.y + nameRow;
        if (overlapsY(top, bottom, iconTop, iconTop + glyph)) {
          limit(left ? b.x + iconHalf + CLEAR_PX : b.x - iconHalf - CLEAR_PX, left);
        }
        if (roomFor) {
          const st = statusOf(b, b.bubble || roomFor.has(b.id));
          if (overlapsY(top, bottom, st.top, st.bottom)) {
            limit(left ? st.r + BUBBLE_GAP_PX : st.l - BUBBLE_GAP_PX, left);
          }
        }
        if (b.bubble && overlapsY(top, bottom, ...band(b))) {
          // Two bubbles side by side share the room between the birds: each gets what its text needs when both fit,
          // otherwise the shorter one keeps its need and the longer one takes the rest (half each when both are long)
          const room = Math.abs(a.x - b.x) - BUBBLE_GAP_PX;
          const needA = widthOf(a) / 2;
          const needB = widthOf(b) / 2;
          const share =
            needA + needB <= room
              ? needA + (room - needA - needB) / 2
              : needA < room / 2
                ? needA
                : needB < room / 2
                  ? room - needB
                  : room / 2;
          limit(left ? a.x - share : a.x + share, left);
        }
      }
      for (const r of blocks) {
        if (!overlapsY(top, bottom, r.y, r.y + r.h)) continue;
        const left = r.x + r.w / 2 < a.x;
        limit(left ? r.x + r.w + CLEAR_PX / 2 : r.x - CLEAR_PX / 2, left);
      }
      ranges.set(a.id, { lo: Math.min(lo, a.x - TAIL_ROOM_PX), hi: Math.max(hi, a.x + TAIL_ROOM_PX) });
    }
    return ranges;
  };

  // Which birds keep the bubble room is decided from where the bubbles could reach past the icons and other bubbles
  const reachable = rangesOf();
  const roomFor = new Set<string>();
  for (const b of birds) {
    if (b.bubble) continue;
    const st = statusOf(b, false);
    const under = birds.some((a) => {
      const range = reachable.get(a.id);
      if (!range) return false;
      const [l, r] = reach(a.x, range, widthOf(a));
      return l < st.r + CLEAR_PX && st.l - CLEAR_PX < r && overlapsY(...band(a), st.top, st.bottom);
    });
    // As in a watch block's row, a bird beside one with a bubble keeps the room too, so the status lines line up
    const inRow = birds.some((a) => a.bubble && Math.abs(a.y - b.y) <= ROW_TOLERANCE_PX);
    if (!under && !inRow) continue;
    // Not when the status lines would go down into another bubble's height (birds not in one row)
    const moved = statusOf(b, true);
    const intoBubble = birds.some((a) => {
      const range = reachable.get(a.id);
      if (!range || Math.abs(a.y - b.y) <= ROW_TOLERANCE_PX) return false;
      const [l, r] = reach(a.x, range, widthOf(a));
      return l < moved.r && moved.l < r && overlapsY(...band(a), moved.top, moved.bottom);
    });
    if (!intoBubble || inRow) roomFor.add(b.id);
  }
  // Then every bubble also stops short of the status lines where they end up, so it never hides one
  const ranges = rangesOf(roomFor);
  return { ranges, roomFor };
}

const widthOf = (b: BubbleBird) => Math.min(b.bubbleW ?? BUBBLE_MAX_PX, BUBBLE_MAX_PX);

/** How far a bubble of width maxW of a bird at x reaches within range (centered under the bird, pushed inside the range) */
export function reach(x: number, range: { lo: number; hi: number }, maxW = BUBBLE_MAX_PX): [number, number] {
  const w = Math.min(maxW, BUBBLE_MAX_PX, range.hi - range.lo);
  const left = Math.min(Math.max(x - w / 2, range.lo), range.hi - w);
  return [left, left + w];
}
