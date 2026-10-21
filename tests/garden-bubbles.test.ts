// How far the speech bubbles of birds outside a block reach (docs/design.md "Layout"): a bird's footprint is a bird's
// width, and a bubble may reach into a neighbour's footprint but not over its icon and marks, its bubble, or a watch block
import { describe, expect, test } from "bun:test";
import { PLACE_GAP_PX } from "../src/lib/garden-place.ts";
import { bubbleSpace, reach, type BubbleBird } from "../src/perch/garden-bubbles.ts";
import { BUBBLE_MAX_PX, NODE_WIDTH_PX } from "../src/perch/garden-watch-layout.ts";

const G = 40;
const NAME = 16;
const frame = { lo: 4, hi: 996 };
// Neighbours in one row of the grid: one footprint plus the gap apart
const STEP = NODE_WIDTH_PX + PLACE_GAP_PX;
const row = (bubbles: boolean[], y = 20): BubbleBird[] =>
  bubbles.map((bubble, i) => ({ id: `b${i}`, x: 300 + i * STEP, y, bubble }));

describe("bubbleSpace", () => {
  test("a lone bird's bubble gets the widest bubble, centered under it", () => {
    const { ranges } = bubbleSpace(row([true]), [], G, NAME, frame);
    const [l, r] = reach(300, ranges.get("b0")!);
    expect(r - l).toBe(BUBBLE_MAX_PX);
    expect((l + r) / 2).toBe(300);
  });

  test("a bubble reaches past the bird's footprint into a neighbour's without a bubble", () => {
    const { ranges } = bubbleSpace(row([true, false]), [], G, NAME, frame);
    const [, r] = reach(300, ranges.get("b0")!);
    expect(r).toBeGreaterThan(300 + NODE_WIDTH_PX / 2 + PLACE_GAP_PX);
  });

  test("the neighbour under the bubble keeps the bubble room, so its status lines go below the bubble", () => {
    // A little lower than the bird with the bubble, so not in its row
    const birds = row([true, false, false]).map((b, i) => (i === 0 ? b : { ...b, y: b.y + 20 }));
    const { roomFor } = bubbleSpace(birds, [], G, NAME, frame);
    expect(roomFor.has("b1")).toBe(true);
    // Too far for the widest bubble to reach
    expect(roomFor.has("b2")).toBe(false);
  });

  test("two bubbles side by side never overlap, in a row of three", () => {
    const birds = row([true, true, true]);
    const { ranges, roomFor } = bubbleSpace(birds, [], G, NAME, frame);
    const spans = birds.map((b) => reach(b.x, ranges.get(b.id)!));
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    expect(roomFor.size).toBe(0);
  });

  test("a bubble stops short of the icon and marks of a bird a little lower beside it", () => {
    // The neighbour's icon is level with the bubble
    const birds: BubbleBird[] = [
      { id: "a", x: 300, y: 20, bubble: true },
      { id: "b", x: 300 + STEP, y: 20 + G, bubble: false },
    ];
    const { ranges } = bubbleSpace(birds, [], G, NAME, frame);
    const [, r] = reach(300, ranges.get("a")!);
    // The "?" sticks out about half the icon on the right, the anger mark on the left
    expect(r).toBeLessThanOrEqual(300 + STEP - G);
  });

  test("a bubble doesn't reach into a watch block beside it", () => {
    const block = { x: 300 + NODE_WIDTH_PX / 2 + PLACE_GAP_PX, y: 0, w: 280, h: 280 };
    const { ranges } = bubbleSpace(row([true]), [block], G, NAME, frame);
    const [, r] = reach(300, ranges.get("b0")!);
    expect(r).toBeLessThanOrEqual(block.x);
  });

  test("near the garden's edge the bubble is pushed inside, keeping its tail under the bird", () => {
    const { ranges } = bubbleSpace([{ id: "a", x: 64, y: 20, bubble: true }], [], G, NAME, frame);
    const range = ranges.get("a")!;
    const [l, r] = reach(64, range);
    expect(l).toBe(frame.lo);
    expect(r - l).toBe(BUBBLE_MAX_PX);
    expect(range.lo).toBeLessThan(64);
  });

  test("beside a short bubble, a long one takes the room the short one doesn't need", () => {
    const birds = row([true, true]).map((b, i) => ({ ...b, bubbleW: i === 0 ? 40 : BUBBLE_MAX_PX }));
    const { ranges } = bubbleSpace(birds, [], G, NAME, frame);
    const [, r0] = reach(birds[0].x, ranges.get("b0")!, 40);
    const [l1, r1] = reach(birds[1].x, ranges.get("b1")!, BUBBLE_MAX_PX);
    expect(r1 - l1).toBe(BUBBLE_MAX_PX);
    expect(l1).toBeGreaterThanOrEqual(r0);
  });

  test("in one row, birds without a bubble keep the bubble room, so the status lines line up", () => {
    const birds = row([true, false, false]).map((b, i) => (i === 0 ? { ...b, bubbleW: 60 } : { ...b, statusW: 70 }));
    expect([...bubbleSpace(birds, [], G, NAME, frame).roomFor].sort()).toEqual(["b1", "b2"]);
  });

  test("off the row, a neighbour's status lines stay up when the bubble's text doesn't reach them", () => {
    const birds = row([true, false]).map((b, i) => (i === 0 ? { ...b, bubbleW: 60 } : { ...b, y: b.y + 20, statusW: 70 }));
    expect(bubbleSpace(birds, [], G, NAME, frame).roomFor.size).toBe(0);
    const wide = birds.map((b, i) => (i === 0 ? { ...b, bubbleW: BUBBLE_MAX_PX } : { ...b, statusW: NODE_WIDTH_PX }));
    expect(bubbleSpace(wide, [], G, NAME, frame).roomFor.has("b1")).toBe(true);
  });

  test("birds at uneven heights (dragged): no bubble reaches a neighbour's status lines where they end up", () => {
    // As a UI check found after dragging and reopening: a working bird a little higher than two birds with bubbles
    const g = 30;
    const birds: BubbleBird[] = [
      { id: "docs", x: 84, y: 131, bubble: false, statusW: 96 },
      { id: "moh", x: 180, y: 161, bubble: true, bubbleW: 150, statusW: 52 },
      { id: "tomarigi", x: 335, y: 145, bubble: true, bubbleW: 180, statusW: 84 },
    ];
    const { ranges, roomFor } = bubbleSpace(birds, [], g, NAME, frame);
    for (const a of birds) {
      if (!a.bubble) continue;
      const [l, r] = reach(a.x, ranges.get(a.id)!, a.bubbleW);
      const top = a.y + NAME + g;
      for (const b of birds) {
        if (b === a) continue;
        const st = b.y + NAME + g + (b.bubble || roomFor.has(b.id) ? 26 : 0);
        const level = top < st + 34 && st < top + 26;
        const half = b.statusW! / 2;
        if (level) expect(r <= b.x - half || l >= b.x + half).toBe(true);
      }
    }
  });
});
