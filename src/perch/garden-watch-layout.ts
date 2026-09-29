// Placement of watching groups in the garden (docs/design.md "Watching"). Pure computation from sessions, positions,
// and sizes (no DOM access); garden.tsx passes the measured sizes in
import type { GardenPosition } from "@/lib/garden-layout";
import type { SessionView } from "@/lib/sessions";
import { bubbleText } from "./bubble";
import { relativeLabel } from "./watch-links";

// Width of a garden node (.garden-node in styles/garden.css)
export const NODE_WIDTH_PX = 120;

/** Clamp to min..max. When the garden is smaller than the bird, use min (align to the left/top) */
export function clampInside(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

// Speech bubble height + gap to the bird. For a bird with a speech bubble, this much space is left between
// the icon and the name to place the bubble (same value as the height of .garden-bubble-room in styles/speech-bubble.css)
export const BUBBLE_ROOM_PX = 26;
// Estimated height of the non-glyph part of a garden node (name and status rows)
export const NODE_TEXT_PX = 32;
// Estimated max width of a speech bubble (max-width 15em × 11px of .speech-bubble-below in styles/speech-bubble.css
// + left/right padding)
export const BUBBLE_MAX_PX = 180;

// Watching groups (docs/design.md "Watching"): connected birds are packed into a small grid and enclosed in a rounded block.
// Cell width, padding inside the block, and gap between the block and the frame
const WATCH_CELL_W = 96;
const WATCH_PAD = 8;
const WATCH_EDGE = 4;
// Height of the row under a watching bird showing how many peers are active (.garden-watch-count in styles/garden-watch.css;
// text height + top gap)
export const WATCH_COUNT_PX = 18;
// Height of a garden bird's name row (.garden-name in styles/garden.css; text height + bottom gap). Rows in a block
// that show no names are tightened by this much
const GARDEN_NAME_PX = 16;
// Height of the parent's name row shown on the top edge of the block (.garden-watch-block-name in styles/garden-watch.css)
const WATCH_TITLE_PX = 16;
// Height of the second line of the status row (tool name; inside a block, elapsed time and tool name)
// (.garden-status-sub in styles/garden.css)
export const STATUS_SUB_PX = 15;

/** A bird's position within a group: CSS left (bird center) / top (bird's top edge; names are aligned to the top of the row)
    (expressions that follow when the garden is resized), and px at the current size */
export interface WatchPlace {
  left: string;
  top: string;
  // If any bird in the row shows a speech bubble, birds without one also reserve bubble space, so the status rows
  // line up within the row. This keeps a neighbor's speech bubble (wider than one cell) off this bird's status row
  bubbleRoom?: boolean;
  x: number;
  y: number;
  // Horizontal range (px) that must contain the speech bubble: inside the block (inside the padding). Absent for
  // birds not in a block. Only birds that have this use top as the bird's top edge (for birds moved out of a block,
  // top is the center)
  bubbleRange?: { lo: number; hi: number };
  // Name of a bird inside a block (docs/design.md "Watching"). undefined for the parent and for birds in the same
  // folder as the parent. nameRoom tells whether any bird in the row has a name. If so, birds without a name also
  // reserve the name row height, so icon heights line up within the row
  label?: string;
  nameRoom?: boolean;
}

/** What a group's birds move when dragged. rootId is the group's first-started bird; anchor is the block's current reference position (%) */
export interface WatchGroupRef {
  rootId: string;
  anchor: GardenPosition;
}

interface WatchBlock {
  key: string;
  // Name of the parent (the watching bird) shown on the top edge of the block
  title: string;
  left: string;
  top: string;
  width: number;
  height: number;
}

/**
 * Groups birds connected by watching (among those in the garden) and packs them into a grid centered on the
 * position of the first-started bird. The group uses as many columns as fit in the garden width, and the block
 * is also kept inside the frame. If any bird shows a speech bubble, each row reserves the bubble height so
 * bubbles don't overlap the block's border
 */
export function layoutWatchGroups(
  sessions: SessionView[],
  positionOf: (id: string) => GardenPosition,
  containerW: number,
  containerH: number,
  glyphSize: number,
  // The group being dragged (id of its first-started bird). It is not pushed back by other blocks and follows the pointer
  draggingRootId?: string,
  // Visible size of a bird (px), measured from the previous render. undefined if not drawn yet (use the estimate)
  sizeOf: (id: string) => { w: number; h: number } | undefined = () => undefined,
): { blocks: WatchBlock[]; places: Map<string, WatchPlace>; groupOf: Map<string, WatchGroupRef> } {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rank = new Map(sessions.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  const seen = new Set<string>();
  const blocks: WatchBlock[] = [];
  const places = new Map<string, WatchPlace>();
  const groupOf = new Map<string, WatchGroupRef>();
  const groups: {
    members: SessionView[];
    labels: (string | undefined)[];
    cols: number;
    rowTops: number[];
    bubbleRoom: number;
    width: number;
    height: number;
    anchor: GardenPosition;
  }[] = [];
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
    const members = component.sort(earlier);
    const n = members.length;
    const fitCols = containerW > 0 ? Math.floor((containerW - 2 * (WATCH_EDGE + WATCH_PAD)) / WATCH_CELL_W) : 3;
    const cols = Math.max(1, Math.min(n, fitCols));
    const rows = Math.ceil(n / cols);
    const bubbleRoom = members.some((m) => bubbleText(m) !== undefined) ? BUBBLE_ROOM_PX : 0;
    // Row height: name + bird + speech bubble height + status row + event marker row + (if a watching bird is present)
    // the count row under it. The bubble height is included in the row so bubbles don't overlap the next row's names and birds
    const countRoom = members.some((m) => m.watching !== undefined) ? WATCH_COUNT_PX : 0;
    // Only one name is shown on the block's top edge: the parent's (the earlier-started bird; same as the indented parent in
    // Perch). Birds inside show no name if in the same folder as the parent; otherwise a path relative to the parent (the
    // folder name if not under it). Rows with no names have their name row tightened
    const parent = members[0];
    const labels = members.map((m, i) => (i === 0 ? undefined : relativeLabel(parent, m)));
    const rowTops: number[] = [];
    let y = WATCH_PAD + WATCH_TITLE_PX;
    for (let r = 0; r < rows; r++) {
      rowTops.push(y);
      const named = labels.slice(r * cols, (r + 1) * cols).some((l) => l !== undefined);
      // Reserve bubble space only in rows that have a bird with a speech bubble (a neighbor's bubble only overlaps
      // within the same row; reserving it in rows without bubbles leaves a loose gap between icon and status row)
      const rowBubble = members.slice(r * cols, (r + 1) * cols).some((m) => bubbleText(m) !== undefined);
      y +=
        glyphSize +
        NODE_TEXT_PX -
        (named ? 0 : GARDEN_NAME_PX) +
        14 +
        STATUS_SUB_PX +
        countRoom +
        (rowBubble ? BUBBLE_ROOM_PX : 0);
    }
    rowTops.push(y);
    // If any bird shows a speech bubble, use a width that fits the bubble inside the block as the minimum
    const width = Math.max(cols * WATCH_CELL_W, bubbleRoom > 0 ? BUBBLE_MAX_PX : 0) + 2 * WATCH_PAD;
    const height = y + WATCH_PAD;
    groups.push({ members, labels, cols, rowTops, bubbleRoom, width, height, anchor: positionOf(members[0].id) });
  }
  // Place the group being dragged first (never pushed back), then the others from top to bottom
  groups.sort(
    (a, b) =>
      Number(b.members[0].id === draggingRootId) - Number(a.members[0].id === draggingRootId) ||
      a.anchor.y - b.anchor.y,
  );
  // 1) Place blocks (px). If blocks overlap, shift the later one down (or up if it doesn't fit)
  const layoutReady = containerW > 0 && containerH > 0;
  const placedGroups: { group: (typeof groups)[number]; cx: number; cy: number }[] = [];
  const rectOf = (g: (typeof groups)[number], cx: number, cy: number) => ({
    top: cy - g.height / 2,
    bottom: cy + g.height / 2,
    left: cx - g.width / 2,
    right: cx + g.width / 2,
  });
  for (const group of groups) {
    const { width, height, anchor: wanted } = group;
    const halfW = width / 2 + WATCH_EDGE;
    const halfH = height / 2 + WATCH_EDGE;
    const cx = clampInside((wanted.x / 100) * containerW, halfW, containerW - halfW);
    let cy = clampInside((wanted.y / 100) * containerH, halfH, containerH - halfH);
    if (layoutReady) {
      const overlaps = (y: number) =>
        placedGroups
          .map((pg) => rectOf(pg.group, pg.cx, pg.cy))
          .filter(
            (r) =>
              cx - width / 2 < r.right && cx + width / 2 > r.left && y - height / 2 < r.bottom && y + height / 2 > r.top,
          );
      let hits = overlaps(cy);
      // Shift down. If it doesn't fit, look for free space above
      while (hits.length > 0 && cy + halfH <= containerH) {
        cy = Math.max(...hits.map((r) => r.bottom)) + WATCH_EDGE + height / 2;
        hits = overlaps(cy);
      }
      if (hits.length > 0 || cy + halfH > containerH) {
        cy = halfH;
        hits = overlaps(cy);
        while (hits.length > 0 && cy + halfH <= containerH) {
          cy = Math.max(...hits.map((r) => r.bottom)) + WATCH_EDGE + height / 2;
          hits = overlaps(cy);
        }
        cy = clampInside(cy, halfH, containerH - halfH);
      }
    }
    placedGroups.push({ group, cx, cy });
  }

  // 2) If a bird outside any group overlaps a block, move it out of the block so it doesn't look like a group member.
  // The same applies when starting from saved positions (IndexedDB). If there's no room for one bird anywhere above,
  // below, left, or right of the block, push the block to the garden edge (top or bottom) opposite the bird to make
  // room, and search again
  const outside = new Map<string, { x: number; y: number }>();
  if (layoutReady && placedGroups.length > 0) {
    const members = new Set(placedGroups.flatMap((pg) => pg.group.members.map((m) => m.id)));
    const rects = () => placedGroups.map((pg) => rectOf(pg.group, pg.cx, pg.cy));
    for (const s of sessions) {
      if (members.has(s.id)) continue;
      // For each bird, search for space using its actual visible size (measured from the previous render; the estimate
      // if not yet available). Estimating with the node box (120px) judges it too wide for the space beside a block in a
      // narrow garden
      const size = sizeOf(s.id);
      const halfW = (size?.w ?? NODE_WIDTH_PX) / 2;
      const halfH = (size?.h ?? glyphSize + NODE_TEXT_PX) / 2;
      const hitRect = (xx: number, yy: number) =>
        rects().findIndex(
          (r) => xx - halfW < r.right && xx + halfW > r.left && yy - halfH < r.bottom && yy + halfH > r.top,
        );
      const freeSpot = (x: number, y: number) => {
        const rs = rects();
        const xs = [x, ...rs.flatMap((r) => [r.left - WATCH_EDGE - halfW, r.right + WATCH_EDGE + halfW])];
        const ys = [y, ...rs.flatMap((r) => [r.top - WATCH_EDGE - halfH, r.bottom + WATCH_EDGE + halfH])];
        let best: { x: number; y: number; d: number } | undefined;
        for (const cx of xs) {
          for (const cy of ys) {
            if (cx < halfW || cx > containerW - halfW || cy < halfH || cy > containerH - halfH) continue;
            if (hitRect(cx, cy) >= 0) continue;
            const d = Math.hypot(cx - x, cy - y);
            if (!best || d < best.d) best = { x: cx, y: cy, d };
          }
        }
        return best;
      };
      const pos = positionOf(s.id);
      const x = clampInside((pos.x / 100) * containerW, halfW, containerW - halfW);
      const y = clampInside((pos.y / 100) * containerH, halfH, containerH - halfH);
      const hit = hitRect(x, y);
      if (hit < 0) continue;
      let best = freeSpot(x, y);
      if (!best) {
        // Don't move the block being dragged (the position following the pointer takes priority)
        const pg = placedGroups[hit];
        if (pg.group.members[0].id !== draggingRootId) {
          const halfBlockH = pg.group.height / 2 + WATCH_EDGE;
          pg.cy = y < pg.cy ? containerH - halfBlockH : halfBlockH;
          best = freeSpot(x, y);
        }
      }
      if (best) outside.set(s.id, { x: best.x, y: best.y });
    }
  }

  // 3) Output block and bird positions. Positions are converted back to ratios as CSS expressions (so they follow
  // when the garden is resized)
  for (const { group, cx, cy } of placedGroups) {
    const { members, labels, cols, rowTops, width, height, anchor: wanted } = group;
    const rows = rowTops.length - 1;
    const n = members.length;
    const halfW = width / 2 + WATCH_EDGE;
    const halfH = height / 2 + WATCH_EDGE;
    const anchor = layoutReady ? { x: wanted.x, y: (cy / containerH) * 100 } : wanted;
    const blockLeft = `clamp(${halfW}px, ${anchor.x}%, calc(100% - ${halfW}px))`;
    const blockTop = `clamp(${halfH}px, ${anchor.y}%, calc(100% - ${halfH}px))`;
    blocks.push({ key: members[0].id, title: members[0].project, left: blockLeft, top: blockTop, width, height });
    for (const m of members) groupOf.set(m.id, { rootId: members[0].id, anchor });
    members.forEach((m, i) => {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const col = i % cols;
      // When the block was widened to the speech bubble width, center the grid in the block
      const spare = (width - 2 * WATCH_PAD - cols * WATCH_CELL_W) / 2;
      const dx = -width / 2 + WATCH_PAD + spare + ((cols - inRow) / 2 + col + 0.5) * WATCH_CELL_W;
      // Align the bird's top edge (name) to the top of the row. Even if birds differ in height because some have lower
      // rows (the count under them, markers), names and icons line up
      const dy = -height / 2 + rowTops[row];
      places.set(m.id, {
        left: `calc(${blockLeft} + ${dx}px)`,
        top: `calc(${blockTop} + ${dy}px)`,
        x: cx + dx,
        y: cy + dy + (rowTops[row + 1] - rowTops[row]) / 2,
        bubbleRoom: members.slice(row * cols, (row + 1) * cols).some((m) => bubbleText(m) !== undefined),
        label: labels[i],
        nameRoom: labels.slice(row * cols, (row + 1) * cols).some((l) => l !== undefined),
        bubbleRange: { lo: cx - width / 2 + WATCH_PAD, hi: cx + width / 2 - WATCH_PAD },
      });
    });
  }
  for (const [id, { x, y }] of outside) {
    places.set(id, { left: `${(x / containerW) * 100}%`, top: `${(y / containerH) * 100}%`, x, y });
  }
  return { blocks, places, groupOf };
}
