// The one place that decides how far the floating window shrinks by itself (keepPlaceScale in src/lib/garden-fit.ts;
// docs/design.md "Layout"): the smallest size, never below the user's, at which every bird keeps its place on screen
import { gardenDropScale, keepPlaceScale, shrinkScale, type GardenFit } from "../src/lib/garden-fit.ts";

// The user's window is 340x400, header and tabs 22x80. The birds keep their place in a garden at least `needW`x`needH`
const fitNeeding = (needW: number, needH: number): GardenFit => ({
  count: 2,
  boxes: [],
  overflow: false,
  overflowW: 0,
  overflowH: 0,
  gardenW: 600,
  gardenH: 600,
  overheadW: 22,
  overheadH: 80,
  simulate: (w, h) => ({ overflow: 0, moved: w >= needW && h >= needH ? 0 : 1 }),
});

describe("keepPlaceScale", () => {
  test("the smallest step at which nobody moves", () => {
    // 340s - 22 - 1 >= 450 at s >= 1.3912; 400s - 80 - 1 >= 300 at s >= 0.95
    expect(keepPlaceScale(340, 400, fitNeeding(450, 300), 1.6)).toBe(1.4);
  });
  test("never below the user's size", () => {
    expect(keepPlaceScale(340, 400, fitNeeding(10, 10), 1.6)).toBe(1);
  });
  test("none up to upTo keeps everyone in place: undefined", () => {
    expect(keepPlaceScale(340, 400, fitNeeding(450, 300), 1.3)).toBeUndefined();
  });
  test("an overflow at a size doesn't count as keeping everyone", () => {
    const f = { ...fitNeeding(10, 10), simulate: () => ({ overflow: 1, moved: 0 }) };
    expect(keepPlaceScale(340, 400, f, 1.6)).toBeUndefined();
  });
  test("without the actual placement: undefined", () => {
    expect(keepPlaceScale(340, 400, { ...fitNeeding(10, 10), simulate: undefined }, 1.6)).toBeUndefined();
  });
});

describe("shrinkScale and gardenDropScale go through keepPlaceScale", () => {
  test("shrinkScale: keepPlaceScale up to the current scale, or the current scale", () => {
    expect(shrinkScale(340, 400, fitNeeding(450, 300), 1.6)).toBe(1.4);
    expect(shrinkScale(340, 400, fitNeeding(450, 300), 1.3)).toBe(1.3);
  });
  test("gardenDropScale: keepPlaceScale over every size", () => {
    expect(gardenDropScale(340, 400, fitNeeding(450, 300))).toBe(1.4);
  });
});
