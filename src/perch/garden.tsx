import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { t } from "@/lib/i18n";
import {
  hashId,
  loadGardenPositions,
  saveGardenPositions,
  type GardenPosition,
} from "@/lib/garden-layout";
import {
  gardenGlyphSize,
  type FitBox,
  type GardenFit,
} from "@/lib/garden-fit";
import { PLACE_EDGE_PX, placeBoxes, shiftPoints, type PlaceBox, type Point } from "@/lib/garden-place";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { resolveIconSet } from "./icon-sets";
import { gardenGrowAnchor } from "./garden-grow";
import { hasQuestion, isAngry, needsAnswer } from "@/lib/jev";
import { createPortal } from "react-dom";
import { MdLink } from "react-icons/md";
import { bubbleText, SpeechBubble } from "./bubble";
import { BirdGlyph } from "./bird-glyph";
import { StatusParts } from "./bird-status";
import { EVENT, EventIcon, eventKind } from "./event-kind";
import { formatEventTime } from "./format-time";
import {
  BUBBLE_MAX_PX,
  BUBBLE_ROOM_PX,
  birdExtraH,
  NODE_TEXT_PX,
  NODE_WIDTH_PX,
  watchBubbleRange,
  watchColumnLimit,
  watchShapes,
  type WatchShape,
} from "./garden-watch-layout";

interface GardenSize {
  w: number;
  h: number;
  viewH: number;
}

/** The garden's size, and its height without its own stretching (minHeight): the scroll area's visible height minus
    what else is in it (padding, margins) */
function measureGarden(el: HTMLElement): GardenSize {
  const { width, height } = el.getBoundingClientRect();
  const body = el.closest<HTMLElement>(".page-body");
  const viewH = body ? body.clientHeight - (body.scrollHeight - el.offsetHeight) : height;
  return { w: width, h: height, viewH: Math.max(0, viewH) };
}

// Keep speech bubbles this far inside the garden frame
const BUBBLE_EDGE_PX = 4;
// A bird's footprint is as wide as its node (.garden-node)
const FOOT_W = NODE_WIDTH_PX;

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

// Releasing after moving less than this counts as a click (jump to the Ghostty pane), not a drag
const CLICK_SLOP_PX = 4;

// Number of recent event icons shown under a node (only the latest one, so the garden doesn't get crowded)
const HISTORY_LIMIT = 1;

/** A node's position in the garden, px: x is its center, y its top edge */
type NodePos = Point;

// Snapshot of a node that is fading out (its process ended). Rendered only while it is in leaving.
// session/position freeze the values from "the last render where it was still shown"
type LeavingEntry = {
  session: SessionView;
  position: NodePos;
};

/** A bird's spot inside a watching block (absolute px in the garden) */
interface WatchPlace {
  bubbleRoom: boolean;
  label?: string;
  nameRoom: boolean;
  // Horizontal range (px) that must contain the speech bubble: inside the block
  bubbleRange: { lo: number; hi: number };
}

/** A block being dragged: its first-started bird and how far the pointer has moved (px) */
interface GroupDrag {
  rootId: string;
  dx: number;
  dy: number;
}

// What the placement keeps between renders (docs/design.md "Layout": a bird or block on screen stays where it is)
interface Kept {
  // Top-left of each bird's footprint as last shown (birds in a block included, so they stay put if the block goes)
  birds: Map<string, Point>;
  // Top-left of each block as last shown, by its first-started bird, with its members and its column limit (kept
  // while it still fits, so the block keeps its shape when the window grows)
  blocks: Map<string, { at: Point; members: string[]; limit: number }>;
  // Spots the user just dropped a bird (footprint top-left) or a block (block top-left) on, used on the next render
  drops: Map<string, Point>;
  // Birds and blocks that had no free spot and overlap others
  overlapping: Set<string>;
  // Garden size at the last placement (to keep things at the same place on screen when it resizes)
  frame?: { w: number; h: number };
}

export function Garden({
  sessions,
  events,
  hasGranted,
  iconSetAssignments = {},
  onFocus,
  canFocus,
  onFit,
}: {
  sessions: SessionView[];
  events: SessionEvent[];
  hasGranted: boolean;
  // slug → assignment map (same meaning as in Perch in perch-list.tsx; passed from App.tsx)
  iconSetAssignments?: IconSetAssignments;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  // Receives what decides whether the birds fit, for growing the floating window (garden-grow.ts). null when the
  // garden isn't measured (no birds, tab hidden)
  onFit?: (fit: GardenFit | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Saved (dragged) positions, only used for birds that aren't on screen yet (e.g. after a relaunch). null until loaded,
  // so birds aren't placed once without them and then moved
  const [positions, setPositions] = useState<Record<string, GardenPosition> | null>(null);
  const keptRef = useRef<Kept>({ birds: new Map(), blocks: new Map(), drops: new Map(), overlapping: new Set() });
  // Log lines about the placement, written by render and sent to the log after commit
  const logRef = useRef<string[]>([]);

  useEffect(() => {
    let alive = true;
    loadGardenPositions().then(
      (loaded) => {
        if (alive) setPositions(loaded);
      },
      () => {
        if (alive) setPositions({});
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Actual size of the container (.garden), and the height the garden has without its own stretching (viewH).
  // Follows window resizes via ResizeObserver
  const [containerSize, setContainerSize] = useState<GardenSize>({ w: 0, h: 0, viewH: 0 });
  const updateContainerSize = (el: HTMLElement) => {
    const next = measureGarden(el);
    setContainerSize((prev) => (prev.w === next.w && prev.h === next.h && prev.viewH === next.viewH ? prev : next));
  };

  // The garden frame (.garden) isn't drawn when there are no birds (the early return below). If the frame was missing
  // on the first render, the observer was never attached and the layout stayed at the old size even after resizing the
  // window, so re-attach it when the frame appears. Also re-measure on window resize (a safeguard in case
  // ResizeObserver misses a change)
  const hasGardenFrame = sessions.length > 0;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => updateContainerSize(el);
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

  // Safeguard in case ResizeObserver misses a change (added in the Chrome extension, where the garden was moved into
  // the PiP window's document; whether the desktop app still needs it hasn't been checked).
  // Re-measuring after every render means the re-render from the 3-second polling catches up within 3 seconds at
  // most. Skip setState if the value is unchanged (avoids an infinite loop)
  useEffect(() => {
    const el = containerRef.current;
    if (el) updateContainerSize(el);
  });

  // Birds already present when the tab is first shown should be laid out statically without the fly-in animation.
  // It stays false during the first render (= every node created in this render
  // receives entryOrigin="none") and is set to true in an effect after commit. After that, only nodes newly
  // mounted by polling get animateEntry=true
  const initializedRef = useRef(false);
  const animateEntry = initializedRef.current;

  // Nodes in their leaving animation (fading out). A replacement for
  // AnimatePresence: ids that disappear from sessions are moved here and removed via onExited when the
  // WAAPI leaving animation in GardenNode finishes
  const [leaving, setLeaving] = useState<Map<string, LeavingEntry>>(new Map());
  // Snapshot of id → {session, position} for ids that were shown in the previous render. Used when adding to
  // leaving, to freeze the look at the moment it disappeared (the state while it was still shown)
  const shownSnapshotRef = useRef<Map<string, { session: SessionView; position: NodePos }>>(new Map());

  const handleExited = useCallback((id: string) => {
    setLeaving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Previous glyphSize (to keep the previous size while computation is skipped at zero width), and the number of birds
  // it was decided for
  const glyphSizeRef = useRef<number | undefined>(undefined);
  const glyphCountRef = useRef(0);

  /** Saves a dragged position (for the next launch) and re-renders so the drop is placed */
  const saveDrop = useCallback((id: string, saved: GardenPosition, liveIds: string[]) => {
    setPositions((prev) => {
      // Positions of sessions that have disappeared are pruned on save (only existing ids are kept)
      const currentIds = new Set(liveIds);
      const pruned: Record<string, GardenPosition> = {};
      for (const [pid, ppos] of Object.entries(prev ?? {})) {
        if (currentIds.has(pid)) pruned[pid] = ppos;
      }
      pruned[id] = saved;
      void saveGardenPositions(pruned);
      return pruned;
    });
  }, []);

  // Every session whose process is alive is a node in the garden, dozing ones included (docs/design.md
  // "Garden layout"). The useLayoutEffect below must be called on every render (Rules of Hooks), so
  // compute this before the sessions.length===0 early return
  const liveIds = sessions.map((s) => s.id);
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);
  // Dragging a watching group (docs/design.md "Watching": dragging moves the whole block)
  const [groupDrag, setGroupDrag] = useState<GroupDrag | null>(null);
  // When speech bubbles overlap, stack birds whose turn ended more recently (smaller sinceMs) on top
  const bubbleOrder = new Map(
    sessions
      .filter((s) => bubbleText(s) !== undefined)
      .sort((a, b) => b.sinceMs - a.sinceMs)
      .map((s, i) => [s.id, i + 1] as const),
  );

  // Decide the glyph size from the number of birds and the container's actual size. At zero width (tab hidden),
  // skip the computation and keep the previous value (held in a ref)
  // From viewH, not h: h is stretched by the garden's minHeight, which depends on the glyph size, and feeding it back
  // made the size go back and forth on every render until React stopped with "Maximum update depth exceeded" and
  // the whole page went blank (observed)
  const W = containerSize.w;
  // The garden is exactly the room left in the window: it never grows past it and the content area never scrolls
  // (docs/design.md "Layout")
  const baseH = containerSize.viewH;
  const ready = W > 0 && containerSize.viewH > 0 && positions !== null && sessions.length > 0;
  const kept = keptRef.current;
  const limits = new Map<string, number>();
  const colLimit = (rootId: string) => {
    const fit = watchColumnLimit(W);
    const before = kept.blocks.get(rootId)?.limit;
    const limit = before !== undefined && before <= fit ? before : fit;
    limits.set(rootId, limit);
    return limit;
  };
  // Cells of a block: as they were (a block that took over another one keeps its order too); a block that forms puts
  // its birds in the order they stood (top to bottom, then left to right), so none of them crosses over another
  const cellOrder = (rootId: string, ids: string[]) => {
    const before =
      kept.blocks.get(rootId) ?? [...kept.blocks.values()].find((b) => b.members.some((m) => ids.includes(m)));
    if (before) return before.members;
    const shown = ids.filter((id) => kept.birds.has(id));
    const row = (id: string) => Math.round(kept.birds.get(id)!.y / 60);
    return shown.sort((a, b) => row(a) - row(b) || kept.birds.get(a)!.x - kept.birds.get(b)!.x);
  };
  /** Whether something on screen would have to move if the icons were g px (taller birds and blocks) */
  const wouldMove = (g: number) => {
    const trial = watchShapes(sessions, g, (root) => kept.blocks.get(root)?.limit ?? watchColumnLimit(W), cellOrder);
    const inBlock = new Set(trial.flatMap((sh) => sh.memberIds));
    const boxes: PlaceBox[] = [];
    for (const sh of trial) {
      const at = kept.blocks.get(sh.rootId)?.at;
      if (at) boxes.push({ id: sh.rootId, w: sh.width, h: sh.footH, at });
    }
    for (const s of sessions) {
      const at = kept.birds.get(s.id);
      if (at && !inBlock.has(s.id)) boxes.push({ id: s.id, w: FOOT_W, h: g + birdExtraH(s), at });
    }
    const result = placeBoxes(boxes, W, baseH);
    return (
      result.overflow.length > 0 ||
      boxes.some((b) => {
        const to = result.at.get(b.id)!;
        return Math.abs(to.x - b.at!.x) > 0.5 || Math.abs(to.y - b.at!.y) > 0.5;
      })
    );
  };
  // The icon grows only when birds left and nothing on screen would have to move for it; it never grows with the
  // window (a larger icon makes every bird taller and would push neighbours away; docs/design.md "Layout")
  if (containerSize.w > 0 && containerSize.viewH > 0) {
    const computed = gardenGlyphSize(containerSize.w, containerSize.viewH, sessions.length);
    const held = glyphSizeRef.current;
    if (held === undefined || computed < held) glyphSizeRef.current = computed;
    else if (computed > held && sessions.length < glyphCountRef.current && (!ready || !wouldMove(computed))) {
      glyphSizeRef.current = computed;
    }
    glyphCountRef.current = sessions.length;
  }
  const glyphSize = glyphSizeRef.current ?? 30;

  // Placement (docs/design.md "Layout"). A bird or block on screen stays where it is; only one that would overlap
  // another or leave the garden moves, to the nearest free spot. The garden is never taller than the window; if
  // something has no free spot, the window is asked to grow (onFit) and meanwhile that one overlaps others
  const shapes = watchShapes(sessions, glyphSize, colLimit, cellOrder);
  const shapeOf = new Map<string, WatchShape>();
  for (const shape of shapes) for (const id of shape.memberIds) shapeOf.set(id, shape);
  const birdAt = new Map<string, NodePos>();
  const blockAt = new Map<string, Point>();
  const gardenH = baseH;
  let fitBase: Omit<GardenFit, "overheadW" | "overheadH"> | null = null;
  if (ready) {
    // The window was resized: keep what is on screen at the same place on screen. The garden's corner moved by the
    // growth times the part of the window that stays put (gardenGrowAnchor; right edge kept = moved by all of it)
    const frame = kept.frame;
    if (frame && (frame.w !== W || frame.h !== baseH)) {
      const dx = -(W - frame.w) * gardenGrowAnchor.x;
      const dy = -(baseH - frame.h) * gardenGrowAnchor.y;
      shiftPoints(kept.birds, dx, dy);
      for (const block of kept.blocks.values()) block.at = { x: block.at.x - dx, y: block.at.y - dy };
      for (const [id, p] of kept.drops) kept.drops.set(id, { x: p.x - dx, y: p.y - dy });
      logRef.current.push(`[garden] resized ${frame.w}x${frame.h} -> ${W}x${baseH} shift=${-dx},${-dy}`);
    }
    kept.frame = { w: W, h: baseH };
    const savedAt = (id: string, w: number): Point | undefined => {
      const saved = positions[id];
      return saved && { x: (saved.x / 100) * W - w / 2, y: (saved.y / 100) * baseH };
    };
    const order = (map: Map<string, unknown>) => {
      const index = new Map([...map.keys()].map((k, i) => [k, i]));
      return (a: PlaceBox, b: PlaceBox) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
    };
    const keptBlocks: PlaceBox[] = [];
    const keptBirds: PlaceBox[] = [];
    const dropped: PlaceBox[] = [];
    const newBlocks: PlaceBox[] = [];
    const newBirds: PlaceBox[] = [];
    // Footprint height at another icon size (for trying other window sizes, below)
    const heightAt = new Map<string, (glyph: number) => number>();
    for (const shape of shapes) {
      const box: PlaceBox = { id: shape.rootId, w: shape.width, h: shape.footH };
      heightAt.set(box.id, (g) => shape.footH + shape.rows * (g - glyphSize));
      const drop = kept.drops.get(shape.rootId);
      // The same block as before, or a block that took over one (its first-started bird changed)
      const before =
        kept.blocks.get(shape.rootId) ??
        [...kept.blocks.values()].find((b) => b.members.some((m) => shape.memberIds.includes(m)));
      if (drop) dropped.push({ ...box, want: drop });
      else if (before) keptBlocks.push({ ...box, at: before.at });
      else {
        // A block that just formed goes where its birds were: the spot that moves them the least on average
        const spots = shape.memberIds.flatMap((id) => {
          const p = kept.birds.get(id) ?? savedAt(id, FOOT_W);
          const cell = shape.cells.get(id)!;
          return p ? [{ x: p.x + FOOT_W / 2 - cell.dx, y: p.y - cell.dy }] : [];
        });
        const want =
          spots.length > 0
            ? {
                x: spots.reduce((sum, p) => sum + p.x, 0) / spots.length,
                y: spots.reduce((sum, p) => sum + p.y, 0) / spots.length,
              }
            : { x: PLACE_EDGE_PX, y: PLACE_EDGE_PX };
        newBlocks.push({ ...box, want });
      }
    }
    for (const s of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
      if (shapeOf.has(s.id)) continue;
      const box: PlaceBox = { id: s.id, w: FOOT_W, h: glyphSize + birdExtraH(s) };
      heightAt.set(box.id, (g) => g + birdExtraH(s));
      const drop = kept.drops.get(s.id);
      const at = kept.birds.get(s.id);
      const saved = savedAt(s.id, FOOT_W);
      if (drop) dropped.push({ ...box, want: drop });
      else if (at) keptBirds.push({ ...box, at });
      else if (saved) newBirds.push({ ...box, want: saved });
      else newBirds.push({ ...box, seed: hashId(s.id) });
    }
    keptBlocks.sort(order(kept.blocks));
    keptBirds.sort(order(kept.birds));
    // What already overlaps others (it had no spot) comes last, so it never pushes away a bird that has its own spot
    const overlapping = (b: PlaceBox) => kept.overlapping.has(b.id);
    const boxes = [
      ...keptBlocks.filter((b) => !overlapping(b)),
      ...keptBirds.filter((b) => !overlapping(b)),
      ...dropped,
      ...newBlocks,
      ...newBirds,
      ...keptBlocks.filter(overlapping),
      ...keptBirds.filter(overlapping),
    ];
    // Something with no free spot overlaps others (placeBoxes) and the window is asked to grow (onFit). The garden
    // itself never grows past the window
    const placement = placeBoxes(boxes, W, gardenH);
    const overflowAtBase = placement.overflow;
    // For trying other sizes (simulate below): what has a spot keeps it; what overlaps looks for the nearest free spot
    // from where it is, the same way it does on the next placement
    const settled = boxes.map((b): PlaceBox => {
      const at = placement.at.get(b.id);
      return overflowAtBase.includes(b.id) ? { id: b.id, w: b.w, h: b.h, want: at } : { id: b.id, w: b.w, h: b.h, at };
    });
    for (const box of boxes) {
      const to = placement.at.get(box.id)!;
      if (box.at && (Math.abs(to.x - box.at.x) > 0.5 || Math.abs(to.y - box.at.y) > 0.5)) {
        logRef.current.push(
          `[garden] moved ${box.id} ${Math.round(box.at.x)},${Math.round(box.at.y)} -> ${Math.round(to.x)},${Math.round(to.y)}`,
        );
      }
    }
    if (overflowAtBase.length > 0) logRef.current.push(`[garden] no free spot at ${W}x${baseH}: ${overflowAtBase.join(" ")}`);
    // Keep what is shown now for the next render. Birds in a block are kept at their spot in it, so they stay put
    // if the block goes
    const birds = new Map<string, Point>();
    const blocks = new Map<string, { at: Point; members: string[]; limit: number }>();
    for (const box of boxes) {
      const at = placement.at.get(box.id)!;
      const shape = shapes.find((sh) => sh.rootId === box.id);
      // Kept even when it had no free spot and overlaps others (it is placed last; kept.overlapping), so it doesn't
      // jump to another overlapping spot on the next change
      if (!shape) {
        birds.set(box.id, at);
        birdAt.set(box.id, { x: at.x + FOOT_W / 2, y: at.y });
        continue;
      }
      blocks.set(shape.rootId, { at, members: shape.memberIds, limit: limits.get(shape.rootId) ?? 1 });
      blockAt.set(shape.rootId, at);
      for (const id of shape.memberIds) {
        const cell = shape.cells.get(id)!;
        birds.set(id, { x: at.x + cell.dx - FOOT_W / 2, y: at.y + cell.dy });
        birdAt.set(id, { x: at.x + cell.dx, y: at.y + cell.dy });
      }
    }
    kept.birds = birds;
    kept.blocks = blocks;
    kept.overlapping = new Set(overflowAtBase);
    kept.drops.clear();
    const fitBoxes: FitBox[] = [
      ...shapes.map((sh) => ({ w: sh.width, h0: sh.footH - sh.rows * glyphSize, rows: sh.rows })),
      ...sessions.filter((s) => !shapeOf.has(s.id)).map((s) => ({ w: FOOT_W, h0: birdExtraH(s), rows: 1 })),
    ];
    const over = overflowAtBase.map((id) => boxes.find((b) => b.id === id)!);
    // The same placement at another garden size, as if the window were resized to it: what is on screen shifted to
    // stay at the same place on screen (gardenGrowAnchor), what had no spot placed again. For growing only as far as
    // needed and shrinking back only as far as nothing moves (garden-grow.ts)
    const anchor = { ...gardenGrowAnchor };
    const count = sessions.length;
    const simulate = (gw: number, gh: number) => {
      const h = gh;
      const glyph = Math.min(glyphSize, gardenGlyphSize(gw, gh, count));
      const dx = (gw - W) * anchor.x;
      const dy = (h - baseH) * anchor.y;
      const tried = settled.map((b): PlaceBox => {
        const bh = heightAt.get(b.id)?.(glyph) ?? b.h;
        const move = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
        if (b.at) return { id: b.id, w: b.w, h: bh, at: move(b.at) };
        return { id: b.id, w: b.w, h: bh, want: b.want && move(b.want) };
      });
      const result = placeBoxes(tried, gw, h);
      let moved = 0;
      for (const b of tried) {
        const to = result.at.get(b.id)!;
        // What overlapped for want of a spot is expected to move to the new room
        if (overflowAtBase.includes(b.id)) continue;
        if (b.at && (Math.abs(to.x - b.at.x) > 0.5 || Math.abs(to.y - b.at.y) > 0.5)) moved++;
      }
      return { overflow: result.overflow.length, moved };
    };
    fitBase = {
      simulate,
      count: sessions.length,
      boxes: fitBoxes,
      overflow: over.length > 0,
      overflowW: Math.max(0, ...over.map((b) => b.w)),
      overflowH: Math.max(0, ...over.map((b) => b.h)),
      gardenW: W,
      gardenH: containerSize.viewH,
    };
  }

  // The block being dragged follows the pointer (kept inside the garden)
  const shownBlockAt = (shape: WatchShape): Point | undefined => {
    const at = blockAt.get(shape.rootId);
    if (!at || !groupDrag || groupDrag.rootId !== shape.rootId) return at;
    return {
      x: Math.max(PLACE_EDGE_PX, Math.min(W - PLACE_EDGE_PX - shape.width, at.x + groupDrag.dx)),
      y: Math.max(PLACE_EDGE_PX, Math.min(gardenH - PLACE_EDGE_PX - shape.footH, at.y + groupDrag.dy)),
    };
  };
  const positionOf = (id: string): NodePos | undefined => {
    const shape = shapeOf.get(id);
    if (!shape) return birdAt.get(id);
    const at = shownBlockAt(shape);
    const cell = shape.cells.get(id)!;
    return at && { x: at.x + cell.dx, y: at.y + cell.dy };
  };

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

    const newSnapshot = new Map<string, { session: SessionView; position: NodePos }>();
    for (const s of sessions) {
      const position = positionOf(s.id);
      if (position) newSnapshot.set(s.id, { session: s, position });
    }
    shownSnapshotRef.current = newSnapshot;
  });

  // Birds are drawn from the first render that places them (ready); only birds that come after that fly in
  useEffect(() => {
    if (ready) initializedRef.current = true;
  });

  // What decides whether the birds fit, set during render above. The effect adds the window overhead measured
  // after commit and sends it to onFit only when it changed. Also sends the placement's log lines
  const fitRef = useRef<Omit<GardenFit, "overheadW" | "overheadH"> | null>(null);
  fitRef.current = fitBase;
  const sentFitRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const lines = logRef.current.splice(0);
    for (const line of lines) void invoke("log", { line }).catch(() => {});
    const el = containerRef.current;
    const body = el?.closest<HTMLElement>(".page-body");
    const base = fitRef.current;
    let fit: GardenFit | null = null;
    if (el && body && base && el.offsetWidth > 0) {
      // Everything in .page-body other than the garden (tab panel padding, the garden's margin) counts as overhead,
      // so the garden's own stretched height doesn't
      const others = body.scrollHeight - el.offsetHeight;
      // The garden must never reach past the window (docs/design.md "Layout"); log it if it ever does
      const past = body.scrollHeight - body.clientHeight;
      if (past > 1 && !body.querySelector(":scope > .mock-panel")) {
        void invoke("log", { line: `[garden] content ${past}px past the window bottom` }).catch(() => {});
      }
      fit = {
        ...base,
        overheadW: Math.round(window.innerWidth - el.offsetWidth),
        overheadH: Math.round(window.innerHeight - body.clientHeight + others),
      };
    }
    const key = JSON.stringify(fit);
    if (sentFitRef.current === key) return;
    sentFitRef.current = key;
    onFit?.(fit);
  });

  if (sessions.length === 0) {
    return (
      <div className="empty">
        {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
      </div>
    );
  }

  const toSaved = (p: NodePos): GardenPosition => ({ x: (p.x / W) * 100, y: (p.y / baseH) * 100 });
  return (
    <div className="garden" ref={containerRef}>
      {/* Speech bubble layer. Placed above the bird/name layer so no bird's name hides bubble text (or the "…").
          Among bubbles, newer turns are on top (bubbleOrder) */}
      <div className="garden-bubble-layer" ref={setBubbleLayer} />
      {/* Rounded block enclosing a watching group. Laid under the bird layer (docs/design.md "Watching") */}
      {shapes.map((shape) => {
        const at = shownBlockAt(shape);
        return (
          at && (
            <div
              key={shape.rootId}
              className="garden-watch-block"
              style={{ left: at.x, top: at.y, width: shape.width, height: shape.height }}
            />
          )
        );
      })}
      {sessions.map((s) => {
        const position = positionOf(s.id);
        if (!position) return null;
        const shape = shapeOf.get(s.id);
        const blockLeft = shape && shownBlockAt(shape)?.x;
        const cell = shape?.cells.get(s.id);
        const range = shape && watchBubbleRange(shape);
        const watchPlace: WatchPlace | undefined =
          cell && range && blockLeft !== undefined
            ? {
                bubbleRoom: cell.bubbleRoom,
                label: cell.label,
                nameRoom: cell.nameRoom,
                bubbleRange: { lo: blockLeft + range.lo, hi: blockLeft + range.hi },
              }
            : undefined;
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
            gardenH={gardenH}
            recentEvents={recent}
            containerRef={containerRef}
            entryOrigin={entryOrigin}
            glyphSize={glyphSize}
            iconSet={resolveIconSet(iconSetAssignments, s.slug)}
            onDragEnd={(next) => {
              kept.drops.set(s.id, { x: next.x - FOOT_W / 2, y: next.y });
              saveDrop(s.id, toSaved(next), liveIds);
            }}
            stackOrder={stackOrder}
            bubbleLayer={bubbleLayer}
            watchPlace={watchPlace}
            groupRootId={shape?.rootId}
            onGroupMove={setGroupDrag}
            onGroupDrop={(drag) => {
              const dropShape = shapes.find((sh) => sh.rootId === drag.rootId);
              const from = blockAt.get(drag.rootId);
              setGroupDrag(null);
              if (!dropShape || !from) return;
              const to = { x: from.x + drag.dx, y: from.y + drag.dy };
              kept.drops.set(drag.rootId, to);
              // Saved as the first-started bird's own position, where a block that forms again is put
              const cell = dropShape.cells.get(drag.rootId)!;
              saveDrop(drag.rootId, toSaved({ x: to.x + cell.dx, y: to.y + cell.dy }), liveIds);
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
          gardenH={gardenH}
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
  gardenH,
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
  groupRootId,
  onGroupMove,
  onGroupDrop,
}: {
  session: SessionView;
  // px: the bird's center and top edge
  position: NodePos;
  // Height the birds are placed in (px; the garden may be stretched taller than the window)
  gardenH: number;
  recentEvents: SessionEvent[];
  containerRef: RefObject<HTMLDivElement | null>;
  entryOrigin: "none" | "sky";
  glyphSize: number;
  iconSet: IconSetId;
  onDragEnd: (next: NodePos) => void;
  exiting?: boolean;
  onExited?: (id: string) => void;
  focusable?: boolean;
  onClick?: () => void;
  // Stacking order of the speech bubble (higher is on top). undefined for birds without a bubble
  stackOrder?: number;
  // Where the speech bubble is rendered (Garden's .garden-bubble-layer)
  bubbleLayer?: HTMLElement | null;
  // The bird's spot within a watching block. Present only for birds in a block
  watchPlace?: WatchPlace;
  // A bird in a block drags the whole block (moves the block, not its own position)
  groupRootId?: string;
  onGroupMove?: (drag: GroupDrag) => void;
  onGroupDrop?: (drag: GroupDrag) => void;
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
  // with the garden size (transition in styles/garden.css), so track size changes instead of reading once at render
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
  const [live, setLive] = useState<NodePos | null>(null);

  // onDragEnd is a closure Garden creates anew on every render (including setSessions from the 3-second polling).
  // Putting it directly in the effect's dependency array would clean up and re-set up the effect below on every
  // poll, and during a drag dragging/startRect/grabOffset would be silently reset and the drag would break (a real
  // bug). Read the latest value through a ref and attach the effect itself only once on mount
  const onDragEndRef = useRef(onDragEnd);
  const onClickRef = useRef(onClick);
  const groupRef = useRef({ groupRootId, onGroupMove, onGroupDrop, gardenH });
  useEffect(() => {
    onDragEndRef.current = onDragEnd;
    onClickRef.current = onClick;
    groupRef.current = { groupRootId, onGroupMove, onGroupDrop, gardenH };
  });

  // Dragging needs continuous tracking beyond the node via setPointerCapture (keeps receiving pointermove/pointerup
  // even outside the node), so always attach with native addEventListener rather than React's synthetic
  // events
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    let startRect: DOMRect | null = null;
    let dragging = false;
    // The node is positioned by its center and top edge. Without keeping the offset between the grab point and that
    // spot, the node snaps to the cursor and jumps the moment a drag starts
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    // Pointer-down position, to tell a drag (moved) from a click (not moved)
    let downX = 0;
    let downY = 0;
    let moved = false;
    // The block the grabbed bird is in, if any
    let groupRoot: string | undefined;

    const onPointerDown = (e: PointerEvent) => {
      // Left button only, so a right/middle click released without moving doesn't jump to Ghostty
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();
      startRect = container.getBoundingClientRect();
      grabOffsetX = node.offsetLeft - (e.clientX - startRect.left);
      grabOffsetY = node.offsetTop - (e.clientY - startRect.top);
      downX = e.clientX;
      downY = e.clientY;
      moved = false;
      dragging = true;
      groupRoot = groupRef.current.groupRootId;
      node.setPointerCapture(e.pointerId);
    };

    const posFromEvent = (e: PointerEvent): NodePos | null => {
      if (!startRect || startRect.width === 0 || startRect.height === 0) return null;
      const half = node.offsetWidth / 2;
      const x = e.clientX - startRect.left + grabOffsetX;
      const y = e.clientY - startRect.top + grabOffsetY;
      const maxY = groupRef.current.gardenH - PLACE_EDGE_PX - node.offsetHeight;
      return {
        x: Math.max(half + PLACE_EDGE_PX, Math.min(startRect.width - half - PLACE_EDGE_PX, x)),
        y: Math.max(PLACE_EDGE_PX, Math.min(maxY, y)),
      };
    };

    // Dragging a group's bird: move the block by the pointer movement (px)
    const groupFromEvent = (e: PointerEvent): GroupDrag | undefined =>
      groupRoot === undefined ? undefined : { rootId: groupRoot, dx: e.clientX - downX, dy: e.clientY - downY };

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
  const containerW = containerRef.current?.clientWidth ?? 0;
  // The speech bubble appears right below the icon and the node reserves that space (.garden-bubble-room), so it is
  // included in the node height
  const nodeH = nodeRef.current?.offsetHeight || glyphSize + NODE_TEXT_PX + (bubbleRoom ? BUBBLE_ROOM_PX : 0);
  // Birds in a watching group are placed at their cell inside the block (they don't follow the pointer alone)
  const grouped = watchPlace;
  // Whether the bird is inside a watching block
  const inBlock = grouped !== undefined;
  const left = `${pos.x}px`;
  const top = `${pos.y}px`;
  // For birds near the left/right edges, a speech bubble directly below the icon gets cut off by the frame, so shift
  // it inside the frame (the tail keeps pointing at the bird).
  // For birds in a watching block, keep the speech bubble inside the block (off the block's border)
  const bubbleStyle = grouped
    ? bubbleShift(pos.x, grouped.bubbleRange.lo, grouped.bubbleRange.hi)
    : containerW > 0
      ? bubbleShift(pos.x, BUBBLE_EDGE_PX, containerW - BUBBLE_EDGE_PX)
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
      {/* Positioning (left/top px + horizontal translate centering), dragging, and the hover/dragging
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
