// How far the floating window grows so the Garden's birds fit (docs/design.md "Layout"). The direction and the cap at
// the display's visible area are tested on the Rust side (grow_frame in src-tauri/src/garden_grow.rs)
import {
  GARDEN_MIN_HEIGHT_PX,
  gardenFits,
  gardenFitScale,
  gardenGlyphSize,
  MAX_FIT_SCALE,
  gardenSimulate,
  nextGrowScale,
  ROUNDING_PX,
  type GardenFit,
  type PlacedGarden,
} from "../src/lib/garden-fit.ts";
import { PLACE_EDGE_PX, PLACE_GAP_PX, placeBoxes, type PlaceBox, type Point } from "../src/lib/garden-place.ts";
import { hashId } from "../src/lib/garden-layout.ts";

// count birds with no blocks (each 120 wide, 87 + icon tall), header and tabs about 80px tall
const fit = (count: number, extra: Partial<GardenFit> = {}): GardenFit => ({
  count,
  boxes: Array.from({ length: count }, () => ({ w: 120, h0: 87, rows: 1 })),
  overflow: false,
  overflowW: 0,
  overflowH: 0,
  gardenW: 318,
  gardenH: 320,
  overheadW: 22,
  overheadH: 80,
  ...extra,
});
const over = (count: number) => fit(count, { overflow: true, overflowW: 120, overflowH: 113 });

describe("gardenGlyphSize", () => {
  test("never below 26px however many birds", () => {
    expect(gardenGlyphSize(300, 220, 40)).toBe(26);
  });
  test("never above 52px", () => {
    expect(gardenGlyphSize(2000, 2000, 1)).toBe(52);
  });
});

describe("gardenFits", () => {
  test("4 birds fit in a 318x320 garden (2 by 2), 5 don't", () => {
    expect(gardenFits(318, 320, fit(4))).toBe(true);
    expect(gardenFits(318, 320, fit(5))).toBe(false);
  });
  test("never below the garden's min-height", () => {
    expect(gardenFits(318, GARDEN_MIN_HEIGHT_PX - 1, fit(1))).toBe(false);
  });
});

describe("gardenFitScale", () => {
  test("nothing overflowed: never grows, even if an estimate would say so (the user's report: sparse birds)", () => {
    expect(gardenFitScale(340, 400, fit(6), 1)).toBe(1);
    expect(gardenFitScale(340, 400, fit(6), 1.3)).toBeLessThanOrEqual(1.3);
  });

  test("birds left: the scale they need now, so the window can shrink back (not below the user's size)", () => {
    expect(gardenFitScale(340, 400, fit(1), 1.5)).toBe(1);
  });

  test("overflow: grows enough for them to fit, and one step less doesn't", () => {
    const f = over(6);
    const s = gardenFitScale(340, 400, f, 1);
    expect(s).toBeGreaterThan(1);
    expect(gardenFits(340 * s - f.overheadW, 400 * s - f.overheadH, f)).toBe(true);
  });

  test("overflow with room in an empty garden: still opens a strip for the bird that had no spot (the others stay)", () => {
    const s = gardenFitScale(340, 400, over(4), 1);
    // A strip as wide as the bird: (120 + gap) / 340 of the width, or as tall: (113 + gap) / 400 of the height
    expect(s).toBeGreaterThanOrEqual(1 + Math.min(132 / 340, 125 / 400) - 1e-9);
    expect(s).toBeLessThan(1.4);
  });

  test("birds that never fit: the upper end (the Rust side caps it at the display)", () => {
    const f = over(1);
    f.boxes = [{ w: 5000, h0: 87, rows: 1 }];
    expect(gardenFitScale(340, 400, f, 1)).toBe(MAX_FIT_SCALE);
  });

  test("an unmeasured window stays at the user's size", () => {
    expect(gardenFitScale(0, 0, over(8))).toBe(1);
  });
});

describe("gardenFitScale with the actual placement (simulate)", () => {
  // A garden that places everything from 400px wide on, and keeps everyone in place from 380px on
  const sim = (w: number) => ({ overflow: w >= 400 ? 0 : 1, moved: w >= 380 ? 0 : 2 });
  const withSim = (overflow: boolean) => ({ ...fit(5, { overflow }), simulate: (w: number) => sim(w) });

  test("overflow: the smallest scale where everything has a spot and nobody moves", () => {
    // 340 * s - 22 - 1 (ROUNDING_PX) >= 400 → s >= 1.2441 → 1.26 on the 0.02 steps
    expect(gardenFitScale(340, 400, withSim(true), 1)).toBe(1.26);
  });

  test("nothing overflowed: never grows; shrinks back as far as everything has a spot, even if some must move", () => {
    expect(gardenFitScale(340, 400, withSim(false), 1)).toBe(1);
    // A garden that places everything from 350px wide on, and keeps everyone in place only from 400px on
    const f = { ...fit(5), simulate: (w: number) => ({ overflow: w >= 350 ? 0 : 1, moved: w >= 400 ? 0 : 2 }) };
    // From 1.5: the smallest s with 340 * s - 22 - 1 >= 350 is 1.0971 → 1.1 on the 0.02 steps (not 1.26, where nobody moves)
    expect(gardenFitScale(340, 400, f, 1.5)).toBe(1.1);
  });
});

describe("nextGrowScale", () => {
  const kept = { scale: 1.34, count: 5, userW: 340, userH: 400 };
  test("the same number of birds needing less: stays at the current size", () => {
    expect(nextGrowScale(kept, 1.26, 5, 340, 400)).toBe(1.34);
  });
  test("the same number of birds needing more: grows at once", () => {
    expect(nextGrowScale(kept, 1.4, 5, 340, 400)).toBe(1.4);
  });
  test("birds left: shrinks to the scale needed now", () => {
    expect(nextGrowScale(kept, 1.1, 4, 340, 400)).toBe(1.1);
  });
  test("birds left and none needed: back to the user's size, not below", () => {
    expect(nextGrowScale(kept, 1, 2, 340, 400)).toBe(1);
  });
  test("birds joined needing more: grows", () => {
    expect(nextGrowScale(kept, 1.5, 6, 340, 400)).toBe(1.5);
  });
  test("nothing applied yet: the needed scale", () => {
    expect(nextGrowScale(null, 1.2, 5, 340, 400)).toBe(1.2);
  });
  test("a different user's size (manual resize): starts over from the needed scale", () => {
    expect(nextGrowScale(kept, 1.1, 5, 300, 350)).toBe(1.1);
  });
});

describe("shrinking back when birds leave, with the actual placement (gardenSimulate)", () => {
  // The user's window is 340x400; header and tabs take 22x80, so the garden is (340s - 22)x(400s - 80) at scale s
  const userW = 340;
  const userH = 400;
  const overheadW = 22;
  const overheadH = 80;
  // As tried by gardenFitScale (ROUNDING_PX smaller than the exact size, for the window's whole pixels)
  const gardenAt = (s: number) => ({ w: userW * s - overheadW - ROUNDING_PX, h: userH * s - overheadH - ROUNDING_PX });
  const bird = (id: string, at: Point): PlaceBox => ({ id, w: 120, h: 113, at });

  /** The Garden after some birds left the window grown to `grown`: those left stay where they were */
  const leftAt = (grown: number, left: PlaceBox[], anchor: Point = { x: 0, y: 0 }) => {
    const g = gardenAt(grown);
    const shown = placeBoxes(left, g.w, g.h);
    expect(shown.overflow).toEqual([]);
    const placed: PlacedGarden = {
      settled: left.map((b) => ({ ...b, at: shown.at.get(b.id) })),
      heightAt: new Map(),
      glyph: 26,
      count: left.length,
      w: g.w,
      h: g.h,
      anchor,
      overflowIds: new Set(),
    };
    const f: GardenFit = {
      ...fit(left.length),
      boxes: left.map(() => ({ w: 120, h0: 87, rows: 1 })),
      gardenW: g.w,
      gardenH: g.h,
      overheadW,
      overheadH,
      simulate: (w, h) => gardenSimulate(placed, w, h),
    };
    return { placed, f };
  };

  const noOverlap = (at: Map<string, Point>, boxes: readonly PlaceBox[], w: number, h: number) => {
    const rects = boxes.map((b) => ({ ...at.get(b.id)!, w: b.w, h: b.h }));
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(PLACE_EDGE_PX);
      expect(r.y).toBeGreaterThanOrEqual(PLACE_EDGE_PX);
      expect(r.x + r.w).toBeLessThanOrEqual(w - PLACE_EDGE_PX + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(h - PLACE_EDGE_PX + 1e-9);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const apart =
          a.x + a.w + PLACE_GAP_PX <= b.x + 1e-9 ||
          b.x + b.w + PLACE_GAP_PX <= a.x + 1e-9 ||
          a.y + a.h + PLACE_GAP_PX <= b.y + 1e-9 ||
          b.y + b.h + PLACE_GAP_PX <= a.y + 1e-9;
        expect(apart).toBe(true);
      }
  };

  test("shrinks to the smallest size above the user's at which all 6 left get a spot; one step less doesn't", () => {
    // Grown to 1.8 (590x640 garden); 6 birds left, spread over it
    const left = [
      bird("a", { x: 4, y: 4 }),
      bird("b", { x: 200, y: 4 }),
      bird("c", { x: 460, y: 4 }),
      bird("d", { x: 4, y: 300 }),
      bird("e", { x: 300, y: 300 }),
      bird("f", { x: 460, y: 520 }),
    ];
    const { placed, f } = leftAt(1.8, left);
    const s = gardenFitScale(userW, userH, f, 1.8);
    expect(s).toBeGreaterThan(1);
    expect(s).toBeLessThan(1.8);
    const g = gardenAt(s);
    const r = gardenSimulate(placed, g.w, g.h);
    expect(r.overflow).toBe(0);
    noOverlap(r.at, r.tried, g.w, g.h);
    const less = gardenAt(s - 0.02);
    expect(gardenSimulate(placed, less.w, less.h).overflow).toBeGreaterThan(0);
    // The window takes whole pixels: rounded down, they still all get a spot
    const shown = gardenSimulate(placed, Math.floor(userW * s) - overheadW, Math.floor(userH * s) - overheadH);
    expect(shown.overflow).toBe(0);
  });

  test("never below the user's size, even when the birds left would fit in less", () => {
    const { f } = leftAt(1.6, [bird("a", { x: 380, y: 400 })]);
    expect(gardenFitScale(userW, userH, f, 1.6)).toBe(1);
  });

  test("only birds that stick out of the smaller garden move, to the nearest free spot; the others keep their place", () => {
    // Grown to 1.6 (522x560 garden): a and b fit in the user's 318x320 garden, c sticks out on the right, d at the bottom
    const left = [
      bird("a", { x: 4, y: 4 }),
      bird("b", { x: 136, y: 4 }),
      bird("c", { x: 396, y: 4 }),
      bird("d", { x: 4, y: 440 }),
    ];
    const { placed, f } = leftAt(1.6, left);
    const s = gardenFitScale(userW, userH, f, 1.6);
    expect(s).toBe(1);
    const g = gardenAt(s);
    const r = gardenSimulate(placed, g.w, g.h);
    expect(r.overflow).toBe(0);
    noOverlap(r.at, r.tried, g.w, g.h);
    expect(r.at.get("a")).toEqual({ x: 4, y: 4 });
    expect(r.at.get("b")).toEqual({ x: 136, y: 4 });
    // c and d moved into the free room below a and b (noOverlap above: inside the garden, apart from the others)
    expect(r.at.get("c")).not.toEqual({ x: 396, y: 4 });
    expect(r.at.get("d")).not.toEqual({ x: 4, y: 440 });
    expect(r.at.get("c")!.y).toBeGreaterThan(4);
    expect(r.at.get("d")!.y).toBeLessThan(440);
  });

  test("a window that grew left shrinks toward its right edge: the birds keep their place on screen", () => {
    // Anchor x = 1: the right edge stays put, so the garden's left edge moves right by the width it loses
    const left = [bird("a", { x: 396, y: 4 }), bird("b", { x: 264, y: 4 })];
    const { placed, f } = leftAt(1.6, left, { x: 1, y: 0 });
    const s = gardenFitScale(userW, userH, f, 1.6);
    expect(s).toBe(1);
    const g = gardenAt(s);
    const r = gardenSimulate(placed, g.w, g.h);
    const lost = gardenAt(1.6).w - g.w;
    expect(r.at.get("a")).toEqual({ x: 396 - lost, y: 4 });
    expect(r.at.get("b")).toEqual({ x: 264 - lost, y: 4 });
  });

  test("the anchor is read when a size is tried, so one fetched after the placement is the one used", () => {
    const anchor = { x: 0, y: 0 };
    const { placed } = leftAt(1.6, [bird("a", { x: 396, y: 4 })], anchor);
    Object.assign(anchor, { x: 1, y: 0 });
    const g = gardenAt(1);
    const lost = gardenAt(1.6).w - g.w;
    expect(gardenSimulate(placed, g.w, g.h).at.get("a")).toEqual({ x: 396 - lost, y: 4 });
  });

  test("other changes than birds leaving don't shrink it (bubbles and status lines come and go)", () => {
    const kept = { scale: 1.6, count: 4, userW, userH };
    expect(nextGrowScale(kept, 1, 4, userW, userH)).toBe(1.6);
    expect(nextGrowScale(kept, 1, 3, userW, userH)).toBe(1);
  });
});

// docs/design.md "Layout": "On screen" means shown in a settled place. Reproduces what was seen in the verify build: at
// launch, a watch block and 8 birds were first placed in the user's small garden (375×361, user's window 421×482), the
// window grew, and they were kept at those places shifted to stay on screen, which split the free space; the window
// stopped at the display's height (634×726, garden 588×605) with 5 of them overlapping
describe("birds first placed in a render that asks the window to grow are placed again after it grows", () => {
  const userW = 421;
  const userH = 482;
  const overheadW = 46;
  const overheadH = 121;
  const ids = ["concierge", "mock/extra/0", "mock/extra/1", "mock/extra/2", "mock/extra/3", "mock/extra/4", "mock/extra/5", "mock/watch/blog"];
  // A watch block of 2×2 birds (280×278) and birds with the footprint as wide as the widest bubble (180×113), placed
  // as new ones: the block from the top-left, the birds in seeded grid cells (the same order as garden.tsx)
  const asNew = (): PlaceBox[] => [
    { id: "mock/watch/parent", w: 280, h: 278, want: { x: PLACE_EDGE_PX, y: PLACE_EDGE_PX } },
    ...ids.map((id) => ({ id, w: 180, h: 113, seed: hashId(id) })),
  ];
  const small = { w: userW - overheadW, h: userH - overheadH };
  const first = placeBoxes(asNew(), small.w, small.h);
  const overflowIds = new Set(first.overflow);
  // As the Garden passes it for trying other sizes; the window grows away from the display's top and right edges
  const placed = (fresh: boolean): PlacedGarden => ({
    settled: fresh
      ? asNew()
      : asNew().map((b) => {
          const at = first.at.get(b.id)!;
          return overflowIds.has(b.id) ? { id: b.id, w: b.w, h: b.h, want: at } : { id: b.id, w: b.w, h: b.h, at };
        }),
    heightAt: new Map(),
    glyph: 26,
    count: 12,
    w: small.w,
    h: small.h,
    anchor: { x: 1, y: 0.5 },
    overflowIds,
    fresh: fresh ? new Set(asNew().map((b) => b.id)) : undefined,
  });
  const fitOf = (p: PlacedGarden): GardenFit => ({
    count: 12,
    boxes: [],
    overflow: true,
    overflowW: 180,
    overflowH: 113,
    gardenW: small.w,
    gardenH: small.h,
    overheadW,
    overheadH,
    simulate: (w, h) => gardenSimulate(p, w, h),
  });
  // The display's visible height (726) is where the window stops
  const cap = 726 / userH;

  test("they don't all get a spot in the small garden, which asks the window to grow", () => {
    expect(first.overflow.length).toBeGreaterThan(0);
  });

  test("kept at their first places (before): 588×605 leaves some overlapping and the window would need more than the display", () => {
    expect(gardenSimulate(placed(false), 588, 605).overflow).toBeGreaterThan(0);
    expect(gardenFitScale(userW, userH, fitOf(placed(false)))).toBeGreaterThan(cap);
  });

  test("placed again like new ones (after): everything gets a spot at about 632×723, within the display", () => {
    const s = gardenFitScale(userW, userH, fitOf(placed(true)));
    expect(s).toBeLessThanOrEqual(cap);
    expect(Math.round(userW * s)).toBeLessThanOrEqual(634);
    expect(gardenSimulate(placed(true), userW * s - overheadW - ROUNDING_PX, userH * s - overheadH - ROUNDING_PX).overflow).toBe(0);
    expect(gardenSimulate(placed(true), 632 - overheadW, 723 - overheadH).overflow).toBe(0);
  });
});
