// Speech bubbles in the garden (docs/design.md "Layout", "Speech bubbles"): a bubble shows its whole text, wrapping past
// 180px (120px inside a watch block), and is drawn above the birds; only the status lines of a row line up below the bubbles
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bubbleRoomFor, layoutBubbles, type BubbleBird, type LaidBird } from "../src/perch/garden-bubbles.ts";

const birds = (list: [string, number, boolean][]): BubbleBird[] => list.map(([id, y, bubble]) => ({ id, x: 0, y, bubble }));

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

  test("a bird in a block keeps no bubble room of its own outside the block's rows", () => {
    expect(bubbleRoomFor([{ id: "a", x: 0, y: 20, bubble: false }, { id: "b", x: 132, y: 20, bubble: true, inBlock: true }]).size).toBe(0);
  });
});

// Laying out the bubbles (layoutBubbles). A bird at x (center), y (top edge), whose icon spans 20-56px below its top, and
// whose bubble's text is textW px wide on one line: a fake measure wraps it at the max width, 17px a line + 4px padding
const bird = (id: string, x: number, textW: number, y = 20, inBlock = false): LaidBird & { textW: number } => ({
  id,
  x,
  y,
  iconTop: 20,
  iconBottom: 56,
  inBlock,
  textW,
});
const fit = (list: { id: string; textW: number }[]) => (id: string, max: number) => {
  const textW = list.find((b) => b.id === id)!.textW;
  return { w: Math.min(textW, max), h: Math.ceil(textW / max) * 17 + 4 };
};
const garden = { w: 703, h: 600 };
const lay = (list: (LaidBird & { textW: number })[], size = garden) => layoutBubbles(list, size, fit(list));
// Where a bubble ends up (left, right), and the horizontal gap between two (negative: they overlap)
const span = (b: { x: number }, place: { shift: number; w: number }) => [
  b.x + place.shift - place.w / 2,
  b.x + place.shift + place.w / 2,
];
const gap = (out: ReturnType<typeof layoutBubbles>, a: LaidBird, b: LaidBird) =>
  span(b, out.get(b.id)!)[0] - span(a, out.get(a.id)!)[1];

describe("layoutBubbles: max width", () => {
  test("a bird with no neighbour whose bubble overlaps vertically keeps 180px", () => {
    const out = lay([bird("a", 100, 400), bird("b", 232, 400, 300)]);
    expect(out.get("a")!.max).toBe(180);
    expect(out.get("b")!.max).toBe(180);
  });

  test("birds placed side by side (132px apart) get 124px and keep an 8px gap", () => {
    const list = [bird("a", 100, 400), bird("b", 232, 400)];
    const out = lay(list);
    expect(out.get("a")!.max).toBe(124);
    expect(out.get("b")!.max).toBe(124);
    expect(gap(out, list[0], list[1])).toBe(8);
  });

  test("three side by side: the outer bubbles grow on their free side up to the nearer half-distance", () => {
    const list = [bird("a", 100, 400), bird("b", 232, 400), bird("c", 464, 400)];
    const out = lay(list);
    expect(out.get("a")!.max).toBe(124);
    expect(out.get("b")!.max).toBe(124);
    expect(out.get("c")!.max).toBe(180);
    expect(gap(out, list[1], list[2])).toBeGreaterThanOrEqual(8);
  });

  test("a bubble in a watch block narrows its neighbour outside, though its own max stays 120px", () => {
    const out = lay([bird("owl", 218, 300), bird("web", 358, 300, 20, true)]);
    expect(out.get("owl")!.max).toBe(132);
    expect(out.get("web")!.max).toBe(120);
  });

  test("near the right edge the room to the edge plus the reach on the other side caps it", () => {
    const out = lay([bird("a", 639 - 132, 400), bird("b", 639, 400)]);
    // b is 60px inside the right edge (699): 60 + 66 - 4
    expect(out.get("b")!.max).toBe(122);
  });

  test("a wrapped bubble reaching down to the next row narrows the bubble there too (every line counts)", () => {
    // a is one row above b (60px apart), but its bubble wraps tall enough to reach b's bubble
    const tall = [bird("a", 100, 1200, 20), bird("b", 200, 400, 80)];
    const out = lay(tall);
    expect(out.get("b")!.max).toBeLessThan(180);
    expect(gap(out, tall[0], tall[1])).toBeGreaterThanOrEqual(8);
    // A one-line bubble there doesn't reach b's row: b keeps 180px
    expect(lay([bird("a", 100, 100, 20), bird("b", 200, 400, 80)]).get("b")!.max).toBe(180);
  });
});

describe("layoutBubbles: moving bubbles at the floor apart sideways", () => {
  test("the user's layout at 16:08: two bubbles 99.6px apart move apart and keep the 8px gap", () => {
    const list = [bird("owl", 182.8, 300, 19.3), bird("desk", 282.4, 300, 17.7, true)];
    const out = lay(list);
    expect(gap(out, list[0], list[1])).toBeCloseTo(8, 1);
    expect(out.get("owl")!.shift).toBeCloseTo(-14.2, 0);
    expect(out.get("desk")!.shift).toBeCloseTo(14.2, 0);
    for (const b of list) expect(Math.abs(out.get(b.id)!.shift)).toBeLessThanOrEqual(out.get(b.id)!.w / 2 - 12);
  });

  test("a chain of three: the outer ones move out, the middle one stays, and every gap is 8px", () => {
    const list = [bird("a", 200, 400), bird("b", 300, 400), bird("c", 400, 400)];
    const out = lay(list);
    expect(gap(out, list[0], list[1])).toBeCloseTo(8, 1);
    expect(gap(out, list[1], list[2])).toBeCloseTo(8, 1);
    expect(out.get("b")!.shift).toBeCloseTo(0, 1);
  });

  test("at the garden's edge the bubble stays inside, and its neighbour moves the rest of the way", () => {
    const list = [bird("a", 70, 400), bird("b", 170, 400)];
    const out = lay(list);
    expect(span(list[0], out.get("a")!)[0]).toBeGreaterThanOrEqual(4 - 1e-9);
    expect(gap(out, list[0], list[1])).toBeCloseTo(8, 1);
  });

  test("birds too close still overlap, but no bubble moves past its half-width less 12px", () => {
    const list = [bird("a", 300, 400), bird("b", 310, 400)];
    const out = lay(list);
    expect(gap(out, list[0], list[1])).toBeLessThan(0);
    for (const b of list) expect(Math.abs(out.get(b.id)!.shift)).toBeLessThanOrEqual(48 + 1e-9);
  });

  test("bubbles that don't overlap stay centered", () => {
    const out = lay([bird("a", 200, 400), bird("b", 332, 400), bird("c", 250, 100, 300)]);
    for (const id of ["a", "b", "c"]) expect(out.get(id)!.shift).toBe(0);
  });
});

describe("layoutBubbles: above the icon at the garden's bottom", () => {
  test("480x640 bubble-long: a 5-line bubble past the garden's bottom goes above the icon", () => {
    const out = layoutBubbles([bird("t", 379, 134 * 5, 478)], { w: 434, h: 591 }, () => ({ w: 134, h: 93 }));
    expect(out.get("t")!.above).toBe(true);
  });

  test("a bubble that fits below stays below; one that fits neither way goes where there is more room", () => {
    expect(lay([bird("a", 200, 100)]).get("a")!.above).toBe(false);
    const short = { w: 703, h: 312 };
    expect(layoutBubbles([bird("a", 200, 0, 150)], short, () => ({ w: 120, h: 200 })).get("a")!.above).toBe(true);
    expect(layoutBubbles([bird("a", 200, 0, 10)], short, () => ({ w: 120, h: 400 })).get("a")!.above).toBe(false);
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

  test("the concierge's bubble shows its whole text too, not cut after two lines (styles/concierge.css)", () => {
    const concierge = readFileSync(new URL("../src/perch/styles/concierge.css", import.meta.url), "utf8");
    expect(concierge).not.toContain("line-clamp");
  });
});
