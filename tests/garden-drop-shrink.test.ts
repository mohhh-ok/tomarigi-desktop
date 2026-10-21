// When the user drops a bird or block, the window shrinks once to the smallest size at which everything on screen keeps
// its place (docs/design.md "Layout"), so carrying a bird back in from the edge brings the window back
import { describe, expect, test } from "bun:test";
import { gardenDropScale, type GardenFit } from "../src/lib/garden-fit.ts";

const USER = { w: 400, h: 300 };
const OVERHEAD = { w: 40, h: 120 };
/** A fit whose placement: nothing overflows from gardenW ≥ fitW, nothing moves from gardenW ≥ stayW */
const fitWith = (fitW: number, stayW: number): GardenFit => ({
  count: 3,
  boxes: [],
  overflow: false,
  overflowW: 0,
  overflowH: 0,
  gardenW: 1000,
  gardenH: 400,
  overheadW: OVERHEAD.w,
  overheadH: OVERHEAD.h,
  simulate: (gw) => ({ overflow: gw >= fitW ? 0 : 1, moved: gw >= stayW ? 0 : 1 }),
});

describe("gardenDropScale", () => {
  test("everything fits at the user's size without moving: back to the user's size", () => {
    expect(gardenDropScale(USER.w, USER.h, fitWith(200, 200))).toBe(1);
  });

  test("the smallest size at which no bird on screen moves, not just where they all have a spot", () => {
    // Everyone has a spot from 360px of garden, but a bird carried out stays put only from 560px
    const s = gardenDropScale(USER.w, USER.h, fitWith(360, 560))!;
    expect(USER.w * s - OVERHEAD.w).toBeGreaterThanOrEqual(560);
    expect(USER.w * (s - 0.02) - OVERHEAD.w).toBeLessThan(561);
  });

  test("when no size keeps everyone in place, it doesn't shrink", () => {
    expect(gardenDropScale(USER.w, USER.h, fitWith(100, 100_000))).toBeUndefined();
  });

  test("without the placement to try sizes with, it doesn't shrink", () => {
    expect(gardenDropScale(USER.w, USER.h, { ...fitWith(100, 100), simulate: undefined })).toBeUndefined();
  });
});
