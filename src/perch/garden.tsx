import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { t } from "@/lib/i18n";
import {
  autoGardenPosition,
  clampGardenPosition,
  gardenCellOf,
  gardenGrid,
  hashId,
  loadGardenPositions,
  saveGardenPositions,
  type GardenPosition,
} from "@/lib/garden-layout";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { resolveIconSet } from "./icon-sets";
import { hasQuestion, isAngry, needsAnswer } from "@/lib/jev";
import { createPortal } from "react-dom";
import { MdLink } from "react-icons/md";
import { bubbleText, SpeechBubble } from "./bubble";
import { BirdGlyph } from "./bird-glyph";
import { StatusParts } from "./bird-status";
import { EVENT, EventIcon, eventKind } from "./event-kind";
import { formatEventTime } from "./format-time";
import { relativeLabel } from "./watch-links";

// Width of a garden node (.garden-node in perch.css) and the minimum gap from the frame
const NODE_WIDTH_PX = 120;
const NODE_EDGE_PX = 4;

/**
 * The actually visible width of a node (the widest of the bird, name, and status rows). Clamping by the
 * node box (120px) pushes birds into a narrow strip in the middle of a narrow garden where they overlap,
 * so measure by the visible content
 */
function visibleWidth(node: HTMLElement | null): number {
  if (!node) return 0;
  let width = 0;
  for (const selector of [".garden-glyph", ".garden-name", ".garden-status"]) {
    const el = node.querySelector<HTMLElement>(selector);
    if (el) width = Math.max(width, el.offsetWidth);
  }
  // The "?" sticks out to the right of the bird and the anger mark to the left, so add their widths
  for (const badge of node.querySelectorAll<HTMLElement>(".garden-glyph .bird-badge")) width += badge.offsetWidth;
  return width;
}

/** Clamp to min..max. When the garden is smaller than the bird, use min (align to the left/top) */
function clampInside(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

// Speech bubble height + gap to the bird. For a bird with a speech bubble, this much space is left between
// the icon and the name to place the bubble (same value as the height of .garden-bubble-room in perch.css)
const BUBBLE_ROOM_PX = 26;
// Estimated height of the non-glyph part of a garden node (name and status rows)
const NODE_TEXT_PX = 32;
// Gap left between birds by auto placement (px)
const AUTO_GAP_PX = 12;
// Estimated max width of a speech bubble (max-width 15em × 11px of .speech-bubble-below in perch.css
// + left/right padding)
const BUBBLE_MAX_PX = 180;
// min-height of .garden in perch.css (it is overridden via style, so never go below it)
const GARDEN_MIN_HEIGHT_PX = 220;
// Keep speech bubbles this far inside the garden frame
const BUBBLE_EDGE_PX = 4;

/** From the bird's horizontal position (px) and the range lo..hi that must contain the speech bubble (px; inside the garden frame or a watching block), the position that keeps the bubble inside. undefined if it fits directly below (centered) */
function bubbleShift(x: number, lo: number, hi: number): CSSProperties | undefined {
  if (hi <= lo) return undefined;
  const half = BUBBLE_MAX_PX / 2;
  if (x - half < lo) {
    const tail = x - lo;
    return {
      left: `calc(50% - ${tail}px)`,
      transform: "none",
      "--tail-left": `${tail}px`,
    } as CSSProperties;
  }
  if (x + half > hi) {
    const tail = hi - x;
    return {
      left: "auto",
      right: `calc(50% - ${tail}px)`,
      transform: "none",
      "--tail-left": "auto",
      "--tail-right": `${tail}px`,
    } as CSSProperties;
  }
  return undefined;
}

// Stacking order of a node being dragged. Above the speech bubble order (1 to the number of birds)
const BUBBLE_Z_DRAGGING = 1000;

// Watching groups (docs/design.md "Watching"): connected birds are packed into a small grid and enclosed in a rounded block.
// Cell width, padding inside the block, and gap between the block and the frame
const WATCH_CELL_W = 96;
const WATCH_PAD = 8;
const WATCH_EDGE = 4;
// Height of the row under a watching bird showing how many peers are active (.garden-watch-count in perch.css;
// text height + top gap)
const WATCH_COUNT_PX = 18;
// Height of a garden bird's name row (.garden-name in perch.css; text height + bottom gap). Rows in a block
// that show no names are tightened by this much
const GARDEN_NAME_PX = 16;
// Height of the parent's name row shown on the top edge of the block (.garden-watch-block-name in perch.css)
const WATCH_TITLE_PX = 16;
// Height of the second line of the status row (tool name; inside a block, elapsed time and tool name)
// (.garden-status-sub in perch.css)
const STATUS_SUB_PX = 15;

/** A bird's position within a group: CSS left (bird center) / top (bird's top edge; names are aligned to the top of the row)
    (expressions that follow when the garden is resized), and px at the current size */
interface WatchPlace {
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
interface WatchGroupRef {
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
function layoutWatchGroups(
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

// Releasing after moving less than this counts as a click (jump to the Ghostty pane), not a drag
const CLICK_SLOP_PX = 4;

// Number of recent event icons shown under a node (only the latest one, so the garden doesn't get crowded)
const HISTORY_LIMIT = 1;

// Snapshot of a node that is fading out (its process ended). Rendered only while it is in leaving.
// session/position freeze the values from "the last render where it was still shown"
type LeavingEntry = {
  session: SessionView;
  position: GardenPosition;
};

export function Garden({
  sessions,
  events,
  hasGranted,
  iconSetAssignments = {},
  onFocus,
  canFocus,
}: {
  sessions: SessionView[];
  events: SessionEvent[];
  hasGranted: boolean;
  // slug → assignment map (same meaning as in Perch in perch-list.tsx; passed from App.tsx)
  iconSetAssignments?: IconSetAssignments;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Holds only saved positions (index-based auto placement is not included here).
  // Auto placement isn't persisted until dragged, so sessions that disappear without
  // being dragged don't remain in storage
  const [positions, setPositions] = useState<Record<string, GardenPosition>>({});
  // Sticky auto-placement assignments (id → position). Read and written during render, but assignment is
  // deterministic and happens once, so it is idempotent. Not persisted (moves to positions once dragged)
  const autoPosRef = useRef<Map<string, GardenPosition>>(new Map());
  // Grid (columns x rows) used when autoPosRef was decided
  const autoGridRef = useRef("");

  useEffect(() => {
    let alive = true;
    void loadGardenPositions().then((loaded) => {
      if (alive) setPositions(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Actual size of the container (.garden). Used to compute the glyph size from the number of birds.
  // Follows window resizes via ResizeObserver
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // The garden frame (.garden) isn't drawn when there are no birds (the early return below). If the frame was missing
  // on the first render, the observer was never attached and the layout stayed at the old size even after resizing the
  // window, so re-attach it when the frame appears. Also re-measure on window resize (a safeguard in case
  // ResizeObserver breaks when moved to another document)
  const hasGardenFrame = sessions.length > 0;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setContainerSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const win = el.ownerDocument.defaultView ?? window;
    win.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      win.removeEventListener("resize", measure);
    };
  }, [hasGardenFrame]);

  // Safeguard: the portalHost containing this is moved into the PiP window with document.body.append
  // (see App.tsx), so ResizeObserver may break during the move to another document.
  // Re-measuring with getBoundingClientRect after every render means the re-render from the 3-second
  // polling catches up within 3 seconds at most. Skip setState if the value is unchanged (avoids an infinite loop)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setContainerSize((prev) =>
      prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height },
    );
  });

  // Birds already present when the tab is first shown should be laid out statically without the fly-in animation.
  // It stays false during the first render (= every node created in this render
  // receives entryOrigin="none") and is set to true in an effect after commit. After that, only nodes newly
  // mounted by polling get animateEntry=true
  const initializedRef = useRef(false);
  const animateEntry = initializedRef.current;
  useEffect(() => {
    initializedRef.current = true;
  }, []);

  // Nodes in their leaving animation (fading out). A replacement for
  // AnimatePresence: ids that disappear from sessions are moved here and removed via onExited when the
  // WAAPI leaving animation in GardenNode finishes
  const [leaving, setLeaving] = useState<Map<string, LeavingEntry>>(new Map());
  // Snapshot of id → {session, position} for ids that were shown in the previous render. Used when adding to
  // leaving, to freeze the look at the moment it disappeared (the state while it was still shown)
  const shownSnapshotRef = useRef<Map<string, { session: SessionView; position: GardenPosition }>>(
    new Map(),
  );

  const handleExited = useCallback((id: string) => {
    setLeaving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Previous glyphSize (to keep the previous size while computation is skipped at zero width)
  const glyphSizeRef = useRef(30);

  const handleDragEnd = useCallback((id: string, next: GardenPosition, liveIds: string[]) => {
    setPositions((prev) => {
      // Positions of sessions that have disappeared are pruned on save (only existing ids are kept)
      const currentIds = new Set(liveIds);
      const pruned: Record<string, GardenPosition> = {};
      for (const [pid, ppos] of Object.entries(prev)) {
        if (currentIds.has(pid)) pruned[pid] = ppos;
      }
      pruned[id] = next;
      void saveGardenPositions(pruned);
      return pruned;
    });
  }, []);

  // Every session whose process is alive is a node in the garden, dozing ones included (docs/design.md
  // "Garden layout"). The useLayoutEffect below must be called on every render (Rules of Hooks), so
  // compute this before the sessions.length===0 early return
  const liveIds = sessions.map((s) => s.id);
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);
  // Dragging a watching group (docs/design.md "Watching": dragging moves the whole block). The id of the group's first-started
  // bird and the current block reference position (%)
  const [groupDrag, setGroupDrag] = useState<WatchGroupRef | null>(null);
  // When speech bubbles overlap, stack birds whose turn ended more recently (smaller sinceMs) on top
  const bubbleOrder = new Map(
    sessions
      .filter((s) => bubbleText(s) !== undefined)
      .sort((a, b) => b.sinceMs - a.sinceMs)
      .map((s, i) => [s.id, i + 1] as const),
  );

  // Decide the glyph size from the number of birds and the container's actual size. At zero width (tab hidden),
  // skip the computation and keep the previous value (held in a ref)
  if (containerSize.w > 0 && containerSize.h > 0) {
    const count = Math.max(sessions.length, 1);
    const raw = Math.sqrt((containerSize.w * containerSize.h) / count) * 0.16;
    glyphSizeRef.current = Math.min(52, Math.max(26, Math.round(raw)));
  }
  const glyphSize = glyphSizeRef.current;

  // Auto placement: "a bird newly entering the garden picks a cell not taken by existing birds" (where possible).
  // Once decided, an auto placement is fixed in memory while shown (sticky) and doesn't move as other birds come and go.
  // The sticky entry is dropped once a saved position (dragged) exists, and also for birds that left the garden.
  // The grid is derived from the garden size and the size of one bird (name, icon, bubble space, status row, marker,
  // count under it). With a fixed grid, birds made taller by the name on top and the bubble space overlapped the next
  // row even in a wide garden
  const anyBubble = sessions.some((s) => bubbleText(s) !== undefined);
  const nodeW = (anyBubble ? BUBBLE_MAX_PX : NODE_WIDTH_PX) + AUTO_GAP_PX;
  const nodeH =
    glyphSize +
    NODE_TEXT_PX +
    14 +
    (sessions.some((s) => s.toolName !== undefined) ? STATUS_SUB_PX : 0) +
    (anyBubble ? BUBBLE_ROOM_PX : 0) +
    (sessions.some((s) => s.watching !== undefined) ? WATCH_COUNT_PX : 0) +
    AUTO_GAP_PX;
  const grid = gardenGrid(containerSize.w, containerSize.h, nodeW, nodeH, sessions.length);
  const present = new Set(sessions.map((s) => s.id));
  const sticky = autoPosRef.current;
  // When the grid's columns/rows change (the garden size or the presence of speech bubbles changed), re-place
  // auto-placed positions
  const gridKey = `${grid.cols}x${grid.rows}`;
  if (autoGridRef.current !== gridKey) {
    autoGridRef.current = gridKey;
    sticky.clear();
  }
  for (const id of [...sticky.keys()]) {
    if (!present.has(id) || positions[id]) sticky.delete(id);
  }
  // Cells already occupied by birds = saved positions + already-assigned sticky entries
  const taken = new Set<number>();
  for (const s of sessions) {
    const p = positions[s.id] ?? sticky.get(s.id);
    if (p) taken.add(gardenCellOf(p, grid));
  }
  // New assignments are made in a stable id order (not dependent on the state sort order)
  for (const s of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (positions[s.id] || sticky.has(s.id)) continue;
    const pos = autoGardenPosition(s.id, taken, grid);
    sticky.set(s.id, pos);
    taken.add(gardenCellOf(pos, grid));
  }
  const resolvePosition = (id: string): GardenPosition =>
    positions[id] ?? sticky.get(id) ?? autoGardenPosition(id, taken, grid);

  // useLayoutEffect: add ids that disappeared from sessions to leaving. It runs synchronously before paint (right
  // after commit), so the frame where a node "vanishes from the DOM for a moment and comes back as leaving" is
  // never visible (react-dom doesn't let the browser paint until the next commit). The dependency array is
  // intentionally not empty; the session set is diffed after every render.
  // Placed before the sessions.length===0 (all sessions gone) early return: Hooks must be
  // called in the same order on every render (Rules of Hooks), and placing it after the early return
  // means this hook isn't called only at the moment the count hits 0, crashing with "Rendered fewer hooks"
  useLayoutEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.id));
    const prevSnapshot = shownSnapshotRef.current;

    setLeaving((prev) => {
      let next = prev;
      const ensureCopy = () => {
        if (next === prev) next = new Map(prev);
      };
      // Ids that reappear in sessions are removed from leaving immediately ("shown wins, leaving is discarded")
      for (const id of currentIds) {
        if (next.has(id)) {
          ensureCopy();
          next.delete(id);
        }
      }
      // Add ids that newly disappeared from sessions (the session itself is gone)
      for (const [id, entry] of prevSnapshot) {
        if (!currentIds.has(id) && !next.has(id)) {
          ensureCopy();
          next.set(id, { session: entry.session, position: entry.position });
        }
      }
      return next;
    });

    const newSnapshot = new Map<string, { session: SessionView; position: GardenPosition }>();
    for (const s of sessions) {
      newSnapshot.set(s.id, { session: s, position: resolvePosition(s.id) });
    }
    shownSnapshotRef.current = newSnapshot;
  });

  if (sessions.length === 0) {
    return (
      <div className="empty">
        {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
      </div>
    );
  }

  // For the group being dragged, replace the first-started bird's position to follow the pointer movement
  const groupPositionOf = (id: string): GardenPosition =>
    groupDrag && id === groupDrag.rootId ? groupDrag.anchor : resolvePosition(id);
  const watchGroups = layoutWatchGroups(
    sessions,
    groupPositionOf,
    containerSize.w,
    containerSize.h,
    glyphSize,
    groupDrag?.rootId,
    (id) => {
      const node = containerRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`);
      if (!node) return undefined;
      const w = visibleWidth(node);
      return w > 0 ? { w, h: node.offsetHeight } : undefined;
    },
  );
  // When birds don't fit in a narrow garden, stretch the garden vertically (the window scrolls). Better than
  // overlapping them until unreadable. Birds inside watching blocks aren't counted; the block heights are added instead
  const fitCols = Math.max(1, Math.floor(containerSize.w / nodeW));
  const looseCount = sessions.filter((s) => !watchGroups.groupOf.has(s.id)).length;
  const blocksH = watchGroups.blocks.reduce((sum, b) => sum + b.height + AUTO_GAP_PX, 0);
  const gardenMinHeight =
    containerSize.w > 0
      ? Math.max(GARDEN_MIN_HEIGHT_PX, Math.ceil(looseCount / fitCols) * nodeH + blocksH)
      : undefined;
  return (
    <div className="garden" ref={containerRef} style={{ minHeight: gardenMinHeight }}>
      {/* Speech bubble layer. Placed above the bird/name layer so no bird's name hides bubble text (or the "…").
          Among bubbles, newer turns are on top (bubbleOrder) */}
      <div className="garden-bubble-layer" ref={setBubbleLayer} />
      {/* Rounded block enclosing a watching group. Laid under the bird layer (docs/design.md "Watching") */}
      {watchGroups.blocks.map((b) => (
        <div
          key={b.key}
          className="garden-watch-block"
          style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
        >
          {/* Only the parent's name (birds inside show a name only where it differs) */}
          <span className="garden-watch-block-name">
            {b.title}
          </span>
        </div>
      ))}
      {sessions.map((s) => {
        const position = resolvePosition(s.id);
        const stackOrder = bubbleOrder.get(s.id);
        // events arrive newest first (lib/sessions.ts), so taking from the start keeps them newest first
        const recent = events.filter((e) => e.sessionId === s.id).slice(0, HISTORY_LIMIT);
        // On first display, static without flying; new sessions come from the sky
        const entryOrigin: "none" | "sky" = animateEntry ? "sky" : "none";
        return (
          <GardenNode
            key={s.id}
            session={s}
            position={position}
            recentEvents={recent}
            containerRef={containerRef}
            entryOrigin={entryOrigin}
            glyphSize={glyphSize}
            iconSet={resolveIconSet(iconSetAssignments, s.slug)}
            onDragEnd={(next) => handleDragEnd(s.id, next, liveIds)}
            stackOrder={stackOrder}
            bubbleLayer={bubbleLayer}
            watchPlace={watchGroups.places.get(s.id)}
            watchGroup={watchGroups.groupOf.get(s.id)}
            onGroupMove={setGroupDrag}
            onGroupDrop={(group) => {
              setGroupDrag(null);
              handleDragEnd(group.rootId, group.anchor, liveIds);
            }}
            focusable={Boolean(onFocus && canFocus?.(s.id))}
            onClick={() => onFocus?.(s.id)}
          />
        );
      })}
      {Array.from(leaving.entries()).map(([id, entry]) => (
        <GardenNode
          key={id}
          session={entry.session}
          position={entry.position}
          recentEvents={[]}
          containerRef={containerRef}
          entryOrigin="none"
          glyphSize={glyphSize}
          iconSet={resolveIconSet(iconSetAssignments, entry.session.slug)}
          onDragEnd={() => {}}
          exiting
          onExited={handleExited}
        />
      ))}
    </div>
  );
}

function GardenNode({
  session,
  position,
  recentEvents,
  containerRef,
  entryOrigin,
  glyphSize,
  iconSet,
  onDragEnd,
  exiting,
  onExited,
  focusable = false,
  onClick,
  stackOrder,
  bubbleLayer,
  watchPlace,
  watchGroup,
  onGroupMove,
  onGroupDrop,
}: {
  session: SessionView;
  position: GardenPosition;
  recentEvents: SessionEvent[];
  containerRef: RefObject<HTMLDivElement | null>;
  entryOrigin: "none" | "sky";
  glyphSize: number;
  iconSet: IconSetId;
  onDragEnd: (next: GardenPosition) => void;
  exiting?: boolean;
  onExited?: (id: string) => void;
  focusable?: boolean;
  onClick?: () => void;
  // Stacking order of the speech bubble (higher is on top). undefined for birds without a bubble
  stackOrder?: number;
  // Where the speech bubble is rendered (Garden's .garden-bubble-layer)
  bubbleLayer?: HTMLElement | null;
  // Position within a watching group (layoutWatchGroups). If present, place the bird here
  watchPlace?: WatchPlace;
  // A bird in a group drags the whole block (moves the block's reference position, not its own position)
  watchGroup?: WatchGroupRef;
  onGroupMove?: (group: WatchGroupRef) => void;
  onGroupDrop?: (group: WatchGroupRef) => void;
}) {
  // Whether this bird needs a reply (switches the state word / tool name) and whether to show the "?" (only birds
  // actually asking)
  const asking = needsAnswer(session.state, session.ask);
  const question = hasQuestion(session);
  const bubble = bubbleText(session);
  const nodeRef = useRef<HTMLDivElement>(null);
  const glyphRef = useRef<HTMLSpanElement>(null);
  // Birds in a watching group may reserve bubble space even without a speech bubble (WatchPlace.bubbleRoom)
  const bubbleRoom = Boolean(bubble) || Boolean(watchPlace?.bubbleRoom);
  // From the node's top edge to the icon's bottom edge (the top of the speech bubble). The icon resizes smoothly
  // with the garden size (transition in perch.css), so track size changes instead of reading once at render
  const [glyphBottom, setGlyphBottom] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = glyphRef.current;
    if (!el) return;
    const measure = () => setGlyphBottom(el.offsetTop + el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Target driven directly by WAAPI (element.animate) for the enter/leave animations. It assumes no CSS transform
  // is applied (positioning is handled by the outer .garden-node), so it doesn't conflict with animate's transform
  // keyframes
  const innerRef = useRef<HTMLDivElement>(null);
  // Temporary position for following the pointer, valid only while dragging. When null, use the position prop
  // (saved value / auto placement)
  const [live, setLive] = useState<GardenPosition | null>(null);

  // onDragEnd is a closure Garden creates anew on every render (including setSessions from the 3-second polling).
  // Putting it directly in the effect's dependency array would clean up and re-set up the effect below on every
  // poll, and during a drag dragging/startRect/grabOffset would be silently reset and the drag would break (a real
  // bug). Read the latest value through a ref and attach the effect itself only once on mount
  const onDragEndRef = useRef(onDragEnd);
  const onClickRef = useRef(onClick);
  const groupRef = useRef({ watchGroup, onGroupMove, onGroupDrop });
  useEffect(() => {
    onDragEndRef.current = onDragEnd;
    onClickRef.current = onClick;
    groupRef.current = { watchGroup, onGroupMove, onGroupDrop };
  });

  // Dragging needs continuous tracking beyond the node via setPointerCapture (keeps receiving pointermove/pointerup
  // even outside the node), so always attach with native addEventListener rather than React's synthetic
  // events. Per-node listeners keep working even when moved across documents
  // (see the portalHost comment in App.tsx).
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    let startRect: DOMRect | null = null;
    let dragging = false;
    // Nodes are centered via translate(-50%, -50%). Without keeping the offset between the grab point and the center,
    // the center snaps to the cursor and jumps the moment a drag starts
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    // Pointer-down position, to tell a drag (moved) from a click (not moved)
    let downX = 0;
    let downY = 0;
    let moved = false;
    // Block reference position (%) when a group's bird was grabbed. It is moved by the pointer's movement
    let groupStart: WatchGroupRef | undefined;

    const onPointerDown = (e: PointerEvent) => {
      // Left button only, so a right/middle click released without moving doesn't jump to Ghostty
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();
      startRect = container.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      grabOffsetX = nodeRect.left + nodeRect.width / 2 - e.clientX;
      grabOffsetY = nodeRect.top + nodeRect.height / 2 - e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      dragging = true;
      groupStart = groupRef.current.watchGroup;
      node.setPointerCapture(e.pointerId);
    };

    const posFromEvent = (e: PointerEvent): GardenPosition | null => {
      if (!startRect || startRect.width === 0 || startRect.height === 0) return null;
      const xPct = ((e.clientX + grabOffsetX - startRect.left) / startRect.width) * 100;
      const yPct = ((e.clientY + grabOffsetY - startRect.top) / startRect.height) * 100;
      return clampGardenPosition(xPct, yPct);
    };

    // Dragging a group's bird: move the block's reference position by the pointer movement (%)
    const groupFromEvent = (e: PointerEvent): WatchGroupRef | undefined => {
      if (!groupStart || !startRect || startRect.width === 0 || startRect.height === 0) return undefined;
      const dx = ((e.clientX - downX) / startRect.width) * 100;
      const dy = ((e.clientY - downY) / startRect.height) * 100;
      return {
        rootId: groupStart.rootId,
        anchor: clampGardenPosition(groupStart.anchor.x + dx, groupStart.anchor.y + dy),
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < CLICK_SLOP_PX) return;
      moved = true;
      const group = groupFromEvent(e);
      if (group) {
        groupRef.current.onGroupMove?.(group);
        return;
      }
      const next = posFromEvent(e);
      if (next) setLive(next);
    };

    const endDrag = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
      setLive(null);
      if (!moved) {
        // Not moved = click. Don't save the position
        if (e.type === "pointerup") onClickRef.current?.();
        return;
      }
      const group = groupFromEvent(e);
      if (group) {
        groupRef.current.onGroupDrop?.(group);
        return;
      }
      const next = posFromEvent(e);
      if (next) onDragEndRef.current(next);
    };

    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", endDrag);
    node.addEventListener("pointercancel", endDrag);
    return () => {
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", endDrag);
      node.removeEventListener("pointercancel", endDrag);
    };
  }, [containerRef]);

  const pos = live ?? position;
  // Keep the whole bird (glyph, "?", name, status row) inside the garden frame. The saved position (%) stays
  // as is; only the display is shifted (the clamp in style below). The node size is the actual size from the
  // previous render (re-rendered on every poll, so reading the ref is enough), or the estimate if not yet available.
  // placed is the position (px) at the current garden size, used to decide the speech bubble's direction and shift
  const containerW = containerRef.current?.clientWidth ?? 0;
  const containerH = containerRef.current?.clientHeight ?? 0;
  const nodeW = visibleWidth(nodeRef.current) || NODE_WIDTH_PX;
  // The speech bubble appears right below the icon and the node reserves that space (.garden-bubble-room), so it is
  // included in the node height
  const nodeH = nodeRef.current?.offsetHeight || glyphSize + NODE_TEXT_PX + (bubbleRoom ? BUBBLE_ROOM_PX : 0);
  const minX = nodeW / 2 + NODE_EDGE_PX;
  const minY = nodeH / 2 + NODE_EDGE_PX;
  const maxYGap = nodeH / 2 + NODE_EDGE_PX;
  // Birds in a watching group are placed at a fixed position inside the block (while dragging they follow the pointer)
  const grouped = watchPlace && !live ? watchPlace : undefined;
  // Whether the bird is inside a watching block (birds moved out of the block have a watchPlace but no bubbleRange)
  const inBlock = grouped?.bubbleRange !== undefined;
  const placed = grouped
    ? { x: grouped.x, y: grouped.y }
    : containerW > 0 && containerH > 0
      ? {
          x: clampInside((pos.x / 100) * containerW, minX, containerW - minX),
          y: clampInside((pos.y / 100) * containerH, minY, containerH - maxYGap),
        }
      : undefined;
  // The position stays a ratio (%); keeping it inside the frame is left to CSS clamp (so it follows window resizes
  // without waiting for a re-render). The bird and its speech bubble anchor use the same position
  const left = grouped?.left ?? `clamp(${minX}px, ${pos.x}%, calc(100% - ${minX}px))`;
  const top = grouped?.top ?? `clamp(${minY}px, ${pos.y}%, calc(100% - ${maxYGap}px))`;
  // For birds near the left/right edges, a speech bubble directly below the icon gets cut off by the frame, so shift
  // it inside the frame (the tail keeps pointing at the bird).
  // For birds in a watching block, keep the speech bubble inside the block (off the block's border)
  const bubbleStyle = placed
    ? grouped?.bubbleRange
      ? bubbleShift(placed.x, grouped.bubbleRange.lo, grouped.bubbleRange.hi)
      : bubbleShift(placed.x, BUBBLE_EDGE_PX, containerW - BUBBLE_EDGE_PX)
    : undefined;

  // Bird facing. About half are mirrored deterministically based on the id (all facing the same way looks stuffed).
  // Sprites are assumed to face left by default → flip = facing right
  const flip = hashId(session.id) % 2 === 1;

  // The starting point of the sky entry is randomized once at mount (it's a state initializer, so
  // it stays fixed afterwards = the path doesn't change on re-render). The horizontal direction follows the facing:
  // right-facing (flip) birds fly in from the left sky to the right, left-facing birds from the right sky to the left
  const [skyEntry] = useState(() => {
    const x = (Math.random() * 35 + 12) * (flip ? -1 : 1);
    const y = -(Math.random() * 120 + 280);
    const bank = -(Math.sign(x) * (Math.random() * 5 + 2));
    return { x, y, rotate: bank };
  });

  // Entry animation: run once with WAAPI at mount. Being a useLayoutEffect, it starts
  // before paint (prevents a flash where the bird briefly shows at its plain position before flying)
  useLayoutEffect(() => {
    if (entryOrigin === "none") return;
    const el = innerRef.current;
    if (!el) return;
    // sky: approximate an arc with 3 keyframes (a replacement for motion's per-property easing).
    // After landing (the last keyframe) it stops at transform: none, so there is no leftover motion
    // like briefly lifting up after landing
    const { x, y, rotate } = skyEntry;
    el.animate(
      [
        { transform: `translate(${x}px, ${y}px) rotate(${rotate}deg)`, opacity: 0 },
        {
          transform: `translate(${x * 0.35}px, ${y * 0.08}px) rotate(${rotate * 0.5}deg)`,
          opacity: 1,
          offset: 0.6,
        },
        { transform: "none", opacity: 1 },
      ],
      { duration: 550, easing: "cubic-bezier(0.22, 0.9, 0.35, 1)" },
    );
    // entryOrigin is fixed at its mount-time value (never changes afterwards), so running once at mount is enough
  }, []);

  // Leave animation: once exiting is set (the moment Garden moves it to leaving), run it with WAAPI,
  // and when it finishes call onExited so Garden removes it from its leaving Map
  useLayoutEffect(() => {
    if (!exiting) return;
    const el = innerRef.current;
    if (!el) return;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onExited?.(session.id);
    };
    const duration = 300;
    const anim = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing: "ease", fill: "forwards" });
    anim.onfinish = finish;
    // Safeguard: in case onfinish never fires (e.g. the element is detached from the document),
    // also call onExited after duration+200ms. Garden uses Map.delete, so a double call is idempotent
    const timeoutId = setTimeout(finish, duration + 200);
    return () => {
      clearTimeout(timeoutId);
      // For cases where this effect is cleaned up while the element survives (e.g. StrictMode double invocation
      // in dev), explicitly cancel the animation stopped with fill:"forwards".
      // Otherwise, when animate() runs again on the next mount, it starts from an element already stuck at
      // opacity:0 (prevents a recurrence of "birds are invisible only in development")
      anim.cancel();
    };
    // exiting is expected to be decided only once, when the leaving entry is created
  }, [exiting]);

  return (
    <div
      ref={nodeRef}
      data-session-id={session.id}
      className={`garden-node ${session.state}${question ? " asking" : ""}${live ? " dragging" : ""}${exiting ? " leaving" : ""}${focusable ? " focusable" : ""}${inBlock ? " in-watch-block" : ""}`}
      style={{
        left,
        top,
        // While dragging, show above the speech bubble order (the z-index of .garden-node.dragging loses to the inline style)
        zIndex: live ? BUBBLE_Z_DRAGGING : stackOrder,
      }}
    >
      {/* Positioning (left/top % + translate centering), dragging, and the hover/dragging
          transforms are handled by the plain outer div. WAAPI overwrites transform entirely, so it isn't
          applied to the same element; the inner div wrapping only the content carries the enter/leave animations */}
      <div className="garden-node-inner" ref={innerRef}>
        {/* Birds in a block show only what differs (path relative to the parent). If any bird in the row has a name,
            birds without one also reserve the row height */}
        {!inBlock ? (
          <span className="garden-name">{session.project}</span>
        ) : grouped.label !== undefined ? (
          <span className="garden-name" title={grouped.label}>
            {grouped.label}
          </span>
        ) : (
          grouped.nameRoom && <span className="garden-name" aria-hidden>{"\u00a0"}</span>
        )}
        <span className="garden-glyph" ref={glyphRef}>
          <BirdGlyph
            state={session.state}
            size={glyphSize}
            flip={flip}
            set={iconSet}
            asking={question}
            angry={isAngry(session)}
          />
        </span>
        {/* Speech bubble slot. The bubble itself is rendered in the bubble layer (to stack above other birds); this is
            only the space that pushes the status row down */}
        {bubbleRoom && <span className="garden-bubble-room" aria-hidden />}
        {/* Same component as the Perch rows. Line 1 has the state word and elapsed time; the tool name goes on the line below */}
        <span className="garden-status">
          <StatusParts session={session} asking={asking} toolOnOwnLine stacked={inBlock} />
        </span>
        {/* Watching: the number of active peers under the bird */}
        {/* Counts only peers active right now. Not shown during the grace period (0) */}
        {session.watching !== undefined && session.watching > 0 && (
          <span className="garden-watch-count" title={t("watchingPeersTitle")}>
            <MdLink size={12} aria-hidden />
            {session.watching}
          </span>
        )}
        {/* While the "?" is shown, don't show the event marker. The only needs-reply marker is the "?" at the bird's
            top right (docs/design.md "The "?" for sessions waiting on you") */}
        {!question && recentEvents.length > 0 && (
          <span className="garden-icons">
            {recentEvents.map((e) => {
              const kind = eventKind(e);
              return (
                <span
                  key={e.key}
                  className="garden-icon-wrap"
                  title={`${EVENT[kind].label} · ${formatEventTime(e.at)}`}
                >
                  <EventIcon kind={kind} size={12} />
                </span>
              );
            })}
          </span>
        )}
      </div>
      {/* The speech bubble puts an anchor at the same position and height as the bird in the bubble layer, and appears
          right below the icon's bottom edge (--bubble-top), in the space before the name (.garden-bubble-room). The
          distance from the icon is the same for every bird */}
      {bubble &&
        bubbleLayer &&
        !exiting &&
        createPortal(
          <div
            className={`garden-bubble-anchor${inBlock ? " in-watch-block" : ""}`}
            style={
              {
                left,
                top,
                height: nodeH,
                zIndex: live ? BUBBLE_Z_DRAGGING : stackOrder,
                "--bubble-top": `${glyphBottom ?? glyphSize}px`,
              } as CSSProperties
            }
          >
            <SpeechBubble text={bubble} placement="below" style={bubbleStyle} />
          </div>,
          bubbleLayer,
        )}
    </div>
  );
}
