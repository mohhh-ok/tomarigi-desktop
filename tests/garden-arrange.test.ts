// Arrange (the Garden's right-click menu) drops every saved position and every "placed by the user" mark, and lays the
// birds out again as on a launch with no saved positions. The result is saved like a drop, and the window shrinks once
// (docs/design.md "Layout"; issue #4)
import { describe, expect, test } from "bun:test";
import { hashId, positionsAfterDrop } from "../src/lib/garden-layout.ts";
import { placeBoxes, type PlaceBox, type Point } from "../src/lib/garden-place.ts";
import { arrangeKept, arrangeSettled, newKept, type Kept } from "../src/perch/garden-arrange.ts";

const W = 480;
const H = 300;
const FOOT = { w: 120, h: 113 };
const ids = ["blog", "cloudflare-lab", "docs-migration", "figma-adapter", "moh-tech-net", "tomarigi"];

/** Birds that appear with no saved spot, as garden.tsx places them: by id, each in a cell picked by its id */
const launch = () =>
  placeBoxes(
    [...ids].sort().map((id): PlaceBox => ({ id, ...FOOT, seed: hashId(id) })),
    W,
    H,
  ).at;

/** A garden after the user dragged birds around: two on top of each other, one in the corner */
function dragged(): Kept {
  const kept = newKept();
  const at = launch();
  at.set("blog", { x: 200, y: 100 });
  at.set("tomarigi", { x: 210, y: 110 });
  at.set("figma-adapter", { x: 356, y: 183 });
  kept.birds = new Map(at);
  kept.blocks.set("blog", { at: { x: 10, y: 10 }, members: ["blog"], grid: new Map() });
  kept.byUser = new Set(["blog", "tomarigi", "figma-adapter"]);
  kept.drops.set("moh-tech-net", { x: 0, y: 0 });
  kept.overlapping = new Set(["tomarigi"]);
  kept.unsettled = new Set(["docs-migration"]);
  kept.unsettledAt = { w: W, h: H };
  kept.frame = { w: W, h: H };
  kept.dropCount = 3;
  return kept;
}

describe("arrangeKept", () => {
  test("forgets where every bird and block is, the user's marks, drops and what had no spot", () => {
    const kept = dragged();
    arrangeKept(kept);
    expect(kept.birds.size).toBe(0);
    expect(kept.blocks.size).toBe(0);
    expect(kept.byUser.size).toBe(0);
    expect(kept.drops.size).toBe(0);
    expect(kept.overlapping.size).toBe(0);
    expect(kept.unsettled.size).toBe(0);
    expect(kept.unsettledAt).toBeUndefined();
    expect(kept.arranging).toBe(true);
  });

  test("keeps the garden's size and the drop count, so the shrink after it is one more than before", () => {
    const kept = dragged();
    arrangeKept(kept);
    expect(kept.frame).toEqual({ w: W, h: H });
    expect(kept.dropCount).toBe(3);
  });

  test("the birds are then placed as on a launch with no saved positions", () => {
    const kept = dragged();
    arrangeKept(kept);
    // Nothing is on screen, nothing saved: every bird is placed as one that appears, in the cell its id picks
    const boxes = [...ids].sort().map((id): PlaceBox => {
      const at = kept.birds.get(id);
      return at ? { id, ...FOOT, at, byUser: kept.byUser.has(id) } : { id, ...FOOT, seed: hashId(id) };
    });
    const { at, overflow } = placeBoxes(boxes, W, H);
    expect(at).toEqual(launch());
    expect(overflow).toEqual([]);
  });
});

describe("arrangeSettled", () => {
  test("once every bird has a spot, it is saved like a drop and the window shrinks once", () => {
    const kept = newKept();
    kept.dropCount = 2;
    arrangeKept(kept);
    expect(arrangeSettled(kept, 0)).toBe(true);
    expect(kept.arranging).toBe(false);
    expect(kept.dropCount).toBe(3);
  });

  test("while something has no spot (the window is asked to grow), it waits", () => {
    const kept = newKept();
    arrangeKept(kept);
    expect(arrangeSettled(kept, 1)).toBe(false);
    expect(kept.arranging).toBe(true);
    expect(kept.dropCount).toBe(0);
    // The window grew and everything got a spot
    expect(arrangeSettled(kept, 0)).toBe(true);
    expect(kept.dropCount).toBe(1);
  });

  test("only once per Arrange", () => {
    const kept = newKept();
    arrangeKept(kept);
    arrangeSettled(kept, 0);
    expect(arrangeSettled(kept, 0)).toBe(false);
    expect(kept.dropCount).toBe(1);
  });

  test("without Arrange, nothing happens", () => {
    const kept = newKept();
    expect(arrangeSettled(kept, 0)).toBe(false);
    expect(kept.dropCount).toBe(0);
  });
});

test("what is saved after Arrange has no mark of the user's placing nor front order, so a relaunch places them the same", () => {
  const settled = new Map<string, Point>([...launch()].map(([id, p]) => [id, { x: p.x + FOOT.w / 2, y: p.y }]));
  const saved = positionsAfterDrop({ prev: {}, settled, byUser: new Set(), front: new Set(), w: W, h: H });
  for (const p of Object.values(saved)) {
    expect(p.byUser).toBeUndefined();
    expect(p.front).toBeUndefined();
  }
  // Reopened from what was saved: every bird wants its saved spot and gets it
  const reopened = placeBoxes(
    [...ids].sort().map((id): PlaceBox => ({
      id,
      ...FOOT,
      want: { x: (saved[id]!.x / 100) * W - FOOT.w / 2, y: (saved[id]!.y / 100) * H },
    })),
    W,
    H,
  ).at;
  for (const [id, p] of launch()) {
    expect(reopened.get(id)!.x).toBeCloseTo(p.x, 5);
    expect(reopened.get(id)!.y).toBeCloseTo(p.y, 5);
  }
});
