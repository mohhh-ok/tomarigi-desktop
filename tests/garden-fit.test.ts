// How far the floating window grows so the Garden's birds fit (docs/design.md "Layout"). The direction and the cap at
// the display's visible area are tested on the Rust side (grow_frame in src-tauri/src/garden_grow.rs)
import {
  GARDEN_MIN_HEIGHT_PX,
  gardenFits,
  gardenFitScale,
  gardenGlyphSize,
  MAX_FIT_SCALE,
  nextGrowScale,
  type GardenFit,
} from "../src/lib/garden-fit.ts";

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
    // 340 * s - 22 >= 400 → s >= 1.2412 → 1.26 on the 0.02 steps
    expect(gardenFitScale(340, 400, withSim(true), 1)).toBe(1.26);
  });

  test("nothing overflowed: never grows; shrinks back only as far as nobody moves", () => {
    expect(gardenFitScale(340, 400, withSim(false), 1)).toBe(1);
    // From 1.5: the smallest s with 340 * s - 22 >= 400 (no overflow, no move) is 1.26
    expect(gardenFitScale(340, 400, withSim(false), 1.5)).toBe(1.26);
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
