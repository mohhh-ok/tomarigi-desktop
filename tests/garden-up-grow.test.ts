// While the window grows up for a bubble, the page keeps the anchor at y 1 until the Garden has seen the new size
// (docs/design.md "Layout"). The wait must end even when the garden's height never changes (a grow under 1 CSS px
// rounded away by clientHeight, or a resize that didn't happen), or every later resize stays stopped
import { describe, expect, test } from "bun:test";
import { UP_GROW_WAIT_MS, upGrowDone } from "../src/perch/garden-up-grow.ts";

const wait = { gardenH: 300, since: 1000 };

describe("upGrowDone", () => {
  test("the garden's height is the same right after asking: keeps waiting", () => {
    expect(upGrowDone(wait, 300, 1100)).toBe(false);
  });

  test("the Garden saw the new size: done", () => {
    expect(upGrowDone(wait, 302, 1100)).toBe(true);
  });

  test("no fit yet (the Garden isn't shown): keeps waiting", () => {
    expect(upGrowDone(wait, undefined, 1100)).toBe(false);
  });

  test("the height never changes: done after UP_GROW_WAIT_MS", () => {
    expect(upGrowDone(wait, 300, 1000 + UP_GROW_WAIT_MS - 1)).toBe(false);
    expect(upGrowDone(wait, 300, 1000 + UP_GROW_WAIT_MS)).toBe(true);
    expect(upGrowDone(wait, undefined, 1000 + UP_GROW_WAIT_MS)).toBe(true);
  });
});
