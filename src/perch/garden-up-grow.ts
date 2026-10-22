// When growing the window up for a bubble is over (docs/design.md "Layout"). Pure computation (no DOM or Tauri
// access); garden-grow.ts keeps the anchor at y 1 until this says so

/**
 * How long the page waits for the Garden to see the window grown up for a bubble (ms). The garden's height may never
 * change: it is clientHeight, whole CSS px, so a grow of under 1 CSS px (one physical px left above the window at scale
 * 2) is rounded away, and a resize that didn't happen still reports grown (garden_bubble_grow in
 * src-tauri/src/garden_grow.rs). Without this the anchor stayed at y 1 and nothing resized the window again
 */
export const UP_GROW_WAIT_MS = 1000;

/** The wait: the garden's height when growing up was asked for, and when (ms, Date.now) */
export type UpGrowWait = { gardenH: number; since: number };

/** Whether the wait is over: the Garden reported another height (gardenH; undefined with no fit), or it timed out */
export function upGrowDone(wait: UpGrowWait, gardenH: number | undefined, now: number): boolean {
  return (gardenH !== undefined && gardenH !== wait.gardenH) || now - wait.since >= UP_GROW_WAIT_MS;
}

/**
 * How long until the wait times out (ms, 0 once it has). The timer that ends the wait can fire a little early by
 * Date.now, before upGrowDone says done; garden-grow.ts sets it again for the rest, as nothing else may end the wait
 */
export function upGrowLeftMs(wait: UpGrowWait, now: number): number {
  return Math.max(0, wait.since + UP_GROW_WAIT_MS - now);
}

/**
 * Whether to grow the window up for a bubble above its bird's name past the garden's top (growUp, GardenFit). Not
 * while a drag grows the window: the anchor is the drag's until it ends, and the fit after the drag decides
 */
export function growsUpForBubble(state: {
  active: boolean;
  held: boolean;
  dragging: boolean;
  growUp: number | undefined;
}): boolean {
  return state.active && !state.held && !state.dragging && state.growUp !== undefined;
}
