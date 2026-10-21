// Stable placement in the Garden (docs/design.md "Layout"): a bird or block on screen stays where it is; only one that
// would overlap another or leave the garden moves, to the nearest free spot
import { describe, expect, test } from "bun:test";
import {
  PLACE_EDGE_PX,
  PLACE_GAP_PX,
  placeBoxes,
  shiftPoints,
  type PlaceBox,
  type Point,
} from "../src/lib/garden-place.ts";
import { watchLinePath, watchShapes } from "../src/perch/garden-watch-layout.ts";

const bird = (id: string, extra: Partial<PlaceBox> = {}): PlaceBox => ({ id, w: 120, h: 110, ...extra });

/** Places like garden.tsx does from one render to the next: what was shown is passed back as `at` */
function rerender(prev: Map<string, Point>, boxes: PlaceBox[], W: number, H: number) {
  const kept = boxes.filter((b) => prev.has(b.id)).map((b) => ({ ...b, at: prev.get(b.id) }));
  const fresh = boxes.filter((b) => !prev.has(b.id));
  return placeBoxes([...kept, ...fresh], W, H);
}

const overlaps = (at: Map<string, Point>, boxes: PlaceBox[]) => {
  const rects = boxes.map((b) => ({ ...at.get(b.id)!, w: b.w, h: b.h }));
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) return true;
    }
  return false;
};

describe("placeBoxes", () => {
  test("new birds get separate spots inside the garden", () => {
    const boxes = ["a", "b", "c", "d"].map((id, i) => bird(id, { seed: i * 7 }));
    const { at, overflow } = placeBoxes(boxes, 300, 300);
    expect(overflow).toEqual([]);
    expect(overlaps(at, boxes)).toBe(false);
    for (const b of boxes) {
      const p = at.get(b.id)!;
      expect(p.x).toBeGreaterThanOrEqual(PLACE_EDGE_PX);
      expect(p.y).toBeGreaterThanOrEqual(PLACE_EDGE_PX);
      expect(p.x + b.w).toBeLessThanOrEqual(300 - PLACE_EDGE_PX);
      expect(p.y + b.h).toBeLessThanOrEqual(300 - PLACE_EDGE_PX);
    }
  });

  test("birds on screen stay put when another joins or leaves", () => {
    const first = placeBoxes([bird("a", { seed: 0 }), bird("b", { seed: 3 })], 400, 400);
    const joined = rerender(first.at, [bird("a"), bird("b"), bird("c", { seed: 1 })], 400, 400);
    expect(joined.at.get("a")).toEqual(first.at.get("a")!);
    expect(joined.at.get("b")).toEqual(first.at.get("b")!);
    const left = rerender(joined.at, [bird("a"), bird("c")], 400, 400);
    expect(left.at.get("a")).toEqual(first.at.get("a")!);
    expect(left.at.get("c")).toEqual(joined.at.get("c")!);
  });

  test("a new block that would cover a bird: only that bird moves, to the nearest free spot", () => {
    const a = { x: 10, y: 10 };
    const b = { x: 200, y: 200 };
    const block: PlaceBox = { id: "block", w: 200, h: 150, want: { x: 150, y: 150 } };
    // The block is kept first (garden.tsx puts blocks before birds)
    const { at, overflow } = placeBoxes([{ ...block, at: { x: 150, y: 150 } }, bird("a", { at: a }), bird("b", { at: b })], 500, 500);
    expect(overflow).toEqual([]);
    expect(at.get("a")).toEqual(a);
    expect(at.get("b")).not.toEqual(b);
    expect(overlaps(at, [block, bird("a"), bird("b")])).toBe(false);
  });

  test("a bird dropped onto another is nudged to the nearest free spot; the other stays", () => {
    const a = { x: 10, y: 10 };
    const { at } = placeBoxes([bird("a", { at: a }), bird("b", { want: { x: 30, y: 20 } })], 500, 500);
    expect(at.get("a")).toEqual(a);
    expect(overlaps(at, [bird("a"), bird("b")])).toBe(false);
    // Nearest: right next to a (beside it or below it, both 112px from the drop)
    const b = at.get("b")!;
    expect(Math.hypot(b.x - 30, b.y - 20)).toBe(a.x + 120 + PLACE_GAP_PX - 30);
  });

  test("a bird that no longer fits in a smaller garden moves inside; the others stay", () => {
    const a = { x: 10, y: 10 };
    const b = { x: 300, y: 10 };
    const { at } = placeBoxes([bird("a", { at: a }), bird("b", { at: b })], 350, 300);
    expect(at.get("a")).toEqual(a);
    expect(at.get("b")!.x + 120).toBeLessThanOrEqual(350 - PLACE_EDGE_PX);
  });

  test("no room: reported as overflow (the window grows), never reported when they fit", () => {
    const boxes = ["a", "b", "c"].map((id) => bird(id));
    expect(placeBoxes(boxes, 280, 250).overflow).toEqual([]);
    expect(placeBoxes([...boxes, bird("d"), bird("e")], 280, 250).overflow.length).toBeGreaterThan(0);
  });

  test("the same inputs again move nothing (renders every 3 seconds)", () => {
    let prev = placeBoxes(["a", "b", "c", "d", "e"].map((id, i) => bird(id, { seed: i * 5 })), 420, 520).at;
    const first = new Map(prev);
    for (let i = 0; i < 5; i++) prev = rerender(prev, ["a", "b", "c", "d", "e"].map((id) => bird(id)), 420, 520).at;
    expect(prev).toEqual(first);
  });
});

describe("shiftPoints", () => {
  test("the garden's origin moved left by 30 (the window grew left): points move right by 30, so they stay on screen", () => {
    const points = new Map([["a", { x: 10, y: 20 }]]);
    shiftPoints(points, -30, 0);
    expect(points.get("a")).toEqual({ x: 40, y: 20 });
  });
});

describe("watchShapes", () => {
  const parent = {
    id: "p",
    project: "app",
    slug: "app",
    state: "done" as const,
    sinceMs: 0,
    cwd: "/w/app",
    startedAt: 1,
    peers: [{ sessionId: "c", viewId: "c", name: "c", cwd: "/w/app", active: true }],
  };
  const child = { id: "c", project: "app", slug: "app", state: "working" as const, sinceMs: 0, cwd: "/w/app", startedAt: 2 };

  test("a bubble, a name, or a count appearing changes neither the block's footprint nor where its birds are", () => {
    const calm = watchShapes([parent, child], 30)[0];
    const busy = watchShapes(
      [
        { ...parent, watching: 1, summary: "Fixed the header" },
        { ...child, cwd: "/w/app/src", project: "src", toolName: "Bash" },
      ],
      30,
    )[0];
    expect(busy.footH).toBe(calm.footH);
    expect(busy.width).toBe(calm.width);
    for (const id of ["p", "c"]) {
      expect(busy.cells.get(id)!.dx).toBe(calm.cells.get(id)!.dx);
      expect(busy.cells.get(id)!.dy).toBe(calm.cells.get(id)!.dy);
    }
  });
});

describe("watch grid", () => {
  const bird = (id: string, startedAt: number, peers: string[]) => ({
    id,
    project: id,
    slug: id,
    state: "done" as const,
    sinceMs: 0,
    cwd: `/w/${id}`,
    startedAt,
    peers: peers.map((p) => ({ sessionId: p, viewId: p, name: p, active: true })),
  });
  const kids = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
  const family = (n: number) => [bird("p", 0, kids(n)), ...kids(n).map((id, i) => bird(id, i + 1, ["p"]))];
  const cell = (shape: { grid: Map<string, { col: number; row: number }> }, id: string) => shape.grid.get(id);

  test("linked birds go beside the parent, then diagonal below, then diagonal above; never straight above or below", () => {
    const shape = watchShapes(family(6), 30)[0];
    expect(shape.rootId).toBe("p");
    expect(kids(6).map((id) => cell(shape, id))).toEqual([
      { col: 1, row: 0 },
      { col: -1, row: 0 },
      { col: 1, row: 1 },
      { col: -1, row: 1 },
      { col: 1, row: -1 },
      { col: -1, row: -1 },
    ]);
    expect(shape.links).toHaveLength(6);
  });

  test("from the 7th on, a bird goes to the nearest free cell and gets no line", () => {
    const shape = watchShapes(family(8), 30)[0];
    expect(shape.memberIds).toHaveLength(9);
    expect(shape.links).toHaveLength(6);
    for (const id of ["c6", "c7"]) expect(shape.links.some((pair) => pair.includes(id))).toBe(false);
    const cells = [...shape.grid.values()].map((c) => `${c.col},${c.row}`);
    expect(new Set(cells).size).toBe(cells.length);
  });

  test("a bird watched by a linked bird goes next to that bird and is joined to it", () => {
    // p watches a and b; a watches c
    const shape = watchShapes([bird("p", 1, ["a", "b"]), bird("a", 2, ["p", "c"]), bird("b", 3, []), bird("c", 4, ["a"])], 30)[0];
    expect(cell(shape, "a")).toEqual({ col: 1, row: 0 });
    expect(cell(shape, "c")).toEqual({ col: 2, row: 0 });
    expect(shape.links).toEqual([
      ["p", "a"],
      ["p", "b"],
      ["a", "c"],
    ]);
  });

  test("no two lines cross in an X", () => {
    // p watches 6; two of them watch 3 each (many-A1 sample)
    const g = (k: string, n: number) => Array.from({ length: n }, (_, j) => `${k}w${j}`);
    const sessions = [
      bird("p", 0, kids(6)),
      ...kids(6).map((id, i) => bird(id, i + 1, ["p", ...(i < 2 ? g(id, 3) : [])])),
      ...["c0", "c1"].flatMap((k, i) => g(k, 3).map((id, j) => bird(id, 10 + i * 3 + j, [k]))),
    ];
    const shape = watchShapes(sessions, 30)[0];
    const pos = (id: string) => shape.grid.get(id)!;
    for (const [a, b] of shape.links) {
      for (const [c, d] of shape.links) {
        const [pa, pb, pc, pd] = [pos(a), pos(b), pos(c), pos(d)];
        const crossed =
          pa.row !== pb.row &&
          pc.row !== pd.row &&
          new Set([a, b, c, d]).size === 4 &&
          Math.min(pa.col, pb.col) === Math.min(pc.col, pd.col) &&
          Math.min(pa.row, pb.row) === Math.min(pc.row, pd.row);
        expect(crossed).toBe(false);
      }
    }
  });

  test("birds keep the cells they had when another joins, and a bird that took the parent's place keeps them too", () => {
    const before = watchShapes(family(3), 30)[0];
    const after = watchShapes(family(4), 30, () => before.grid)[0];
    for (const id of ["p", ...kids(3)]) expect(cell(after, id)).toEqual(cell(before, id));
    // A kept cell is used again even where a new bird would otherwise go first
    const swapped = new Map(before.grid);
    swapped.set("c0", { col: -1, row: 0 });
    swapped.set("c1", { col: 1, row: 0 });
    const kept = watchShapes(family(3), 30, () => swapped)[0];
    expect(cell(kept, "c0")).toEqual({ col: -1, row: 0 });
    expect(cell(kept, "c1")).toEqual({ col: 1, row: 0 });
  });

  test("the parent's name is above the parent; a bird in the parent's folder shows none", () => {
    const parent = { ...bird("p", 1, ["c"]), project: "app", cwd: "/w/app" };
    const child = { ...bird("c", 2, []), project: "app", cwd: "/w/app" };
    const shape = watchShapes([parent, child], 30)[0];
    expect(shape.cells.get("p")!.label).toBe("app");
    expect(shape.cells.get("c")!.label).toBeUndefined();
  });
});

describe("watch lines", () => {
  test("a line is short, centered between the icons, and stops at least gap from each", () => {
    expect(watchLinePath({ x: 0, y: 0 }, { x: 132, y: 0 }, 33, 36)).toEqual([
      { x: 48, y: 0 },
      { x: 84, y: 0 },
    ]);
    // Room for a shorter line only
    const near = watchLinePath({ x: 0, y: 0 }, { x: 80, y: 0 }, 33, 36)!;
    expect(near[0].x).toBeCloseTo(33);
    expect(near[1].x).toBeCloseTo(47);
    expect(watchLinePath({ x: 0, y: 0 }, { x: 60, y: 0 }, 33, 36)).toBeUndefined();
  });
});

describe("placeBoxes without knock-on moves", () => {
  test("a bird that has to move doesn't land on another bird's spot and push it on", () => {
    // One row only (200 tall). b overlaps a; the nearest spot to the right of a is c's
    const a = { x: 10, y: 10 };
    const c = { x: 142, y: 10 };
    const { at } = placeBoxes([bird("a", { at: a }), bird("b", { at: { x: 40, y: 10 } }), bird("c", { at: c })], 600, 200);
    expect(at.get("a")).toEqual(a);
    expect(at.get("c")).toEqual(c);
    expect(overlaps(at, [bird("a"), bird("b"), bird("c")])).toBe(false);
  });
});

describe("placeBoxes when nothing is free (the garden never grows past the window)", () => {
  test("a new bird overlaps where it covers the least, inside the garden; the others stay", () => {
    const a = { x: 4, y: 4 };
    const b = { x: 136, y: 4 };
    const { at, overflow } = placeBoxes([bird("a", { at: a }), bird("b", { at: b }), bird("c", { seed: 0 })], 280, 180);
    expect(overflow).toEqual(["c"]);
    expect(at.get("a")).toEqual(a);
    expect(at.get("b")).toEqual(b);
    const c = at.get("c")!;
    expect(c.x).toBeGreaterThanOrEqual(PLACE_EDGE_PX);
    expect(c.y + 110).toBeLessThanOrEqual(180 - PLACE_EDGE_PX);
    expect(c.x + 120).toBeLessThanOrEqual(280 - PLACE_EDGE_PX);
  });
  test("a bird on screen with no free spot stays where it is", () => {
    const { at } = placeBoxes([bird("a", { at: { x: 4, y: 4 } }), bird("b", { at: { x: 40, y: 20 } })], 200, 140);
    expect(at.get("b")).toEqual({ x: 40, y: 20 });
  });
});
