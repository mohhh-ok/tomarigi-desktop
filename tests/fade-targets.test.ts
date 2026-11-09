// What takes clicks at rest in "Fade until hovered" (docs/design.md "Platforms"; src/perch/fade-targets.ts): the
// concierge's speech bubble over its whole box, its empty space included, in the Garden and in the Concierge tab
import { describe, expect, test } from "bun:test";
import { birdRect, type Edges, type FadeRect, type MeasuredTarget, targetRects } from "../src/perch/fade-targets.ts";

const edges = (left: number, top: number, right: number, bottom: number): Edges => ({ left, top, right, bottom });

// The same test as BirdRect::contains in src-tauri/src/fade.rs, which decides on the rectangles sent
const hit = (rects: FadeRect[], x: number, y: number) =>
  rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);

// "Tomarigi" in the header: a handle, one line
const handle: MeasuredTarget = { box: edges(8, 4, 80, 20), lines: [edges(8, 4, 80, 20)], whole: false };
// The concierge's bubble: a 200x80 box whose text fills the first line and half the second (.fade-box)
const bubbleBox = edges(20, 100, 220, 180);
const bubbleLines = [edges(27, 102, 213, 117), edges(27, 117, 120, 132)];
const gardenBubble: MeasuredTarget = { box: bubbleBox, lines: bubbleLines, whole: true };
// The Concierge tab: a session name wrapped onto two lines inside the bubble (.fade-target)
const wrappedName: MeasuredTarget = {
  box: edges(27, 140, 213, 170),
  lines: [edges(150, 140, 213, 155), edges(27, 155, 70, 170)],
  whole: false,
};
const bird = birdRect(edges(100, 40, 140, 80), [edges(132, 34, 146, 48)]);

const scenes: { scene: string; targets: MeasuredTarget[] }[] = [
  { scene: "Garden", targets: [handle, gardenBubble] },
  { scene: "Concierge tab", targets: [handle, gardenBubble, wrappedName] },
];

describe.each(scenes)("$scene at rest", ({ targets }) => {
  const rects = [...(bird ? [bird] : []), ...targetRects(targets)];
  test.each([
    ["the bubble's empty space, right of the second line", 200, 125, true],
    ["the bubble's empty space, under its text", 40, 175, true],
    ["the bubble's corner (left and top edges are in)", 20, 100, true],
    ["the bubble's text", 50, 110, true],
    ["just past the bubble's right edge", 220, 140, false],
    ["just past the bubble's bottom edge", 100, 180, false],
    ["beside the bubble", 240, 140, false],
    ["the bird", 120, 60, true],
    ["the bird's badge sticking out of it", 144, 36, true],
    ["the handle", 40, 12, true],
    ["the empty window between the handle and the bubble", 40, 60, false],
  ] as const)("%s → takes clicks: %p", (_, x, y, want) => {
    expect(hit(rects, x, y)).toBe(want);
  });
});

test("a name wrapped onto two lines takes clicks on its text only, not between its parts", () => {
  const rects = targetRects([wrappedName]);
  expect(rects).toHaveLength(2);
  expect(hit(rects, 160, 145)).toBe(true);
  expect(hit(rects, 100, 145)).toBe(false);
});

test("a box that isn't laid out takes no clicks", () => {
  expect(targetRects([{ box: edges(0, 0, 0, 0), lines: [], whole: true }])).toEqual([]);
  expect(birdRect(edges(10, 10, 10, 30), [])).toBeNull();
});
