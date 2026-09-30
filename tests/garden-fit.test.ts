// How far the floating window grows so the Garden's birds fit (docs/design.md "Layout"). The direction and the cap at
// the display's visible area are tested on the Rust side (grow_frame in src-tauri/src/garden_grow.rs)
import { describe, expect, test } from "bun:test";
import {
  GARDEN_MIN_HEIGHT_PX,
  gardenFits,
  gardenFitScale,
  gardenGlyphSize,
  gardenNeededHeight,
  MAX_FIT_SCALE,
  nextGrowScale,
  type GardenFit,
} from "../src/lib/garden-fit.ts";

// Birds without bubbles (nodeW 132), header and tabs about 80px tall
const fit = (count: number, extra: Partial<GardenFit> = {}): GardenFit => ({
  count,
  looseCount: count,
  nodeW: 132,
  nodeExtraH: 60,
  blocksH: 0,
  overheadW: 22,
  overheadH: 80,
  ...extra,
});

describe("gardenGlyphSize", () => {
  test("never below 26px however many birds", () => {
    expect(gardenGlyphSize(300, 220, 40)).toBe(26);
  });
  test("never above 52px", () => {
    expect(gardenGlyphSize(2000, 2000, 1)).toBe(52);
  });
});

describe("gardenNeededHeight", () => {
  test("rows of birds plus the watching blocks, at least the garden's min-height", () => {
    // 318px wide → 2 columns; 5 birds → 3 rows of 26 + 60
    expect(gardenNeededHeight(318, 26, fit(5, { blocksH: 40 }))).toBe(3 * 86 + 40);
    expect(gardenNeededHeight(318, 26, fit(1))).toBe(GARDEN_MIN_HEIGHT_PX);
  });
});

describe("gardenFitScale", () => {
  test("birds that fit at the user's size: stays at the user's size", () => {
    expect(gardenFitScale(340, 400, fit(2))).toBe(1);
  });

  test("birds that don't fit: the smallest scale at which they do", () => {
    const f = fit(8);
    const s = gardenFitScale(340, 400, f);
    expect(s).toBeGreaterThan(1);
    expect(gardenFits(340 * s - f.overheadW, 400 * s - f.overheadH, f)).toBe(true);
    // One step smaller doesn't fit
    const smaller = s - 0.02;
    expect(gardenFits(340 * smaller - f.overheadW, 400 * smaller - f.overheadH, f)).toBe(false);
  });

  test("never smaller than the user's size, even for a large window with few birds", () => {
    expect(gardenFitScale(1200, 900, fit(1))).toBe(1);
    expect(gardenFitScale(1200, 900, fit(0))).toBe(1);
  });

  test("more birds, more growth", () => {
    expect(gardenFitScale(340, 400, fit(20))).toBeGreaterThan(gardenFitScale(340, 400, fit(8)));
  });

  test("birds that never fit: the upper end (the Rust side caps it at the display)", () => {
    expect(gardenFitScale(340, 400, fit(10_000))).toBe(MAX_FIT_SCALE);
  });

  test("an unmeasured window stays at the user's size", () => {
    expect(gardenFitScale(0, 0, fit(8))).toBe(1);
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
