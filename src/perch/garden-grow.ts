// Grow the floating window when the Garden's birds don't fit (docs/design.md "Layout"). This decides how far (a scale
// of the user's size, gardenFitScale in lib/garden-fit.ts); the Rust side (src-tauri/src/garden_grow.rs) decides the
// direction, caps it at the display's visible area, and keeps the user's size apart from the grown one
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { gardenDropScale, growStep, type GardenFit, type GrowKept } from "@/lib/garden-fit";
import { dragGrowRequest } from "./garden-drag-grow";

/**
 * Which part of the window stays put on screen when it grows or shrinks back, per axis (0 the left / top edge, 1 the
 * right / bottom edge, 0.5 the center; garden_grow_anchor in src-tauri/src/garden_grow.rs). Fetched before each
 * resize is asked for, so it is known when the Garden sees the new size; the Garden shifts its birds by it so they
 * stay at the same place on screen (docs/design.md "Layout")
 */
export const gardenGrowAnchor = { x: 0, y: 0 };

// A drag is growing the window: the anchor is the drag's until it ends (dragGrowEnd), not the one fetched for growing
// to fit
let dragGrowing = false;

/** Called on each pointer move of a drag. e: the pointer event; garden: the garden element */
export function dragGrowAt(e: PointerEvent, garden: HTMLElement): void {
  const rect = garden.getBoundingClientRect();
  const request = dragGrowRequest(
    { x: e.clientX, y: e.clientY },
    rect,
    { width: window.innerWidth, height: window.innerHeight },
  );
  if (!request) return;
  dragGrowing = true;
  // Set before the resize arrives, so the Garden keeps its birds at the same place on screen with it
  Object.assign(gardenGrowAnchor, request.anchor);
  void invoke("garden_drag_grow", { x: e.screenX, y: e.screenY, ...request.insets }).catch(() => {});
}

/** The drag ended */
export function dragGrowEnd(): void {
  if (!dragGrowing) return;
  dragGrowing = false;
  void invoke("garden_drag_end").catch(() => {});
}

interface UserSize {
  width: number;
  height: number;
  /** Changed by a manual resize (not by a mode switch) */
  manual: boolean;
}

/**
 * active: floating window, Garden tab, nothing else shown in its place. Otherwise the window goes back to the user's
 * size. birdCount: after a manual resize the window isn't grown back until a bird joins.
 * Returns the callback for Garden's onFit. The fit is kept in a ref, not in state: Garden reports it after every
 * render, and its values move with the layout (measured block heights), so putting it in the parent's state re-rendered
 * Garden, which reported a different fit again, until React stopped with "Maximum update depth exceeded" and the
 * whole page went blank (observed)
 */
export function useGardenGrow(active: boolean, birdCount: number): (fit: GardenFit | null) => void {
  const [user, setUser] = useState<UserSize | null>(null);
  // Number of birds at the last manual resize. Growth waits until there are more birds than this
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const countRef = useRef(birdCount);
  countRef.current = birdCount;
  useEffect(() => {
    void invoke<UserSize>("window_user_size").then(setUser, () => {});
    const unlisten = listen<UserSize>("window-user-size", (e) => {
      setUser(e.payload);
      if (e.payload.manual) setHeldAt(countRef.current);
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // A bird joined since the manual resize: grow again. A bird left: count from the smaller number, so the next one
  // to join counts as joining
  useEffect(() => {
    if (heldAt === null) return;
    if (birdCount > heldAt) setHeldAt(null);
    else if (birdCount < heldAt) setHeldAt(birdCount);
  }, [birdCount, heldAt]);

  const held = heldAt !== null && birdCount <= heldAt;
  // Inputs other than the fit, read by update (which Garden's onFit also calls)
  const inputsRef = useRef({ active, held, user, birdCount });
  inputsRef.current = { active, held, user, birdCount };
  const fitRef = useRef<GardenFit | null>(null);
  // The scale applied while growing. Cleared when not growing, so it starts over from the needed scale
  const keptRef = useRef<GrowKept | null>(null);
  const sentRef = useRef<number | undefined>(undefined);
  // Latest update asked for; an older one whose anchor arrives later is dropped
  const seqRef = useRef(0);
  // The drop count (GardenFit.drops) last seen: a new one shrinks the window once
  const dropsRef = useRef<number | undefined>(undefined);

  const decide = useCallback(() => {
    const { active, held, user, birdCount } = inputsRef.current;
    const fit = fitRef.current;
    // The user dropped a bird or block: shrink once to the smallest size at which nothing on screen moves (even after a
    // manual resize, as it never goes below the user's size; docs/design.md "Layout")
    const seen = dropsRef.current;
    if (fit?.drops !== undefined) dropsRef.current = fit.drops;
    const dropScale =
      active && fit && user && seen !== undefined && fit.drops !== seen && !fit.overflow
        ? gardenDropScale(user.width, user.height, fit)
        : undefined;
    const step = growStep({ active, held, fit, user, birdCount, kept: keptRef.current, dropScale });
    const { scale, needed, drop } = step;
    keptRef.current = step.kept;
    if (!drop && sentRef.current === scale) return;
    sentRef.current = scale;
    // What the needed scale came from, to check in the log why it changed
    const line = `[grow] page scale=${scale} needed=${needed} drop=${drop} birds=${birdCount} fit=${JSON.stringify(
      fit && { ...fit, boxes: fit.boxes.length, simulate: undefined },
    )}`;
    void invoke("log", { line }).catch(() => {});
    void invoke("garden_fit", { scale, drop }).catch(() => {});
  }, []);

  // The anchor is fetched before the scale is decided, not only before a resize: Garden's simulate tries other sizes
  // with it, and one left over from before (the window moved to another part of the display while grown, or the page
  // reloaded and it went back to 0) shrank the window to a size where a block had no spot, and it grew right back
  // (observed: tried keeping the top-left, resized keeping the bottom-right)
  const update = useCallback(() => {
    const seq = ++seqRef.current;
    void Promise.resolve()
      .then(() => invoke<{ x: number; y: number } | null>("garden_grow_anchor"))
      .catch(() => null)
      .then((anchor) => {
        if (seq !== seqRef.current) return;
        if (anchor && !dragGrowing) Object.assign(gardenGrowAnchor, anchor);
        decide();
      });
  }, [decide]);

  useEffect(update, [active, held, user, birdCount, update]);

  return useCallback(
    (fit: GardenFit | null) => {
      fitRef.current = fit;
      update();
    },
    [update],
  );
}
