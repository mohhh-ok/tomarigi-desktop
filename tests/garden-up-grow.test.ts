// While the window grows up for a bubble, the page keeps the anchor at y 1 until the Garden has seen the new size
// (docs/design.md "Layout"). The wait must end even when the garden's height never changes (a grow under 1 CSS px
// rounded away by clientHeight, or a resize that didn't happen), or every later resize stays stopped
import { describe, expect, test } from "bun:test";
import { UP_GROW_WAIT_MS, growsUpForBubble, upGrowDone, upGrowLeftMs } from "../src/perch/garden-up-grow.ts";

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

describe("upGrowLeftMs", () => {
  // The timer that ends the wait can fire a little early by Date.now (observed 999 ms); it must wait again for the rest,
  // as nothing else may come to end the wait
  test("fired early: the rest of the wait, until upGrowDone says done", () => {
    const early = 1000 + UP_GROW_WAIT_MS - 1;
    expect(upGrowDone(wait, 300, early)).toBe(false);
    expect(upGrowLeftMs(wait, early)).toBe(1);
  });

  test("timed out: 0", () => {
    expect(upGrowLeftMs(wait, 1000 + UP_GROW_WAIT_MS)).toBe(0);
    expect(upGrowLeftMs(wait, 1000 + UP_GROW_WAIT_MS + 50)).toBe(0);
  });
});

describe("growsUpForBubble", () => {
  const go = { active: true, held: false, dragging: false, growUp: 5 };

  test("a bubble past the garden's top: grows up", () => {
    expect(growsUpForBubble(go)).toBe(true);
  });

  // The anchor is the drag's until the drag ends; growing up would set it to y 1 under the drag
  test("while a drag grows the window: doesn't (decided by the fit after the drag)", () => {
    expect(growsUpForBubble({ ...go, dragging: true })).toBe(false);
  });

  test("another tab, held after a manual resize, or nothing past the top: doesn't", () => {
    expect(growsUpForBubble({ ...go, active: false })).toBe(false);
    expect(growsUpForBubble({ ...go, held: true })).toBe(false);
    expect(growsUpForBubble({ ...go, growUp: undefined })).toBe(false);
  });
});
