// Shapes of watching groups in the garden (docs/design.md "Watching"). Pure computation from sessions and sizes (no DOM
// access). Where a block goes is decided with the birds by placeBoxes in lib/garden-place.ts (garden.tsx)
import { PLACE_EDGE_PX, PLACE_GAP_PX } from "@/lib/garden-place";
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

// Watching groups (docs/design.md "Watching"): connected birds are packed into a small grid and enclosed in a rounded block.
// Cell width and padding inside the block. A cell is as wide as a bird's footprint plus the gap between footprints
// (lib/garden-place.ts), so when a block goes away its birds stay where they were without overlapping each other
const WATCH_CELL_W = NODE_WIDTH_PX + PLACE_GAP_PX;
const WATCH_PAD = 8;
// Most columns a block uses (fewer when the garden is too narrow for them; watchColumnLimit)
const WATCH_MAX_COLS = 3;
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

export interface WatchShape {
  // The group's first-started bird (the parent). Also the block's key
  rootId: string;
  // In cell order
  memberIds: string[];
  width: number;
  // Drawn height: the footprint without the bubble room of the last row when no bird in it has a bubble (only the
  // bottom border moves; no bird does)
  height: number;
  // Footprint height for placement. Every row is the same fixed height (name row, bubble room, both status lines,
  // count row), so a bubble, a name, or a count appearing never moves a bird in the block or grows the block into a
  // neighbour (docs/design.md "Layout")
  footH: number;
  // Rows of icons in the block (footH grows by this many icon heights)
  rows: number;
  cells: Map<string, WatchCell>;
}

/** How many columns a block may use in a garden w px wide (at least 1) */
export function watchColumnLimit(w: number): number {
  return Math.max(1, Math.min(WATCH_MAX_COLS, Math.floor((w - 2 * (PLACE_EDGE_PX + WATCH_PAD)) / WATCH_CELL_W)));
}

/**
 * Groups birds connected by watching (among those in the garden) and packs each group into a small grid. Members are
 * ordered by start time, so a bird that joins later goes to the end and the others keep their cells. colLimit gives
 * the most columns each block (by its first-started bird) may use
 */
export function watchShapes(
  sessions: SessionView[],
  glyphSize: number,
  colLimit: (rootId: string) => number = () => WATCH_MAX_COLS,
  // Order of the cells, by the block's first-started bird: the members as they were already laid out, so a block keeps
  // its birds in their cells and a block that forms puts them in the order they stood. Members it leaves out follow in
  // start order
  cellOrder: (rootId: string, memberIds: string[]) => string[] = (_, ids) => ids,
): WatchShape[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rank = new Map(sessions.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
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
      for (const peer of current.peers ?? []) {
        const next = peer.viewId ? byId.get(peer.viewId) : undefined;
        if (next && !seen.has(next.id)) {
          seen.add(next.id);
          queue.push(next);
        }
      }
    }
    if (component.length < 2) continue;
    const byStart = component.sort(earlier);
    const n = byStart.length;
    const parent = byStart[0];
    const preferred = cellOrder(
      parent.id,
      byStart.map((m) => m.id),
    ).filter((id) => byStart.some((m) => m.id === id));
    const members = [
      ...preferred.map((id) => byId.get(id)!),
      ...byStart.filter((m) => !preferred.includes(m.id)),
    ];
    const cols = Math.max(1, Math.min(n, colLimit(parent.id), WATCH_MAX_COLS));
    const rows = Math.ceil(n / cols);
    // The parent (the earlier-started bird; same as the indented parent in Perch) shows its name above itself, wherever its
    // cell is: a name on the block's top edge read as the name of whichever bird sat below it (the user chose this).
    // Birds inside show no name if in the same folder as the parent; otherwise a path relative to the parent (the folder
    // name if not under it). The name row is kept even when empty, so a name appearing doesn't move the birds
    const labels = members.map((m) => (m.id === parent.id ? parent.project : relativeLabel(parent, m)));
    // Row height: name + bird + speech bubble room + status row + event marker row + the count row
    const rowH = glyphSize + NODE_TEXT_PX + NODE_MARKS_PX + STATUS_SUB_PX + WATCH_COUNT_PX + BUBBLE_ROOM_PX;
    const top = WATCH_PAD;
    const rowBubble = Array.from({ length: rows }, (_, r) =>
      members.slice(r * cols, (r + 1) * cols).some((m) => bubbleText(m) !== undefined),
    );
    // Wide enough for a speech bubble inside the block, bubble or not (so the width doesn't change with bubbles)
    const width = Math.max(cols * WATCH_CELL_W, BUBBLE_MAX_PX) + 2 * WATCH_PAD;
    const footH = top + rows * rowH + WATCH_PAD;
    const cells = new Map<string, WatchCell>();
    members.forEach((m, i) => {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const col = i % cols;
      // When the block is wider than its cells (the bubble width), center the grid in the block
      const spare = (width - 2 * WATCH_PAD - cols * WATCH_CELL_W) / 2;
      cells.set(m.id, {
        dx: WATCH_PAD + spare + ((cols - inRow) / 2 + col + 0.5) * WATCH_CELL_W,
        dy: top + row * rowH,
        rowH,
        // If any bird in the row shows a speech bubble, the others in the row also leave its room, so status rows line up
        bubbleRoom: rowBubble[row],
        label: labels[i],
        nameRoom: true,
      });
    });
    shapes.push({
      rootId: parent.id,
      memberIds: members.map((m) => m.id),
      width,
      height: footH - (rowBubble[rows - 1] ? 0 : BUBBLE_ROOM_PX),
      footH,
      rows,
      cells,
    });
  }
  return shapes;
}

/** Horizontal range (px, relative to the block's left) that must contain a speech bubble inside the block */
export function watchBubbleRange(shape: WatchShape): { lo: number; hi: number } {
  return { lo: WATCH_PAD, hi: shape.width - WATCH_PAD };
}
