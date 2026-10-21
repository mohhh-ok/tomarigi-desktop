// Shapes of watching groups in the garden (docs/design.md "Watching"). Pure computation from sessions and sizes (no DOM
// access). Where a block goes is decided with the birds by placeBoxes in lib/garden-place.ts (garden.tsx)
import { PLACE_GAP_PX } from "@/lib/garden-place";
import type { SessionView } from "@/lib/sessions";
import { bubbleText } from "./bubble";
import { relativeLabel } from "./watch-links";

// Width of a garden node (.garden-node in styles/garden.css)
export const NODE_WIDTH_PX = 120;

// Speech bubble height + gap to the bird. For a bird with a speech bubble, this much space is left between
// the icon and the name to place the bubble (same value as the height of .garden-bubble-room in styles/speech-bubble.css)
export const BUBBLE_ROOM_PX = 26;
// Estimated height of the non-glyph part of a garden node (name and status rows)
export const NODE_TEXT_PX = 32;
// Estimated max width of a speech bubble (max-width 15em × 11px of .speech-bubble-below in styles/speech-bubble.css
// + left/right padding)
export const BUBBLE_MAX_PX = 180;

// Watching groups (docs/design.md "Watching"): each linked bird is put in a cell next to the bird it is linked to, in a
// small grid (the block, which is not drawn), and the two are joined by a short line (watchLinePath).
// Cell width and padding inside the block. A cell is as wide as a bird's node plus the gap between footprints, narrower
// than a bird's footprint outside a block (the widest bubble; garden.tsx): a bubble inside a block may overlap the next
// cell's status line, and widening every cell would make blocks too wide for the display (docs/design.md "Layout").
// When a block goes away, a bird of it that now overlaps a neighbour moves to the nearest free spot
const WATCH_CELL_W = NODE_WIDTH_PX + PLACE_GAP_PX;
const WATCH_PAD = 8;
// Height of the row under a watching bird showing how many peers are active (.garden-watch-count in styles/garden-watch.css;
// text height + top gap)
export const WATCH_COUNT_PX = 18;
// Height of the second line of the status row (tool name; inside a block, elapsed time and tool name)
// (.garden-status-sub in styles/garden.css)
export const STATUS_SUB_PX = 15;
// Status row's top margin and the event marker row under it
const NODE_MARKS_PX = 14;

/**
 * Footprint height of a bird outside a block, excluding the icon: the most it can take, with bubble room, both status
 * lines, the event marker, and (for a watching bird) the count row. Reserving all of it keeps the bird from growing
 * into a neighbour when a bubble or a tool line appears (docs/design.md "Layout")
 */
export function birdExtraH(session: Pick<SessionView, "watching">): number {
  return (
    NODE_TEXT_PX +
    NODE_MARKS_PX +
    STATUS_SUB_PX +
    BUBBLE_ROOM_PX +
    (session.watching !== undefined ? WATCH_COUNT_PX : 0)
  );
}

/** A bird's spot within its block, relative to the block's top-left: x is the bird's center, y its top edge */
export interface WatchCell {
  dx: number;
  dy: number;
  // Height of the bird's row (for the center of the bird, to decide the bubble's direction)
  rowH: number;
  // If any bird in the row shows a speech bubble, birds without one also reserve bubble space, so the status rows
  // line up within the row. This keeps a neighbor's speech bubble (wider than one cell) off this bird's status row
  bubbleRoom: boolean;
  // Name of a bird inside a block (docs/design.md "Watching"). undefined for the parent and for birds in the same
  // folder as the parent. nameRoom tells whether any bird in the row has a name. If so, birds without a name also
  // reserve the name row height, so icon heights line up within the row
  label?: string;
  nameRoom: boolean;
}

/** A cell of a block's grid, relative to the parent's cell (column to the right, row down) */
export interface GridCell {
  col: number;
  row: number;
}

export interface WatchShape {
  // The group's first-started bird (the parent). Also the block's key
  rootId: string;
  // In the order they were put in the grid (the parent first)
  memberIds: string[];
  width: number;
  // Footprint height for placement. Every row is the same fixed height (name row, bubble room, both status lines,
  // count row), so a bubble, a name, or a count appearing never moves a bird in the block or grows the block into a
  // neighbour (docs/design.md "Layout")
  footH: number;
  // Rows of icons in the block (footH grows by this many icon heights)
  rows: number;
  cells: Map<string, WatchCell>;
  // Each bird's grid cell, relative to the parent's. Passed back on the next render (watchShapes' kept), so the birds
  // keep their cells
  grid: Map<string, GridCell>;
  // Pairs of linked birds that are next to each other, each pair once. A line is drawn for each; linked birds that
  // aren't next to each other (no free cell was left) get none, so no line runs past another bird
  links: [string, string][];
}

// Cells next to a bird where a linked bird goes, in the order they are tried: the same row first, then the row below,
// then the row above. Not straight above or below: a line there would run through the upper bird's bubble and status
// lines. A line to a cell beside or diagonal to it passes no other bird, name, or bubble (docs/design.md "Watching")
const NEXT_CELLS: GridCell[] = [
  { col: 1, row: 0 },
  { col: -1, row: 0 },
  { col: 1, row: 1 },
  { col: -1, row: 1 },
  { col: 1, row: -1 },
  { col: -1, row: -1 },
];

/** Whether two cells are next to each other in the way NEXT_CELLS allows (beside or diagonal) */
function nextTo(a: GridCell, b: GridCell): boolean {
  return Math.abs(a.col - b.col) === 1 && Math.abs(a.row - b.row) <= 1;
}

const cellKey = (c: GridCell) => `${c.col},${c.row}`;

/**
 * Groups birds connected by watching (among those in the garden) and puts each group in a small grid: the parent (the
 * first-started bird), then, in start order, each bird linked to one already placed goes to a free cell next to it
 * (NEXT_CELLS), so a bird another one watches sits next to it, but not where its line would cross another line in an X. kept gives the grid cells a group had last time (by the
 * parent, or for a group that took one over, by a shared bird); a bird keeps its cell while it is free and next to a
 * bird it is linked to, so birds on screen don't move when another joins. A bird with no free cell next to any bird it
 * is linked to goes to the nearest free cell and gets no line
 */
export function watchShapes(
  sessions: SessionView[],
  glyphSize: number,
  kept: (rootId: string, memberIds: string[]) => Map<string, GridCell> | undefined = () => undefined,
): WatchShape[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rank = new Map(sessions.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  // Links are known from one side only at times (the other bird's transcript may not show the message yet)
  const linkedTo = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!linkedTo.has(a)) linkedTo.set(a, new Set());
    linkedTo.get(a)!.add(b);
  };
  for (const s of sessions) {
    for (const peer of s.peers ?? []) {
      if (!peer.viewId || peer.viewId === s.id || !byId.has(peer.viewId)) continue;
      link(s.id, peer.viewId);
      link(peer.viewId, s.id);
    }
  }
  const seen = new Set<string>();
  const shapes: WatchShape[] = [];
  for (const start of sessions) {
    if (seen.has(start.id)) continue;
    const component: SessionView[] = [];
    const queue = [start];
    seen.add(start.id);
    while (queue.length > 0) {
      const current = queue.shift() as SessionView;
      component.push(current);
      for (const id of linkedTo.get(current.id) ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          queue.push(byId.get(id)!);
        }
      }
    }
    if (component.length < 2) continue;
    const byStart = component.sort(earlier);
    const parent = byStart[0];
    const before = kept(
      parent.id,
      byStart.map((m) => m.id),
    );
    // The parent is the origin. A kept grid from a group whose parent was another bird is shifted to it
    const keptOrigin = before?.get(parent.id);
    const keptCell = (id: string): GridCell | undefined => {
      const c = before?.get(id);
      return c && keptOrigin ? { col: c.col - keptOrigin.col, row: c.row - keptOrigin.row } : undefined;
    };
    const grid = new Map<string, GridCell>([[parent.id, { col: 0, row: 0 }]]);
    const taken = new Set([cellKey({ col: 0, row: 0 })]);
    const free = (c: GridCell) => !taken.has(cellKey(c));
    const put = (id: string, c: GridCell) => {
      grid.set(id, c);
      taken.add(cellKey(c));
    };
    const placed = () => byStart.filter((m) => grid.has(m.id));
    const at = (c: GridCell) => [...grid].find(([, g]) => g.col === c.col && g.row === c.row)?.[0];
    // Whether a line from a to the diagonal cell b would cross the line between the other two cells of their 2x2 square
    // (two linked birds already there), which reads as an X
    const crossesLine = (a: GridCell, b: GridCell) => {
      if (a.row === b.row) return false;
      const p = at({ col: a.col, row: b.row });
      const q = at({ col: b.col, row: a.row });
      return p !== undefined && q !== undefined && Boolean(linkedTo.get(p)?.has(q));
    };
    while (grid.size < byStart.length) {
      // The earliest-started bird linked to one already placed (a group stays connected, so there is one)
      const next = byStart.find((m) => !grid.has(m.id) && [...(linkedTo.get(m.id) ?? [])].some((id) => grid.has(id)))!;
      const anchors = placed().filter((m) => linkedTo.get(next.id)?.has(m.id));
      const keep = keptCell(next.id);
      if (keep && free(keep) && anchors.some((m) => nextTo(grid.get(m.id)!, keep))) {
        put(next.id, keep);
        continue;
      }
      const spot = anchors
        .flatMap((m) =>
          NEXT_CELLS.map((d) => ({ from: grid.get(m.id)!, at: { col: grid.get(m.id)!.col + d.col, row: grid.get(m.id)!.row + d.row } })),
        )
        .find(({ from, at }) => free(at) && !crossesLine(from, at))?.at;
      if (spot) {
        put(next.id, spot);
        continue;
      }
      // No free cell next to a bird it is linked to: the free cell nearest the first of them (no line)
      const from = grid.get(anchors[0].id)!;
      let nearest: GridCell | undefined;
      for (let r = 1; !nearest; r++) {
        const ring: GridCell[] = [];
        for (let row = from.row - r; row <= from.row + r; row++) {
          for (let col = from.col - r; col <= from.col + r; col++) {
            if (Math.max(Math.abs(row - from.row), Math.abs(col - from.col)) === r) ring.push({ col, row });
          }
        }
        const dist = (c: GridCell) => Math.hypot((c.col - from.col) * WATCH_CELL_W, c.row - from.row);
        nearest = ring.filter(free).sort((a, b) => dist(a) - dist(b))[0];
      }
      put(next.id, nearest);
    }
    const members = [...grid.keys()].map((id) => byId.get(id)!);
    const cellsOf = [...grid.values()];
    const minCol = Math.min(...cellsOf.map((c) => c.col));
    const minRow = Math.min(...cellsOf.map((c) => c.row));
    const cols = Math.max(...cellsOf.map((c) => c.col)) - minCol + 1;
    const rows = Math.max(...cellsOf.map((c) => c.row)) - minRow + 1;
    // The parent (the earlier-started bird; same as the indented parent in Perch) shows its name above itself (the user
    // chose this over a title on the block). Birds inside show no name if in the same folder as the parent; otherwise a
    // path relative to the parent (the folder name if not under it). The name row is kept even when empty, so a name
    // appearing doesn't move the birds
    const labelOf = (m: SessionView) => (m.id === parent.id ? parent.project : relativeLabel(parent, m));
    // Row height: name + bird + speech bubble room + status row + event marker row + the count row
    const rowH = glyphSize + NODE_TEXT_PX + NODE_MARKS_PX + STATUS_SUB_PX + WATCH_COUNT_PX + BUBBLE_ROOM_PX;
    const top = WATCH_PAD;
    const rowBubble = Array.from({ length: rows }, (_, r) =>
      members.some((m) => grid.get(m.id)!.row - minRow === r && bubbleText(m) !== undefined),
    );
    // Wide enough for a speech bubble inside the block, bubble or not (so the width doesn't change with bubbles)
    const width = Math.max(cols * WATCH_CELL_W, BUBBLE_MAX_PX) + 2 * WATCH_PAD;
    const footH = top + rows * rowH + WATCH_PAD;
    // When the block is wider than its cells (the bubble width), center the grid in the block
    const spare = (width - 2 * WATCH_PAD - cols * WATCH_CELL_W) / 2;
    const cells = new Map<string, WatchCell>();
    for (const m of members) {
      const c = grid.get(m.id)!;
      const row = c.row - minRow;
      cells.set(m.id, {
        dx: WATCH_PAD + spare + (c.col - minCol + 0.5) * WATCH_CELL_W,
        dy: top + row * rowH,
        rowH,
        // If any bird in the row shows a speech bubble, the others in the row also leave its room, so status rows line up
        bubbleRoom: rowBubble[row],
        label: labelOf(m),
        nameRoom: true,
      });
    }
    const links: [string, string][] = [];
    for (const [i, a] of members.entries()) {
      for (const b of members.slice(i + 1)) {
        if (linkedTo.get(a.id)?.has(b.id) && nextTo(grid.get(a.id)!, grid.get(b.id)!)) links.push([a.id, b.id]);
      }
    }
    shapes.push({
      rootId: parent.id,
      memberIds: members.map((m) => m.id),
      width,
      footH,
      rows,
      cells,
      grid,
      links,
    });
  }
  return shapes;
}

/** Horizontal range (px, relative to the block's left) that must contain a speech bubble inside the block */
export function watchBubbleRange(shape: WatchShape): { lo: number; hi: number } {
  return { lo: WATCH_PAD, hi: shape.width - WATCH_PAD };
}

type Pt = { x: number; y: number };

/**
 * The watch line between two birds' icon centers a and b (px; birds next to each other), as its two ends. It is short
 * and stops well short of both icons (docs/design.md "Watching": the user wants it seen only on a closer look): at most
 * maxLen long, centered between the icons, and at least gap from either icon's center. undefined when the icons are
 * too close for any of it to show
 */
export function watchLinePath(a: Pt, b: Pt, gap: number, maxLen: number): [Pt, Pt] | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 2 * gap) return undefined;
  const half = Math.min(maxLen, length - 2 * gap) / 2;
  const at = (d: number): Pt => ({ x: a.x + (dx * d) / length, y: a.y + (dy * d) / length });
  return [at(length / 2 - half), at(length / 2 + half)];
}
