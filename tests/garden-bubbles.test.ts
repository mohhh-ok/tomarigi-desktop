// Speech bubbles in the garden (docs/design.md "Layout", "Speech bubbles"): a bubble shows its whole text, wrapping past
// 180px (120px inside a watch block), and is drawn above the birds; only the status lines of a row line up below the bubbles
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bubbleRoomFor, type BubbleBird } from "../src/perch/garden-bubbles.ts";

const birds = (list: [string, number, boolean][]): BubbleBird[] => list.map(([id, y, bubble]) => ({ id, y, bubble }));

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

// The garden's bubble is sized and wrapped by CSS (styles/speech-bubble.css), so read the rules it uses
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
