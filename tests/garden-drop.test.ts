// A bird or block the user drops stays where it was dropped, over other birds too, and reopening the Garden puts every
// bird where it was right after the drop, overlap included (docs/design.md "Layout"; issue #3)
import { describe, expect, test } from "bun:test";
import { hashId, positionsAfterDrop, type GardenPosition } from "../src/lib/garden-layout.ts";
import { gardenSimulate, type PlacedGarden } from "../src/lib/garden-fit.ts";
import { PLACE_EDGE_PX, placeBoxes, type PlaceBox, type Point } from "../src/lib/garden-place.ts";

const W = 480;
const H = 300;
const FOOT = { w: 120, h: 113 };
const ids = ["blog", "cloudflare-lab", "docs-migration", "figma-adapter", "moh-tech-net", "tomarigi"];

/** Places birds that all appear now, as garden.tsx does: by id, at the saved spot if any, else in a seeded cell; the
    ones the user placed (kept as is) after the rest */
function appear(saved: Record<string, GardenPosition>) {
  const boxes: PlaceBox[] = [...ids].sort().map((id) => {
    const p = saved[id];
    return p
      ? { id, ...FOOT, want: { x: (p.x / 100) * W - FOOT.w / 2, y: (p.y / 100) * H }, byUser: p.byUser }
      : { id, ...FOOT, seed: hashId(id) };
  });
  return placeBoxes([...boxes.filter((b) => !b.byUser), ...boxes.filter((b) => b.byUser)], W, H).at;
}

/** Drops one bird with its center and top at pointer, as garden.tsx does: birds on screen, then the drop */
function drop(shown: Map<string, Point>, id: string, pointer: Point) {
  const boxes: PlaceBox[] = [
    ...ids.filter((b) => b !== id).map((b) => ({ id: b, ...FOOT, at: shown.get(b)! })),
    { id, ...FOOT, want: { x: pointer.x - FOOT.w / 2, y: pointer.y }, byUser: true },
  ];
  return placeBoxes(boxes, W, H);
}

const centers = (at: Map<string, Point>) => new Map([...at].map(([id, p]) => [id, { x: p.x + FOOT.w / 2, y: p.y }]));
/** Birds that are more than half a px from where they were (the saved spots are % of the garden, so not exact) */
const movedFrom = (to: Map<string, Point>, from: Map<string, Point>) =>
  [...from].filter(([id, p]) => Math.abs(to.get(id)!.x - p.x) > 0.5 || Math.abs(to.get(id)!.y - p.y) > 0.5).map(([id]) => id);

// Each bird dropped onto the middle of each other bird
const first = appear({});
const cases = ids.flatMap((id) => ids.filter((o) => o !== id).map((onto) => [id, onto] as const));
const pointerOn = (onto: string) => {
  const target = first.get(onto)!;
  return { x: target.x + FOOT.w / 2 + 20, y: target.y + 10 };
};

describe("a bird dropped onto another stays where it was dropped, and nothing else moves", () => {
  test.each(cases)("%s dropped onto %s", (id, onto) => {
    const pointer = pointerOn(onto);
    const { at, overflow } = drop(first, id, pointer);
    // Kept inside the garden like every bird (a drop onto a bird at the right edge sticks out by the 20px offset)
    expect(at.get(id)).toEqual({
      x: Math.min(W - PLACE_EDGE_PX - FOOT.w, pointer.x - FOOT.w / 2),
      y: Math.min(H - PLACE_EDGE_PX - FOOT.h, pointer.y),
    });
    expect(movedFrom(at, new Map([...first].filter(([b]) => b !== id)))).toEqual([]);
    // The overlap the user made isn't "can't be placed", so the window doesn't grow for it
    expect(overflow).toEqual([]);
  });

  test("the issue's garden (520×420 window, preset=bubble): moh-tech-net dropped onto blog", () => {
    // The boxes garden.tsx placed (logged from the app): birds on screen, the drop, then docs-migration, which had no
    // free spot at this size and overlaps others, last
    const x = (center: number) => center - FOOT.w / 2;
    const shown: PlaceBox[] = [
      { id: "concierge", ...FOOT, at: { x: x(392.33), y: 159 } },
      { id: "figma-adapter", ...FOOT, at: { x: x(81.67), y: 159 } },
      { id: "tomarigi", ...FOOT, at: { x: x(392.33), y: 18 } },
      { id: "cloudflare-lab", ...FOOT, at: { x: x(81.67), y: 18 } },
      { id: "blog", ...FOOT, at: { x: x(237), y: 18 } },
    ];
    const want = { x: 202.55, y: 18 };
    const { at } = placeBoxes(
      [...shown, { id: "moh-tech-net", ...FOOT, want, byUser: true }, { id: "docs-migration", ...FOOT, at: { x: 64, y: 60.5 } }],
      474,
      290,
    );
    expect(at.get("moh-tech-net")).toEqual(want);
    for (const b of shown) expect(at.get(b.id)).toEqual(b.at!);
  });
});

describe("after a drop, reopening puts every bird where it was right after the drop, overlap included", () => {
  test.each(cases)("%s dropped onto %s", (id, onto) => {
    const after = drop(first, id, pointerOn(onto)).at;
    const saved = positionsAfterDrop({ prev: {}, settled: centers(after), byUser: new Set([id]), w: W, h: H });
    expect(movedFrom(appear(saved), after)).toEqual([]);
  });

  test("moh-tech-net saved over blog by the user opens over blog, and blog stays", () => {
    const shown = new Map(first);
    const blog = first.get("blog")!;
    shown.set("moh-tech-net", { x: blog.x + 20, y: blog.y + 10 });
    const saved = positionsAfterDrop({ prev: {}, settled: centers(shown), byUser: new Set(["moh-tech-net"]), w: W, h: H });
    expect(movedFrom(appear(saved), shown)).toEqual([]);
  });

  test("saved spots the user didn't place still come apart when they overlap", () => {
    const blog = first.get("blog")!;
    const saved: Record<string, GardenPosition> = {
      blog: { x: ((blog.x + FOOT.w / 2) / W) * 100, y: (blog.y / H) * 100 },
      tomarigi: { x: ((blog.x + FOOT.w / 2 + 20) / W) * 100, y: ((blog.y + 10) / H) * 100 },
    };
    const at = appear(saved);
    const t = at.get("tomarigi")!;
    const b = at.get("blog")!;
    expect(Math.abs(t.x - b.x) >= FOOT.w || Math.abs(t.y - b.y) >= FOOT.h).toBe(true);
  });
});

describe("the next render keeps a bird the user placed over another", () => {
  test("neither the placed bird nor the bird under it moves, whichever is placed first", () => {
    const blog = { x: 100, y: 20 };
    const placed = { x: 130, y: 30 };
    for (const order of [0, 1]) {
      const boxes: PlaceBox[] = [
        { id: "blog", ...FOOT, at: blog },
        { id: "moh", ...FOOT, at: placed, byUser: true },
      ];
      const { at, overflow } = placeBoxes(order ? boxes.reverse() : boxes, W, H);
      expect(at.get("blog")).toEqual(blog);
      expect(at.get("moh")).toEqual(placed);
      expect(overflow).toEqual([]);
    }
  });

  test("a bird that appears later avoids the placed bird's footprint", () => {
    const { at } = placeBoxes(
      [
        { id: "moh", ...FOOT, at: { x: 130, y: 30 }, byUser: true },
        { id: "new", ...FOOT, want: { x: 140, y: 40 } },
      ],
      W,
      H,
    );
    const n = at.get("new")!;
    expect(Math.abs(n.x - 130) >= FOOT.w || Math.abs(n.y - 30) >= FOOT.h).toBe(true);
  });

  test("a placed bird is kept inside the garden", () => {
    const { at } = placeBoxes([{ id: "moh", ...FOOT, at: { x: W - 20, y: H - 10 }, byUser: true }], W, H);
    const p = at.get("moh")!;
    expect(p.x + FOOT.w).toBeLessThanOrEqual(W);
    expect(p.y + FOOT.h).toBeLessThanOrEqual(H);
  });
});

describe("watch blocks and the user's drops", () => {
  const block = { id: "root", w: 260, h: 120 };
  test("a bird dropped over a watch block stays where it was dropped (preset=watching: blog onto the block)", () => {
    const want = { x: 150, y: 30 };
    const { at, overflow } = placeBoxes(
      [
        { ...block, at: { x: 20, y: 10 } },
        { id: "blog", ...FOOT, want, byUser: true },
      ],
      W,
      H,
    );
    expect(at.get("root")).toEqual({ x: 20, y: 10 });
    expect(at.get("blog")).toEqual(want);
    expect(overflow).toEqual([]);
  });

  test("a block dropped onto a bird stays where it was dropped; the bird doesn't move", () => {
    const want = { x: 60, y: 40 };
    const { at } = placeBoxes(
      [
        { id: "blog", ...FOOT, at: { x: 100, y: 60 } },
        { ...block, want, byUser: true },
      ],
      W,
      H,
    );
    expect(at.get("root")).toEqual(want);
    expect(at.get("blog")).toEqual({ x: 100, y: 60 });
  });
});

describe("trying other window sizes counts a bird the user placed as placed", () => {
  test("no overflow and nothing moved at the same size", () => {
    const settled: PlaceBox[] = [
      { id: "blog", ...FOOT, at: { x: 100, y: 20 } },
      { id: "moh", ...FOOT, at: { x: 130, y: 30 }, byUser: true },
    ];
    const placed: PlacedGarden = {
      settled,
      heightAt: new Map(),
      glyph: 40,
      count: 2,
      w: W,
      h: H,
      anchor: { x: 0, y: 0 },
      overflowIds: new Set(),
    };
    const { overflow, moved } = gardenSimulate(placed, W, H);
    expect(overflow).toBe(0);
    expect(moved).toBe(0);
  });
});
