import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "@/lib/i18n";
import {
  frontRanks,
  hashId,
  loadGardenPositions,
  positionsAfterDrop,
  saveGardenPositions,
  type GardenPosition,
} from "@/lib/garden-layout";
import {
  gardenGlyphSize,
  gardenSimulate,
  nextUnsettled,
  withBubbleUp,
  type BubbleGrowRoom,
  type FitBox,
  type GardenFit,
  type PlacedGarden,
} from "@/lib/garden-fit";
import { PLACE_EDGE_PX, placeBoxes, shiftPoints, type PlaceBox, type Point } from "@/lib/garden-place";
import type { SessionView } from "@/lib/sessions";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { resolveIconSet } from "./icon-sets";
import { dragGrowAt, dragGrowEnd, gardenGrowAnchor } from "./garden-grow";
import { arrangeKept, arrangeSettled, newKept, type Kept } from "./garden-arrange";
import { GARDEN_ARRANGE_EVENT, popupGardenMenu } from "./garden-menu";
import { gardenStack } from "./garden-stack";
import { onFadeHandlePointerDown } from "./garden-fade";
import { currentWindowMode } from "./window-mode";
import { hasQuestion, isAngry, needsAnswer } from "@/lib/turn-verdict";
import { createPortal } from "react-dom";
import { MdLink } from "react-icons/md";
import { bubbleText, SpeechBubble } from "./bubble";
import { BirdGlyph } from "./bird-glyph";
import { StatusParts } from "./bird-status";
import { CONCIERGE_ID, ConciergeGlyph } from "./concierge";
import type { ConciergeAdvice, ConciergeLook } from "@/lib/concierge";
import { aboveTail, bubbleReach, bubbleReachUp, bubbleRoomFor, layoutBubbles, type BubblePlace, type LaidBird } from "./garden-bubbles";
import {
  BUBBLE_ROOM_PX,
  birdExtraH,
  NODE_TEXT_PX,
  NODE_WIDTH_PX,
  watchLinePath,
  watchShapes,
  type GridCell,
  type WatchShape,
} from "./garden-watch-layout";

interface GardenSize {
  w: number;
  h: number;
  viewH: number;
}

/** Room the mock controls (?mock=1) take below the tab panels, margin included. Left out of the garden's room and the
    window's overhead, so the birds are placed (and the window grows) as without them; the controls are scrolled to */
function mockPanelRoom(body: HTMLElement): number {
  const panel = body.querySelector<HTMLElement>(":scope > .mock-panel");
  return panel ? panel.offsetHeight + parseFloat(getComputedStyle(panel).marginTop) : 0;
}

/** Height of what is in the scroll area besides the garden (padding, margins), the mock controls left out */
const othersInBody = (body: HTMLElement, el: HTMLElement) => body.scrollHeight - el.offsetHeight - mockPanelRoom(body);

/** The garden's size, and its height without its own stretching (minHeight): the scroll area's visible height minus
    what else is in it (padding, margins) */
function measureGarden(el: HTMLElement): GardenSize {
  const { width, height } = el.getBoundingClientRect();
  const body = el.closest<HTMLElement>(".page-body");
  const viewH = body ? body.clientHeight - othersInBody(body, el) : height;
  return { w: width, h: height, viewH: Math.max(0, viewH) };
}

// Keep speech bubbles this far inside the garden frame
const BUBBLE_EDGE_PX = 4;
// A bird's footprint is a bird's width (.garden-node). Its bubble may be wider and is drawn over the neighbours
// (docs/design.md "Layout")
const FOOT_W = NODE_WIDTH_PX;

type BubbleRange = { lo: number; hi: number };

/** Where the speech bubbles stay: inside the garden frame. undefined until the frame is measured */
function bubbleRangeOf(garden: HTMLElement | null): BubbleRange | undefined {
  const w = garden?.clientWidth ?? 0;
  return w > 0 ? { lo: BUBBLE_EDGE_PX, hi: w - BUBBLE_EDGE_PX } : undefined;
}

/** The speech bubble's room around the bird at x (px): it stays within range (inside the garden frame), centered under
    the bird when it fits (.speech-bubble-below in styles/speech-bubble.css) */
function bubbleVars(x: number, range: BubbleRange, max?: number, shift?: number): CSSProperties {
  return {
    "--bubble-lo": `${x - range.lo}px`,
    "--bubble-hi": `${range.hi - x}px`,
    ...(max !== undefined && { "--bubble-max": `${max}px` }),
    ...(shift !== undefined && { "--bubble-shift": `${shift}px` }),
  } as CSSProperties;
}

// Usual height of a bird's name row (.garden-name: 11px text + 3px margin), until the icon's position is measured
const WATCH_NAME_ROW_PX = 16;
// Watch lines are kept short and away from the icons, so they are seen only on a closer look (docs/design.md
// "Watching"): room between a line's end and the icon's edge, and the longest a line gets (px)
const WATCH_LINE_GAP_PX = 18;
const WATCH_LINE_MAX_PX = 36;

// Releasing after moving less than this counts as a click (jump to the terminal pane), not a drag
const CLICK_SLOP_PX = 4;

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
}

/** A block being dragged: its first-started bird and how far the pointer has moved (px) */
interface GroupDrag {
  rootId: string;
  dx: number;
  dy: number;
}

/** The right-click menu's "Concierge only" (gardenMenuModel in concierge-only.ts) */
export interface GardenMenu {
  conciergeAvailable: boolean;
  conciergeOnly: boolean;
  toggleConciergeOnly: () => void;
}

export function Garden({
  sessions: sessionViews,
  concierge,
  hasGranted,
  iconSetAssignments = {},
  onFocus,
  canFocus,
  onFit,
  growRoom,
  paused = false,
  menu,
}: {
  sessions: SessionView[];
  // The concierge bird (docs/design.md "Concierge"): absent when it isn't shown, advice null when it has none
  concierge?: { advice: ConciergeAdvice | null; look: ConciergeLook };
  hasGranted: boolean;
  // slug → assignment map (same meaning as in Perch in perch-list.tsx; passed from App.tsx)
  iconSetAssignments?: IconSetAssignments;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  // Receives what decides whether the birds fit, for growing the floating window (garden-grow.ts). null when the
  // garden isn't measured (no birds, tab hidden)
  onFit?: (fit: GardenFit | null) => void;
  // How far down (h) and above its top (up) the garden can reach by growing the window (bubbleGrowRoom in
  // lib/garden-fit.ts, from useGardenGrow): bubbles past the garden's edges stay as far as that. undefined when the
  // window doesn't grow
  growRoom?: BubbleGrowRoom;
  // Hidden by "Concierge only" (concierge-only.ts): everything stays as it was, and nothing is measured or saved, so the
  // birds come back at the same place on screen once the window is back at its frame
  paused?: boolean;
  // What the right-click menu shows besides Arrange (garden-menu.ts)
  menu: GardenMenu;
}) {
  // The concierge is placed, dragged, and counted for growing and shrinking like a session bird, so it joins the
  // sessions as one more node. Its advice is its speech bubble (a stopped bird's summary). Only beside other birds
  const conciergeAdvice = concierge?.advice;
  const sessions: SessionView[] =
    concierge && sessionViews.length > 0
      ? [
          ...sessionViews,
          {
            id: CONCIERGE_ID,
            project: t("conciergeName"),
            slug: CONCIERGE_ID,
            state: "done",
            // Its bubble is stacked above the session birds' bubbles (bubbleOrder)
            sinceMs: -1,
            summary: conciergeAdvice?.line,
          },
        ]
      : sessionViews;
  const conciergeTarget = conciergeAdvice?.targetId;
  // The look it had while shown, for its fade-out after it is hidden (the key was deleted)
  const conciergeLookRef = useRef<ConciergeLook | undefined>(undefined);
  if (concierge) conciergeLookRef.current = concierge.look;
  const containerRef = useRef<HTMLDivElement>(null);
  // Saved (dragged) positions, only used for birds that aren't on screen yet (e.g. after a relaunch). null until loaded,
  // so birds aren't placed once without them and then moved
  const [positions, setPositions] = useState<Record<string, GardenPosition> | null>(null);
  const keptRef = useRef<Kept>(newKept());
  // Log lines about the placement, written by render and sent to the log after commit
  const logRef = useRef<string[]>([]);
  // Last "no free spot" line logged. While the same birds overlap at the same size it isn't logged again (every poll
  // re-rendered and logged the same line, hundreds of lines for one overlap; observed)
  const overflowLogRef = useRef<string | undefined>(undefined);

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
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const updateContainerSize = (el: HTMLElement) => {
    // Hidden: it measures 0, and the birds would be shifted and placed again for it
    if (pausedRef.current) return;
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

  // A drop is placed on the next render (kept.drops); this re-renders for it
  const [, setDropCount] = useState(0);
  const placeDrop = useCallback(() => {
    // A drop ends an Arrange that was waiting for the window to grow: it is saved with the drop instead
    keptRef.current.arranging = false;
    setDropCount((n) => n + 1);
  }, []);
  // Arrange (the right-click menu): forget every saved spot, the user's marks and where everything is, and lay the birds
  // out again on the next render as on a launch with no saved positions (docs/design.md "Layout"). The icon size is
  // worked out again as on a launch too
  const arrange = useCallback(() => {
    // Not while hidden by "Concierge only" (the menu disables it then; the mock's button too)
    if (pausedRef.current) return;
    arrangeKept(keptRef.current);
    glyphSizeRef.current = undefined;
    setGroupDrag(null);
    logRef.current.push("[garden] arrange");
    void saveGardenPositions({});
    setPositions({});
  }, []);
  useEffect(() => {
    window.addEventListener(GARDEN_ARRANGE_EVENT, arrange);
    return () => window.removeEventListener(GARDEN_ARRANGE_EVENT, arrange);
  }, [arrange]);
  // Where every bird settled in the render that placed a drop, saved after commit (for the next launch)
  const dropSaveRef = useRef<{
    settled: Map<string, Point>;
    byUser: Set<string>;
    front: Set<string>;
    w: number;
    h: number;
  } | null>(null);

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
  // Grid cells of a block as they were (a block that took over another one keeps them too), so its birds stay in their
  // cells when another joins
  const keptGrid = (rootId: string, ids: string[]) =>
    (kept.blocks.get(rootId) ?? [...kept.blocks.values()].find((b) => b.members.some((m) => ids.includes(m))))?.grid;
  /** Whether something on screen would have to move if the icons were g px (taller birds and blocks) */
  const wouldMove = (g: number) => {
    const trial = watchShapes(sessions, g, keptGrid);
    const inBlock = new Set(trial.flatMap((sh) => sh.memberIds));
    const boxes: PlaceBox[] = [];
    for (const sh of trial) {
      const at = kept.blocks.get(sh.rootId)?.at;
      if (at) boxes.push({ id: sh.rootId, w: sh.width, h: sh.footH, at, byUser: kept.byUser.has(sh.rootId) });
    }
    for (const s of sessions) {
      const at = kept.birds.get(s.id);
      if (at && !inBlock.has(s.id)) {
        boxes.push({ id: s.id, w: FOOT_W, h: g + birdExtraH(s), at, byUser: kept.byUser.has(s.id) });
      }
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
  const shapes = watchShapes(sessions, glyphSize, keptGrid);
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
    // The garden changed size since the unsettled ones were placed (the window grew for them): place them again
    const unsettledAt = kept.unsettledAt;
    const replaceAll = unsettledAt !== undefined && (unsettledAt.w !== W || unsettledAt.h !== baseH);
    const replace = (id: string) => replaceAll && kept.unsettled.has(id);
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
    // Birds with no place yet, before this placement (they appear now, or are placed again)
    const appearing = new Set(sessions.filter((s) => !kept.birds.has(s.id) || replace(s.id)).map((s) => s.id));
    // A block that just formed goes where its birds were: the spot that moves them the least on average. Where a bird
    // that isn't settled was is not counted (it has no place on screen yet)
    const blockWant = (shape: WatchShape, unknown: (id: string) => boolean): Point => {
      const spots = shape.memberIds.flatMap((id) => {
        const p = (unknown(id) ? undefined : kept.birds.get(id)) ?? savedAt(id, FOOT_W);
        const cell = shape.cells.get(id)!;
        return p ? [{ x: p.x + FOOT_W / 2 - cell.dx, y: p.y - cell.dy }] : [];
      });
      return spots.length > 0
        ? {
            x: spots.reduce((sum, p) => sum + p.x, 0) / spots.length,
            y: spots.reduce((sum, p) => sum + p.y, 0) / spots.length,
          }
        : { x: PLACE_EDGE_PX, y: PLACE_EDGE_PX };
    };
    for (const shape of shapes) {
      const box: PlaceBox = { id: shape.rootId, w: shape.width, h: shape.footH };
      heightAt.set(box.id, (g) => shape.footH + shape.rows * (g - glyphSize));
      const drop = kept.drops.get(shape.rootId);
      // The same block as before, or a block that took over one (its first-started bird changed)
      const before =
        kept.blocks.get(shape.rootId) ??
        [...kept.blocks.values()].find((b) => b.members.some((m) => shape.memberIds.includes(m)));
      // The block's corner moves when the grid grows left or up; it is kept so a bird that was already there stays put
      const stay = before && shape.memberIds.find((id) => kept.birds.has(id) && before.members.includes(id));
      const stayAt = stay && kept.birds.get(stay)!;
      const at = stayAt
        ? { x: stayAt.x + FOOT_W / 2 - shape.cells.get(stay)!.dx, y: stayAt.y - shape.cells.get(stay)!.dy }
        : before?.at;
      // Placed by the user: this block was dropped there (by whichever bird was its first-started one then), or it
      // appears with every bird at the spot saved for being dropped there
      const beforeByUser = [...kept.blocks].some(([root, b]) => b === before && kept.byUser.has(root));
      const savedByUser = shape.memberIds.every((id) => appearing.has(id) && positions[id]?.byUser);
      // A block the user drops stays where it is dropped, over others too (docs/design.md "Layout")
      if (drop) dropped.push({ ...box, want: drop, byUser: true });
      else if (before && at && !replace(shape.rootId)) keptBlocks.push({ ...box, at, byUser: beforeByUser });
      else newBlocks.push({ ...box, want: blockWant(shape, (id) => appearing.has(id)), byUser: savedByUser });
    }
    for (const s of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
      if (shapeOf.has(s.id)) continue;
      const box: PlaceBox = { id: s.id, w: FOOT_W, h: glyphSize + birdExtraH(s) };
      heightAt.set(box.id, (g) => g + birdExtraH(s));
      const drop = kept.drops.get(s.id);
      const at = kept.birds.get(s.id);
      const saved = savedAt(s.id, FOOT_W);
      // A bird the user drops stays where it is dropped, over others too, and opens there again (docs/design.md "Layout")
      if (drop) dropped.push({ ...box, want: drop, byUser: true });
      else if (at && !replace(s.id)) keptBirds.push({ ...box, at, byUser: kept.byUser.has(s.id) });
      else if (saved) newBirds.push({ ...box, want: saved, byUser: positions[s.id]?.byUser });
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
      // What appears at a spot the user placed it on comes after the rest that appears, so the birds it was dropped
      // over open where they were too (they don't look for a spot around it)
      ...newBlocks.filter((b) => !b.byUser),
      ...newBirds.filter((b) => !b.byUser),
      ...newBlocks.filter((b) => b.byUser),
      ...newBirds.filter((b) => b.byUser),
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
      return overflowAtBase.includes(b.id)
        ? { id: b.id, w: b.w, h: b.h, want: at }
        : { id: b.id, w: b.w, h: b.h, at, byUser: b.byUser };
    });
    for (const box of boxes) {
      const to = placement.at.get(box.id)!;
      if (box.at && (Math.abs(to.x - box.at.x) > 0.5 || Math.abs(to.y - box.at.y) > 0.5)) {
        logRef.current.push(
          `[garden] moved ${box.id} ${Math.round(box.at.x)},${Math.round(box.at.y)} -> ${Math.round(to.x)},${Math.round(to.y)}`,
        );
      }
    }
    const overflowLine =
      overflowAtBase.length > 0 ? `[garden] no free spot at ${W}x${baseH}: ${overflowAtBase.join(" ")}` : undefined;
    if (overflowLine && overflowLine !== overflowLogRef.current) logRef.current.push(overflowLine);
    overflowLogRef.current = overflowLine;
    // Keep what is shown now for the next render. Birds in a block are kept at their spot in it, so they stay put
    // if the block goes
    const birds = new Map<string, Point>();
    const blocks = new Map<string, { at: Point; members: string[]; grid: Map<string, GridCell> }>();
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
      blocks.set(shape.rootId, { at, members: shape.memberIds, grid: shape.grid });
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
    kept.byUser = new Set(boxes.filter((b) => b.byUser).map((b) => b.id));
    // Saved after commit: every bird where it settled, so the next launch opens as it is right after the drop. Birds
    // the user placed (alone or in a block they dropped) are marked so they open there over others too
    if (dropped.length > 0) {
      const byUser = new Set(
        [...kept.byUser].flatMap((id) => shapes.find((sh) => sh.rootId === id)?.memberIds ?? [id]),
      );
      // The birds dropped now come in front of the others (docs/design.md "Layout")
      const front = new Set(dropped.flatMap((b) => shapes.find((sh) => sh.rootId === b.id)?.memberIds ?? [b.id]));
      dropSaveRef.current = { settled: new Map(birdAt), byUser, front, w: W, h: baseH };
      kept.dropCount++;
    }
    kept.drops.clear();
    // An Arrange whose birds all have a spot now (the window grew for them if it had to) is saved like a drop, with no
    // bird marked as placed by the user and no front order, and the window shrinks once (docs/design.md "Layout")
    if (arrangeSettled(kept, overflowAtBase.length)) {
      dropSaveRef.current = { settled: new Map(birdAt), byUser: new Set(), front: new Set(), w: W, h: baseH };
    }
    // Something had no spot, so the window is asked to grow: what was first placed now (and what still isn't settled
    // at this size) isn't on screen yet, and is placed again once the size changes. Everything has a spot: all settled
    if (overflowAtBase.length > 0) {
      // A bird or block the user dropped has its place
      kept.unsettled = nextUnsettled(
        kept.unsettled,
        liveIds,
        [...newBlocks.map((b) => b.id), ...appearing],
        new Set(dropped.map((b) => b.id)),
        replaceAll,
      );
      kept.unsettledAt = { w: W, h: baseH };
    } else {
      kept.unsettled = new Set();
      kept.unsettledAt = undefined;
    }
    // For trying other sizes: what isn't settled is tried as it would be placed again, like one that just appeared
    const fresh = kept.unsettled;
    const asNew = (b: PlaceBox): PlaceBox => {
      const shape = shapes.find((sh) => sh.rootId === b.id);
      if (shape) return { id: b.id, w: b.w, h: b.h, want: blockWant(shape, (id) => fresh.has(id)) };
      const saved = savedAt(b.id, FOOT_W);
      return saved ? { id: b.id, w: b.w, h: b.h, want: saved } : { id: b.id, w: b.w, h: b.h, seed: hashId(b.id) };
    };
    const isBlock = (b: PlaceBox) => shapes.some((sh) => sh.rootId === b.id);
    const tried = [
      ...settled.filter((b) => !fresh.has(b.id)),
      ...boxes.filter((b) => fresh.has(b.id) && isBlock(b)).map(asNew),
      ...boxes
        .filter((b) => fresh.has(b.id) && !isBlock(b))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(asNew),
    ];
    const fitBoxes: FitBox[] = [
      ...shapes.map((sh) => ({ w: sh.width, h0: sh.footH - sh.rows * glyphSize, rows: sh.rows })),
      ...sessions.filter((s) => !shapeOf.has(s.id)).map((s) => ({ w: FOOT_W, h0: birdExtraH(s), rows: 1 })),
    ];
    const over = overflowAtBase.map((id) => boxes.find((b) => b.id === id)!);
    // The same placement at another garden size, as if the window were resized to it: what is on screen shifted to
    // stay at the same place on screen (gardenGrowAnchor), what had no spot or sticks out placed again. For growing
    // only as far as needed and shrinking back as far as everything still gets a spot (garden-grow.ts)
    const placed: PlacedGarden = {
      settled: tried,
      fresh,
      heightAt,
      glyph: glyphSize,
      count: sessions.length,
      w: W,
      h: baseH,
      // Read when tried, not copied now: garden-grow.ts fetches it before deciding the scale
      anchor: gardenGrowAnchor,
      overflowIds: new Set(overflowAtBase),
    };
    const simulate = (gw: number, gh: number) => {
      const { overflow, moved } = gardenSimulate(placed, gw, gh);
      return { overflow, moved };
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
      drops: kept.dropCount,
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

  // How far below a bird's top edge its icon's center is (px), for the watch lines. Measured from a bird in a block (its
  // name row is always there); until then, the name row's usual height
  const [glyphMid, setGlyphMid] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (paused) return;
    const el = containerRef.current?.querySelector<HTMLElement>(".garden-node.in-watch-block .garden-glyph");
    if (!el) return;
    const mid = el.offsetTop + el.offsetHeight / 2;
    if (mid !== glyphMid) setGlyphMid(mid);
  });

  // Where the bubbles go and how wide they may be (layoutBubbles, docs/design.md "Layout"): narrowed and moved sideways
  // apart from the bubbles beside them that overlap them vertically, and above the icon when they would reach past the
  // garden's bottom. A bubble's height at a given max width is measured here by setting it on the bubble for a moment
  const [bubblePlaces, setBubblePlaces] = useState<Map<string, BubblePlace>>(new Map());
  useLayoutEffect(() => {
    const garden = containerRef.current;
    if (!garden || paused) return;
    const laid: LaidBird[] = [];
    const bubbles = new Map<string, HTMLElement>();
    for (const anchor of garden.querySelectorAll<HTMLElement>(".garden-bubble-anchor[data-session-id]")) {
      const bubble = anchor.querySelector<HTMLElement>(".speech-bubble-below");
      if (!bubble) continue;
      const id = anchor.dataset.sessionId!;
      bubbles.set(id, bubble);
      laid.push({
        id,
        x: anchor.offsetLeft,
        y: anchor.offsetTop,
        iconTop: parseFloat(anchor.style.getPropertyValue("--bubble-icon-top")) || 0,
        nameTop: parseFloat(anchor.style.getPropertyValue("--bubble-name-top")) || 0,
        iconBottom: parseFloat(anchor.style.getPropertyValue("--bubble-top")) || 0,
        inBlock: anchor.classList.contains("in-watch-block"),
      });
    }
    const measure = (id: string, max: number) => {
      const bubble = bubbles.get(id)!;
      const was = bubble.style.getPropertyValue("--bubble-max");
      bubble.style.setProperty("--bubble-max", `${max}px`);
      const size = { w: bubble.offsetWidth, h: bubble.offsetHeight };
      if (was) bubble.style.setProperty("--bubble-max", was);
      else bubble.style.removeProperty("--bubble-max");
      return size;
    };
    const next = layoutBubbles(
      laid,
      { w: garden.clientWidth, h: garden.clientHeight, growH: growRoom?.h, growUp: growRoom?.up },
      measure,
    );
    const same =
      next.size === bubblePlaces.size &&
      [...next].every(([id, p]) => {
        const q = bubblePlaces.get(id);
        return (
          q !== undefined &&
          q.above === p.above &&
          q.max === p.max &&
          Math.abs(q.shift - p.shift) < 0.5 &&
          Math.abs(q.bottom - p.bottom) < 0.5
        );
      });
    if (!same) setBubblePlaces(next);
  });

  // After a drop, save where every bird settled, not where the pointer was released (docs/design.md "Layout"). Saved
  // spots of birds that are gone are pruned
  useEffect(() => {
    const pending = dropSaveRef.current;
    if (!pending) return;
    dropSaveRef.current = null;
    const live = new Set(liveIds);
    setPositions((prev) => {
      const pruned = Object.fromEntries(Object.entries(prev ?? {}).filter(([id]) => live.has(id)));
      const next = positionsAfterDrop({ prev: pruned, ...pending });
      void saveGardenPositions(next);
      return next;
    });
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
    // Hidden: what was sent last stays (the window doesn't grow then), so nothing is sent again once shown
    if (paused) return;
    const el = containerRef.current;
    const body = el?.closest<HTMLElement>(".page-body");
    const base = fitRef.current;
    let fit: GardenFit | null = null;
    if (el && body && base && el.offsetWidth > 0) {
      // Everything in .page-body other than the garden (tab panel padding, the garden's margin) counts as overhead,
      // so the garden's own stretched height doesn't. The mock controls don't (mockPanelRoom)
      const others = othersInBody(body, el);
      // The garden must never reach past the window (docs/design.md "Layout"); log it if it ever does
      const past = body.scrollHeight - mockPanelRoom(body) - body.clientHeight;
      if (past > 1) {
        void invoke("log", { line: `[garden] content ${past}px past the window bottom` }).catch(() => {});
      }
      // A bubble past the garden's bottom or top grows the window too, as far as growing can give it room
      // (docs/design.md "Layout")
      const reach = bubbleReach(bubblePlaces, growRoom?.h ?? base.gardenH);
      const reachUp = bubbleReachUp(bubblePlaces, growRoom?.up ?? 0);
      fit = withBubbleUp(
        {
          ...base,
          overheadW: Math.round(window.innerWidth - el.offsetWidth),
          overheadH: Math.round(window.innerHeight - body.clientHeight + others),
        },
        reach,
        base.gardenH,
        gardenGrowAnchor,
        reachUp,
        growRoom,
      );
    }
    const key = JSON.stringify(fit);
    if (sentFitRef.current === key) return;
    sentFitRef.current = key;
    onFit?.(fit);
  });

  if (sessions.length === 0) {
    return (
      <div className="empty garden-empty" hidden={paused}>
        {/* With no birds the Garden still fades, and this message is what stays at rest, acting as a second window
            handle (docs/design.md "Fade until hovered") */}
        <span className="fade-handle garden-empty-label" onPointerDown={onFadeHandlePointerDown}>
          {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
        </span>
      </div>
    );
  }

  // Birds the user dragged, drawn in front of the others, the last dragged frontmost (gardenStack)
  const fronts = frontRanks(positions ?? {});
  // Birds outside a block in the same row as a bird with a bubble keep the bubble room, so the status lines of the row
  // line up (docs/design.md "Layout")
  const roomFor = bubbleRoomFor(
    sessions.flatMap((s) => {
      const p = positionOf(s.id);
      return p ? [{ id: s.id, x: p.x, y: p.y, bubble: bubbleText(s) !== undefined, inBlock: shapeOf.has(s.id) }] : [];
    }),
  );
  return (
    <div
      className="garden"
      ref={containerRef}
      hidden={paused}
      // The same menu on a bird, a watch block and an empty spot, in place of the WebView's own (docs/design.md "Layout")
      onContextMenu={(e) => {
        e.preventDefault();
        popupGardenMenu({ arrange, ...menu });
      }}
    >
      {/* Speech bubble layer. Placed above the birds with their names, marks and status lines, so a bubble covers a
          neighbour rather than hiding under it. Among bubbles, newer turns are on top (bubbleOrder) */}
      <div className="garden-bubble-layer" ref={setBubbleLayer} />
      {/* Lines between linked birds of a watching group, from icon to icon. Laid under the bird layer and kept at rest
          (docs/design.md "Watching") */}
      {shapes.length > 0 && (
        <svg className="garden-watch-lines" width={W} height={gardenH} aria-hidden>
          {shapes.flatMap((shape) => {
            const mid = glyphMid ?? WATCH_NAME_ROW_PX + glyphSize / 2;
            const iconAt = (id: string) => {
              const p = positionOf(id);
              return p && { x: p.x, y: p.y + mid };
            };
            return shape.links.map(([a, b]) => {
              const pa = iconAt(a);
              const pb = iconAt(b);
              const ends = pa && pb && watchLinePath(pa, pb, glyphSize / 2 + WATCH_LINE_GAP_PX, WATCH_LINE_MAX_PX);
              return (
                ends && (
                  <g key={`${a}\n${b}`}>
                    <line className="garden-watch-line-outline" x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} />
                    <line className="garden-watch-line" x1={ends[0].x} y1={ends[0].y} x2={ends[1].x} y2={ends[1].y} />
                  </g>
                )
              );
            });
          })}
        </svg>
      )}
      {sessions.map((s) => {
        const position = positionOf(s.id);
        if (!position) return null;
        const shape = shapeOf.get(s.id);
        const blockLeft = shape && shownBlockAt(shape)?.x;
        const cell = shape?.cells.get(s.id);
        const watchPlace: WatchPlace | undefined =
          cell && blockLeft !== undefined
            ? { bubbleRoom: cell.bubbleRoom, label: cell.label, nameRoom: cell.nameRoom }
            : undefined;
        const stackOrder = bubbleOrder.get(s.id);
        const front = fronts.get(s.id);
        // On first display, static without flying; new sessions come from the sky
        const entryOrigin: "none" | "sky" = animateEntry ? "sky" : "none";
        const isConcierge = s.id === CONCIERGE_ID;
        // The concierge jumps to the session its advice is about; with no target a click does nothing
        const focusId = isConcierge ? conciergeTarget : s.id;
        return (
          <GardenNode
            key={s.id}
            session={s}
            position={position}
            gardenH={gardenH}
            containerRef={containerRef}
            entryOrigin={entryOrigin}
            glyphSize={glyphSize}
            iconSet={resolveIconSet(iconSetAssignments, s.slug)}
            onDragEnd={(next) => {
              kept.drops.set(s.id, { x: next.x - FOOT_W / 2, y: next.y });
              placeDrop();
            }}
            stackOrder={stackOrder}
            front={front}
            groupDragging={shape !== undefined && groupDrag?.rootId === shape.rootId}
            bubbleLayer={bubbleLayer}
            keepBubbleRoom={roomFor.has(s.id)}
            bubblePlace={bubblePlaces.get(s.id)}
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
              placeDrop();
            }}
            focusable={Boolean(onFocus && focusId && canFocus?.(focusId))}
            onClick={() => focusId && onFocus?.(focusId)}
            concierge={isConcierge ? concierge?.look : undefined}
          />
        );
      })}
      {Array.from(leaving.entries()).map(([id, entry]) => (
        <GardenNode
          key={id}
          session={entry.session}
          position={entry.position}
          gardenH={gardenH}
          containerRef={containerRef}
          entryOrigin="none"
          glyphSize={glyphSize}
          iconSet={resolveIconSet(iconSetAssignments, entry.session.slug)}
          onDragEnd={() => {}}
          concierge={id === CONCIERGE_ID ? conciergeLookRef.current : undefined}
          exiting
          onExited={handleExited}
        />
      ))}
    </div>
  );
}

export function GardenNode({
  session,
  position,
  gardenH,
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
  front,
  groupDragging = false,
  bubbleLayer,
  keepBubbleRoom = false,
  bubblePlace,
  watchPlace,
  groupRootId,
  onGroupMove,
  onGroupDrop,
  concierge,
  dragMovesWindow = false,
  bubbleContent,
}: {
  session: SessionView;
  // px: the bird's center and top edge
  position: NodePos;
  // Height the birds are placed in (px; the garden may be stretched taller than the window)
  gardenH: number;
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
  // How far in front among the birds the user dragged (frontRanks). undefined for birds never dragged
  front?: number;
  // The block this bird is in is being dragged
  groupDragging?: boolean;
  // Where the speech bubble is rendered (Garden's .garden-bubble-layer)
  bubbleLayer?: HTMLElement | null;
  // Keep the bubble room without a bubble, so the status lines line up with a row that has a bubble (bubbleRoomFor)
  keepBubbleRoom?: boolean;
  // How wide the speech bubble may be and where it goes: moved sideways off the bird's center, or above the icon
  // (layoutBubbles). undefined until measured, keeping the CSS max
  bubblePlace?: BubblePlace;
  // The bird's spot within a watching block. Present only for birds in a block
  watchPlace?: WatchPlace;
  // A bird in a block drags the whole block (moves the block, not its own position)
  groupRootId?: string;
  onGroupMove?: (drag: GroupDrag) => void;
  onGroupDrop?: (drag: GroupDrag) => void;
  // The concierge's node: its own image, no status lines or event marks (docs/design.md "Concierge")
  concierge?: ConciergeLook;
  // Dragging it moves the floating window instead of the bird ("Concierge only", where the window is the concierge's
  // size); in the standard window it stays put
  dragMovesWindow?: boolean;
  // What the bubble shows in place of its text ("Concierge only": every session's line and the suggestions)
  bubbleContent?: ReactNode;
}) {
  // Whether this bird needs a reply (switches the state word / tool name) and whether to show the "?" (only birds
  // actually asking)
  const asking = needsAnswer(session.state, session.ask);
  const question = hasQuestion(session);
  const bubble = bubbleText(session);
  const hasBubble = bubbleContent !== undefined || Boolean(bubble);
  const nodeRef = useRef<HTMLDivElement>(null);
  const glyphRef = useRef<HTMLSpanElement>(null);
  // Birds in a watching group may reserve bubble space even without a speech bubble (WatchPlace.bubbleRoom)
  const bubbleRoom = hasBubble || Boolean(watchPlace?.bubbleRoom) || keepBubbleRoom;
  // From the node's top edge to the icon's top and bottom edges (a bubble above the icon ends at its top, one below
  // starts at its bottom). The icon resizes smoothly with the garden size (transition in styles/garden.css), so track
  // size changes instead of reading once at render
  const [glyphTop, setGlyphTop] = useState<number | undefined>(undefined);
  const [glyphBottom, setGlyphBottom] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = glyphRef.current;
    if (!el) return;
    const measure = () => {
      setGlyphTop(el.offsetTop);
      setGlyphBottom(el.offsetTop + el.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The name's top edge and width, and the icon's width: a bubble above goes above the name, its tail passing beside
  // the name to the icon (docs/design.md "Layout"). Read after every render, as the name can change
  const nameRef = useRef<HTMLSpanElement>(null);
  const [nameBox, setNameBox] = useState<
    { top: number; w: number; h: number; iconTop: number; iconW: number; iconH: number } | undefined
  >(undefined);
  useLayoutEffect(() => {
    const name = nameRef.current;
    const glyph = glyphRef.current;
    if (!glyph) return;
    const next = {
      top: name ? name.offsetTop : glyph.offsetTop,
      w: name?.offsetWidth ?? 0,
      h: name?.offsetHeight ?? 0,
      iconTop: glyph.offsetTop,
      iconW: glyph.offsetWidth,
      iconH: glyph.offsetHeight,
    };
    if (!nameBox || Object.entries(next).some(([k, v]) => nameBox[k as keyof typeof next] !== v)) setNameBox(next);
  });
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
  const groupRef = useRef({ groupRootId, onGroupMove, onGroupDrop, gardenH, dragMovesWindow });
  useEffect(() => {
    onDragEndRef.current = onDragEnd;
    onClickRef.current = onClick;
    groupRef.current = { groupRootId, onGroupMove, onGroupDrop, gardenH, dragMovesWindow };
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
    // The same on screen: a block moves by how far the pointer moved on screen, which stays right when the window
    // grows left or up during the drag (the window's corner moves under the pointer)
    let downScreenX = 0;
    let downScreenY = 0;
    let moved = false;
    // The block the grabbed bird is in, if any
    let groupRoot: string | undefined;

    const onPointerDown = (e: PointerEvent) => {
      // Left button only, so a right/middle click released without moving doesn't jump to the terminal. Control-click is
      // macOS's right click: it opens the Garden's menu instead
      if (e.button !== 0 || e.ctrlKey) return;
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();
      startRect = container.getBoundingClientRect();
      grabOffsetX = node.offsetLeft - (e.clientX - startRect.left);
      grabOffsetY = node.offsetTop - (e.clientY - startRect.top);
      downX = e.clientX;
      downY = e.clientY;
      downScreenX = e.screenX;
      downScreenY = e.screenY;
      moved = false;
      dragging = true;
      groupRoot = groupRef.current.groupRootId;
      node.setPointerCapture(e.pointerId);
    };

    const posFromEvent = (e: PointerEvent): NodePos | null => {
      // Measured again each time: a drag may grow the window (dragGrowAt)
      const container = containerRef.current;
      if (container) startRect = container.getBoundingClientRect();
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
      groupRoot === undefined
        ? undefined
        : { rootId: groupRoot, dx: e.screenX - downScreenX, dy: e.screenY - downScreenY };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) < CLICK_SLOP_PX) return;
      moved = true;
      if (groupRef.current.dragMovesWindow) {
        dragging = false;
        if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
        if (currentWindowMode() !== "normal") void getCurrentWindow().startDragging();
        return;
      }
      // Near or past the garden's edge, the window grows that way (docs/design.md "Layout")
      if (containerRef.current) dragGrowAt(e, containerRef.current);
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
      dragGrowEnd();
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
  // A bird the user dragged comes in front of the other birds and bubbles, with its bubble (docs/design.md "Layout")
  const stack = gardenStack({ dragging: Boolean(live) || groupDragging, front, bubbleOrder: stackOrder });
  const bubbleParent = stack.bubbleInLayer ? bubbleLayer : containerRef.current;
  // The speech bubble appears right below the icon and the node reserves that space (.garden-bubble-room), so it is
  // included in the node height
  const nodeH = nodeRef.current?.offsetHeight || glyphSize + NODE_TEXT_PX + (bubbleRoom ? BUBBLE_ROOM_PX : 0);
  // Birds in a watching group are placed at their cell inside the block (they don't follow the pointer alone)
  const grouped = watchPlace;
  // Whether the bird is inside a watching block
  const inBlock = grouped !== undefined;
  const left = `${pos.x}px`;
  const top = `${pos.y}px`;
  // The speech bubble is centered under the bird and pushed only to stay inside the garden frame (bubbleVars), for birds
  // in a watching block too (docs/design.md "Layout")
  const bubbleRange = bubbleRangeOf(containerRef.current);
  const tail =
    bubblePlace?.above && nameBox
      ? aboveTail(
          bubblePlace,
          nameBox,
          { w: nameBox.iconW, h: nameBox.iconH },
          nameBox.iconTop - nameBox.top,
        )
      : undefined;
  const bubbleStyle =
    bubbleRange && {
      ...bubbleVars(pos.x, bubbleRange, inBlock ? undefined : bubblePlace?.max, bubblePlace?.shift),
      ...(tail &&
        ({
          "--tail-base": `${tail.base}px`,
          "--tail-knee": `${tail.knee}px`,
          "--tail-tip": `${tail.tip}px`,
          "--tail-h": `${tail.h}px`,
        } as CSSProperties)),
    };

  // Bird facing. About half are mirrored deterministically based on the id (all facing the same way looks stuffed).
  // Sprites are assumed to face left by default → flip = facing right
  const flip = !concierge && hashId(session.id) % 2 === 1;

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
      className={`garden-node ${concierge ? "concierge" : session.state}${question ? " asking" : ""}${live ? " dragging" : ""}${exiting ? " leaving" : ""}${focusable ? " focusable" : ""}${inBlock ? " in-watch-block" : ""}${stack.inFront ? " in-front" : ""}`}
      style={{
        left,
        top,
        // gardenStack (the z-index of .garden-node.dragging loses to the inline style)
        zIndex: stack.node,
      }}
      title={concierge ? t("conciergeTitle") : undefined}
    >
      {/* Positioning (left/top px + horizontal translate centering), dragging, and the hover/dragging
          transforms are handled by the plain outer div. WAAPI overwrites transform entirely, so it isn't
          applied to the same element; the inner div wrapping only the content carries the enter/leave animations */}
      <div className="garden-node-inner" ref={innerRef}>
        {/* Birds in a block show only what differs (path relative to the parent). If any bird in the row has a name,
            birds without one also reserve the row height */}
        {!inBlock ? (
          <span className="garden-name" ref={nameRef}>
            {session.project}
          </span>
        ) : grouped.label !== undefined ? (
          <span className="garden-name" title={grouped.label} ref={nameRef}>
            {grouped.label}
          </span>
        ) : (
          grouped.nameRoom && <span className="garden-name" aria-hidden>{"\u00a0"}</span>
        )}
        <span className="garden-glyph" ref={glyphRef}>
          {concierge ? (
            <ConciergeGlyph look={concierge} size={glyphSize} />
          ) : (
            <BirdGlyph
              state={session.state}
              size={glyphSize}
              flip={flip}
              set={iconSet}
              asking={question}
              angry={isAngry(session)}
            />
          )}
        </span>
        {/* Speech bubble slot. The bubble itself is rendered in the bubble layer (to stack above other birds); this is
            only the space that pushes the status row down */}
        {bubbleRoom && <span className="garden-bubble-room" aria-hidden />}
        {/* Same component as the Perch rows. Line 1 has the state word and elapsed time; the tool name goes on the line below */}
        {!concierge && (
          <span className="garden-status">
            <StatusParts session={session} asking={asking} toolOnOwnLine stacked={inBlock} />
          </span>
        )}
        {/* Watching: the number of active peers under the bird */}
        {/* Counts only peers active right now. Not shown during the grace period (0) */}
        {session.watching !== undefined && session.watching > 0 && (
          <span className="garden-watch-count" title={t("watchingPeersTitle")}>
            <MdLink size={12} aria-hidden />
            {session.watching}
          </span>
        )}
      </div>
      {/* The speech bubble puts an anchor at the same position and height as the bird in the bubble layer (for a bird
          the user dragged, beside the layer in the garden, just above the bird: gardenStack), and appears right below
          the icon's bottom edge (--bubble-top), in the space before the name (.garden-bubble-room). The distance from
          the icon is the same for every bird */}
      {hasBubble &&
        bubbleLayer &&
        bubbleParent &&
        !exiting &&
        createPortal(
          <div
            data-session-id={session.id}
            className={`garden-bubble-anchor${inBlock ? " in-watch-block" : ""}${concierge ? " concierge" : ""}${
              bubblePlace?.above ? " above" : ""
            }`}
            style={
              {
                left,
                top,
                height: nodeH,
                zIndex: stack.bubble,
                "--bubble-top": `${glyphBottom ?? glyphSize}px`,
                "--bubble-icon-top": `${glyphTop ?? 0}px`,
                "--bubble-name-top": `${nameBox?.top ?? glyphTop ?? 0}px`,
              } as CSSProperties
            }
          >
            {bubbleContent === undefined ? (
              <SpeechBubble text={bubble ?? ""} placement="below" style={bubbleStyle} />
            ) : (
              <span className="speech-bubble-below concierge-report" style={bubbleStyle}>
                <span className="speech-bubble">{bubbleContent}</span>
              </span>
            )}
          </div>,
          bubbleParent,
        )}
    </div>
  );
}
