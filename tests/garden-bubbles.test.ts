// Speech bubbles in the garden (docs/design.md "Layout", "Speech bubbles"): a bubble shows its whole text, wrapping past
// 180px (120px inside a watch block), and is drawn above the birds; only the status lines of a row line up below the bubbles
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bubbleMaxWidths, bubbleRoomFor, type BubbleBird } from "../src/perch/garden-bubbles.ts";

const birds = (list: [string, number, boolean][]): BubbleBird[] => list.map(([id, y, bubble]) => ({ id, x: 0, y, bubble }));
// Birds at x (center) and y (top edge)
const placed = (list: [string, number, number, boolean][]): BubbleBird[] =>
  list.map(([id, x, y, bubble]) => ({ id, x, y, bubble }));

describe("bubbleRoomFor", () => {
  test("in one row, birds without a bubble keep the bubble room, so the status lines line up", () => {
    const room = bubbleRoomFor(birds([["a", 20, true], ["b", 20, false], ["c", 30, false]]));
    expect([...room].sort()).toEqual(["b", "c"]);
  });

  test("a bird off the row keeps no bubble room, even when a bubble covers its status lines", () => {
    expect(bubbleRoomFor(birds([["a", 20, true], ["b", 40, false]])).size).toBe(0);
  });

  test("birds with a bubble aren't listed (they have their own room)", () => {
    expect(bubbleRoomFor(birds([["a", 20, true], ["b", 20, true]])).size).toBe(0);
  });
});

describe("bubbleMaxWidths", () => {
  test("a bird with no neighbour with a bubble in its row keeps 180px", () => {
    const max = bubbleMaxWidths(placed([["a", 100, 20, true], ["b", 232, 20, false], ["c", 232, 200, true]]));
    expect(max.get("a")).toBe(180);
    expect(max.get("c")).toBe(180);
  });

  test("birds placed side by side (132px apart) get 132px, so two long bubbles don't overlap", () => {
    const max = bubbleMaxWidths(placed([["a", 100, 20, true], ["b", 232, 20, true]]));
    expect(max.get("a")).toBe(132);
    expect(max.get("b")).toBe(132);
    // Each reaches at most halfway: 100 + 66 = 232 - 66
    expect(100 + max.get("a")! / 2).toBeLessThanOrEqual(232 - max.get("b")! / 2);
  });

  test("three side by side: none overlaps, the middle one takes the nearer side", () => {
    const max = bubbleMaxWidths(placed([["a", 100, 20, true], ["b", 232, 25, true], ["c", 464, 18, true]]));
    expect(max.get("a")).toBe(132);
    expect(max.get("b")).toBe(132);
    expect(max.get("c")).toBe(180);
    expect(100 + max.get("a")! / 2).toBeLessThanOrEqual(232 - max.get("b")! / 2);
    expect(232 + max.get("b")! / 2).toBeLessThanOrEqual(464 - max.get("c")! / 2);
  });

  test("never below 120px, even for birds dropped close together", () => {
    const max = bubbleMaxWidths(placed([["a", 100, 20, true], ["b", 160, 20, true], ["c", 160, 20, true]]));
    expect(max.get("a")).toBe(120);
    expect(max.get("b")).toBe(120);
    expect(max.get("c")).toBe(120);
  });

  test("birds without a bubble, off the row, or past the nearest one don't narrow it", () => {
    const max = bubbleMaxWidths(
      placed([["a", 100, 20, true], ["b", 250, 20, false], ["c", 250, 33, true], ["d", 400, 20, true], ["e", 255, 20, true]]),
    );
    // a's nearest neighbour with a bubble on the right is e (155px), not b (no bubble) or c (13px lower)
    expect(max.get("a")).toBe(155);
    expect(max.has("b")).toBe(false);
  });
});

describe("bubbleMaxWidths near the garden's edge", () => {
  // The garden's bubble range (inside the frame): a bubble is pushed to stay within it
  const range = { lo: 4, hi: 600 };
  // Where a bubble of width w under a bird at x ends up after the push (.speech-bubble-below's transform)
  const span = (x: number, w: number) => {
    const left = Math.min(Math.max(x - w / 2, range.lo), range.hi - w);
    return [left, left + w];
  };

  test("a bubble pushed left by the right edge narrows so it stays short of halfway to its left neighbour", () => {
    // b is 60px inside the right edge: at 132px it would be pushed 6px left, over a's bubble
    const max = bubbleMaxWidths(placed([["a", 408, 20, true], ["b", 540, 20, true]]), range);
    expect(max.get("b")).toBe(60 + 66);
    expect(max.get("a")).toBe(132);
  });

  test("the same on the left edge, and a bird with no neighbour keeps 180px at the edge", () => {
    const max = bubbleMaxWidths(placed([["a", 44, 20, true], ["b", 176, 20, true], ["c", 20, 200, true]]), range);
    // a is 40px inside the left edge: room 40 + half-distance 66 is below the floor, so 120px
    expect(max.get("a")).toBe(120);
    expect(max.get("c")).toBe(180);
  });

  test("bubbles side by side near the edge don't overlap once pushed", () => {
    // b is 60px inside the right edge, so its bubble is pushed left
    const xs = [408, 540];
    const max = bubbleMaxWidths(placed([["a", xs[0], 20, true], ["b", xs[1], 20, true]]), range);
    const [, aRight] = span(xs[0], max.get("a")!);
    const [bLeft] = span(xs[1], max.get("b")!);
    expect(aRight).toBeLessThanOrEqual(bLeft);
  });
});

// The garden's bubble is sized// The garden's bubble is sized and wrapped by CSS (styles/speech-bubble.css), so read the rules it uses
const css = readFileSync(new URL("../src/perch/styles/speech-bubble.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return undefined;
  return css.slice(at, css.indexOf("}", at));
};

describe("the garden's speech bubble (styles/speech-bubble.css)", () => {
  test("shows the whole text: wraps onto more lines instead of cutting with '…'", () => {
    const body = rule(".speech-bubble-below .speech-bubble");
    expect(body).toBeDefined();
    expect(body).toContain("white-space: normal");
    expect(body).toContain("overflow: visible");
    expect(body).toContain("text-overflow: clip");
  });

  test("is as wide as its text up to 180px", () => {
    const body = rule(".speech-bubble-below")!;
    expect(body).toContain("width: max-content");
    expect(body).toContain("--bubble-max: 180px");
  });

  test("inside a watch block the bubble is at most a bird's width (120px), so neighbours' bubbles don't overlap", () => {
    const body = rule(".garden-bubble-anchor.in-watch-block .speech-bubble-below");
    expect(body).toBeDefined();
    expect(body).toContain("--bubble-max: 120px");
  });
});
