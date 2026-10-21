// A bird the user dragged is drawn in front of every other bird and bubble, with its bubble, status lines and marks; the
// last dragged frontmost, saved with the positions (docs/design.md "Layout")
import { describe, expect, test } from "bun:test";
import { frontRanks, positionsAfterDrop, type GardenPosition } from "../src/lib/garden-layout.ts";
import { BUBBLE_LAYER_Z, gardenStack } from "../src/perch/garden-stack.ts";

const at = (x: number, y: number) => ({ x, y });

describe("the order of dragged birds is saved with the positions", () => {
  test("a dropped bird comes in front of the ones dropped before, and the others keep theirs", () => {
    const prev: Record<string, GardenPosition> = {
      blog: { x: 10, y: 10, byUser: true, front: 1 },
      tomarigi: { x: 50, y: 10 },
    };
    const next = positionsAfterDrop({
      prev,
      settled: new Map([["blog", at(40, 30)], ["tomarigi", at(200, 30)], ["figma", at(60, 40)]]),
      byUser: new Set(["figma"]),
      front: new Set(["figma"]),
      w: 400,
      h: 300,
    });
    expect(next.figma.front).toBe(2);
    expect(next.blog.front).toBe(1);
    expect(next.tomarigi.front).toBeUndefined();
    expect([...frontRanks(next)]).toEqual([["blog", 1], ["figma", 2]]);
  });

  test("dragging an earlier bird again brings it to the front", () => {
    const prev: Record<string, GardenPosition> = {
      blog: { x: 10, y: 10, front: 1 },
      figma: { x: 12, y: 12, front: 2 },
    };
    const next = positionsAfterDrop({
      prev,
      settled: new Map([["blog", at(40, 30)], ["figma", at(48, 36)]]),
      byUser: new Set(["blog"]),
      front: new Set(["blog"]),
      w: 400,
      h: 300,
    });
    expect([...frontRanks(next)].map(([id]) => id)).toEqual(["figma", "blog"]);
  });

  test("the birds of a dropped block come in front together", () => {
    const next = positionsAfterDrop({
      prev: {},
      settled: new Map([["a", at(10, 10)], ["b", at(150, 10)], ["c", at(300, 10)]]),
      byUser: new Set(["a", "b"]),
      front: new Set(["a", "b"]),
      w: 400,
      h: 300,
    });
    expect(next.a.front).toBe(1);
    expect(next.b.front).toBe(1);
    expect(next.c.front).toBeUndefined();
  });
});

describe("gardenStack", () => {
  test("a bird never dragged stays under the bubble layer; its bubble is in the layer by the turn order", () => {
    const s = gardenStack({ dragging: false, bubbleOrder: 3 });
    expect(s.node).toBeLessThan(BUBBLE_LAYER_Z);
    expect(s.bubbleInLayer).toBe(true);
    expect(s.bubble).toBe(3);
  });

  test("a dragged bird is above every bubble, and its own bubble above it", () => {
    const s = gardenStack({ dragging: false, front: 1, bubbleOrder: 1 });
    expect(s.node).toBeGreaterThan(BUBBLE_LAYER_Z);
    expect(s.bubbleInLayer).toBe(false);
    expect(s.bubble).toBeGreaterThan(s.node);
  });

  test("the last dragged bird is in front of the one dragged before, bubble included", () => {
    const earlier = gardenStack({ dragging: false, front: 1, bubbleOrder: 5 });
    const later = gardenStack({ dragging: false, front: 2, bubbleOrder: 1 });
    expect(later.node).toBeGreaterThan(earlier.bubble);
  });

  test("while dragged, a bird is in front of every dropped one", () => {
    const dropped = gardenStack({ dragging: false, front: 99, bubbleOrder: 1 });
    const dragged = gardenStack({ dragging: true, bubbleOrder: 1 });
    expect(dragged.node).toBeGreaterThan(dropped.bubble);
    expect(dragged.bubble).toBeGreaterThan(dragged.node);
    expect(dragged.bubbleInLayer).toBe(false);
  });
});
