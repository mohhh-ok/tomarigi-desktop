// While a bird or block is dragged, the window grows toward the garden's edge the pointer is near or past (docs/design.md
// "Layout"). The page tells the Rust side where the garden's edges are, and keeps the birds on screen with the anchor
import { describe, expect, test } from "bun:test";
import { dragGrowRequest } from "../src/perch/garden-drag-grow.ts";

// A 520×420 window whose garden is below the header and tabs
const garden = { left: 20, top: 120, right: 500, bottom: 400 };
const view = { width: 520, height: 420 };

describe("dragGrowRequest", () => {
  test("in the middle of the garden, nothing grows", () => {
    expect(dragGrowRequest({ x: 260, y: 260 }, garden, view)).toBeUndefined();
  });

  test("near the right edge: grows right, keeping the left edge", () => {
    const r = dragGrowRequest({ x: 490, y: 260 }, garden, view)!;
    expect(r.anchor).toEqual({ x: 0, y: 0 });
    expect(r.insets).toEqual({ left: 20, top: 120, right: 20, bottom: 20 });
  });

  test("past the left edge: grows left, keeping the right edge", () => {
    expect(dragGrowRequest({ x: -30, y: 260 }, garden, view)!.anchor).toEqual({ x: 1, y: 0 });
  });

  test("near the top of the garden (below the tabs): grows up, keeping the bottom edge", () => {
    expect(dragGrowRequest({ x: 260, y: 130 }, garden, view)!.anchor).toEqual({ x: 0, y: 1 });
  });

  test("a garden taller than the window counts its edge at the window's bottom", () => {
    const tall = { ...garden, bottom: 900 };
    const r = dragGrowRequest({ x: 260, y: 410 }, tall, view)!;
    expect(r.anchor).toEqual({ x: 0, y: 0 });
    expect(r.insets.bottom).toBe(0);
  });
});
