// A bird dropped against another settles beside it, and reopening the Garden puts every bird where it was right after
// the drop (docs/design.md "Layout"; a UI check found the dropped bird and untouched ones elsewhere after a reload)
import { describe, expect, test } from "bun:test";
import { hashId, positionsAfterDrop, type GardenPosition } from "../src/lib/garden-layout.ts";
import { placeBoxes, type PlaceBox, type Point } from "../src/lib/garden-place.ts";

const W = 480;
const H = 300;
const FOOT = { w: 120, h: 113 };
const ids = ["blog", "cloudflare-lab", "docs-migration", "figma-adapter", "moh-tech-net", "tomarigi"];

/** Places birds that all appear now, as garden.tsx does: by id, at the saved spot if any, else in a seeded cell */
function appear(saved: Record<string, GardenPosition>) {
  const boxes: PlaceBox[] = [...ids].sort().map((id) => {
    const p = saved[id];
    return p
      ? { id, ...FOOT, want: { x: (p.x / 100) * W - FOOT.w / 2, y: (p.y / 100) * H } }
      : { id, ...FOOT, seed: hashId(id) };
  });
  return placeBoxes(boxes, W, H).at;
}

/** Drops one bird with its center and top at pointer, as garden.tsx does: birds on screen first, then the drop */
function drop(shown: Map<string, Point>, id: string, pointer: Point) {
  const boxes: PlaceBox[] = [
    ...ids.filter((b) => b !== id).map((b) => ({ id: b, ...FOOT, at: shown.get(b)! })),
    { id, ...FOOT, want: { x: pointer.x - FOOT.w / 2, y: pointer.y } },
  ];
  return placeBoxes(boxes, W, H).at;
}

const centers = (at: Map<string, Point>) => new Map([...at].map(([id, p]) => [id, { x: p.x + FOOT.w / 2, y: p.y }]));
/** Birds that are more than half a px from where they were (the saved spots are % of the garden, so not exact) */
const movedFrom = (to: Map<string, Point>, from: Map<string, Point>) =>
  [...from].filter(([id, p]) => Math.abs(to.get(id)!.x - p.x) > 0.5 || Math.abs(to.get(id)!.y - p.y) > 0.5).map(([id]) => id);

describe("after a drop, reopening puts every bird where it was right after the drop", () => {
  const first = appear({});
  // Each bird dropped onto the middle of each other bird, so it settles beside it
  const cases = ids.flatMap((id) => ids.filter((o) => o !== id).map((onto) => [id, onto] as const));
  test.each(cases)("%s dropped onto %s", (id, onto) => {
    const target = first.get(onto)!;
    const pointer = { x: target.x + FOOT.w / 2 + 20, y: target.y + 10 };
    const after = drop(first, id, pointer);
    const saved = positionsAfterDrop({ prev: {}, settled: centers(after), w: W, h: H });
    expect(movedFrom(appear(saved), after)).toEqual([]);
  });
});
