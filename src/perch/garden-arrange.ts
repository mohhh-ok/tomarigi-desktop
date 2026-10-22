// What the Garden's placement keeps between renders, and Arrange from the Garden's right-click menu (docs/design.md
// "Layout"; issue #4): it forgets where everything is and lays the birds out again as on a launch with no saved positions
import type { GridCell } from "./garden-watch-layout";
import type { Point } from "@/lib/garden-place";

// What the placement keeps between renders (docs/design.md "Layout": a bird or block on screen stays where it is)
export interface Kept {
  // Top-left of each bird's footprint as last shown (birds in a block included, so they stay put if the block goes)
  birds: Map<string, Point>;
  // Top-left of each block as last shown, by its first-started bird, with its members' grid cells (so they keep them)
  blocks: Map<string, { at: Point; members: string[]; grid: Map<string, GridCell> }>;
  // Spots the user just dropped a bird (footprint top-left) or a block (block top-left) on, used on the next render
  drops: Map<string, Point>;
  // Birds and blocks that had no free spot and overlap others
  overlapping: Set<string>;
  // Birds and blocks (by their first-started bird) the user dropped where they are: kept there over others too
  // (docs/design.md "Layout"), until dragged again or gone
  byUser: Set<string>;
  // Birds and blocks (by their first-started bird) not on screen yet: first placed in a render that had no spot for
  // something, which asks the window to grow (docs/design.md "Layout": "On screen"). Kept where they are while the
  // garden keeps that size (unsettledAt); placed again like new ones once it changes, so the places they got in the
  // small garden don't split the room the window grew for
  unsettled: Set<string>;
  unsettledAt?: { w: number; h: number };
  // Garden size at the last placement (to keep things at the same place on screen when it resizes)
  frame?: { w: number; h: number };
  // How many times the user dropped a bird or block, or an Arrange settled (GardenFit.drops: the window shrinks once
  // on each)
  dropCount: number;
  // Arrange laid the birds out again and they haven't all got a spot yet (the window may be growing for them)
  arranging: boolean;
}

export function newKept(): Kept {
  return {
    birds: new Map(),
    blocks: new Map(),
    drops: new Map(),
    overlapping: new Set(),
    byUser: new Set(),
    unsettled: new Set(),
    dropCount: 0,
    arranging: false,
  };
}

/** Arrange: nothing is on screen or placed by the user any more, so every bird and block is placed on the next render
    as one that appears. The garden's size and the drop count stay */
export function arrangeKept(kept: Kept): void {
  kept.birds.clear();
  kept.blocks.clear();
  kept.drops.clear();
  kept.overlapping.clear();
  kept.byUser.clear();
  kept.unsettled.clear();
  kept.unsettledAt = undefined;
  kept.arranging = true;
}

/** After a placement with `overflow` boxes that had no spot: whether the Arrange is over now (every bird has its spot),
    to be saved like a drop. The window then shrinks once, as after a drop */
export function arrangeSettled(kept: Kept, overflow: number): boolean {
  if (!kept.arranging || overflow > 0) return false;
  kept.arranging = false;
  kept.dropCount++;
  return true;
}
