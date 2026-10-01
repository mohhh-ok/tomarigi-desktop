// Stable placement of the Garden's birds and watch blocks (docs/design.md "Layout").
//
// Everything is in px of the garden (the .garden element). A box is a bird's or a block's footprint: the most room it
// can take (bubble room, both status lines and marks included), so bubbles and status lines coming and going never
// make it overlap a neighbour. What is on screen is passed back in as `at` on the next call and kept as is; only a box
// that now overlaps an earlier one or sticks out of the garden moves, to the nearest free spot. Recomputing every
// position from the inputs each time made every bird jump whenever anything changed (the user's report).

/** Top-left of a box, px from the garden's top-left */
export interface Point {
  x: number;
  y: number;
}

export interface PlaceBox {
  id: string;
  w: number;
  h: number;
  /** Where it is on screen now. Kept unless it overlaps a box placed before it or sticks out of the garden */
  at?: Point;
  /** Not on screen yet (or just dropped by the user): the spot it wants. The nearest free spot to it is used */
  want?: Point;
  /** Not on screen yet and no wanted spot: a free cell of the grid, starting from the cell this number picks */
  seed?: number;
}

export interface Placement {
  at: Map<string, Point>;
  /** Boxes that had no free spot. They are placed anyway (overlapping); the garden is too small for them */
  overflow: string[];
}

// Gap left between boxes (px)
export const PLACE_GAP_PX = 12;
// Gap between a box and the garden's frame (px)
export const PLACE_EDGE_PX = 4;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const hits = (a: Rect, b: Rect) =>
  a.x < b.x + b.w + PLACE_GAP_PX && b.x < a.x + a.w + PLACE_GAP_PX && a.y < b.y + b.h + PLACE_GAP_PX && b.y < a.y + a.h + PLACE_GAP_PX;

/**
 * Places boxes in the order given, each avoiding the ones before it. Put what must stay first: boxes already on screen
 * (blocks before birds), then boxes the user just dropped, then new ones.
 * W×H is the room the boxes may use (the garden). A box larger than the garden is put at the top-left and counts as overflow
 */
export function placeBoxes(boxes: readonly PlaceBox[], W: number, H: number): Placement {
  const placed: Rect[] = [];
  const at = new Map<string, Point>();
  const overflow: string[] = [];
  boxes.forEach((box, index) => {
    const maxX = W - PLACE_EDGE_PX - box.w;
    const maxY = H - PLACE_EDGE_PX - box.h;
    const fits = maxX >= PLACE_EDGE_PX && maxY >= PLACE_EDGE_PX;
    const clamp = (p: Point): Point => ({
      x: Math.max(PLACE_EDGE_PX, Math.min(maxX, p.x)),
      y: Math.max(PLACE_EDGE_PX, Math.min(maxY, p.y)),
    });
    const free = (p: Point) => fits && !placed.some((r) => hits(r, { ...p, w: box.w, h: box.h }));
    // A box that moves (or is new) also avoids the spots of boxes still to come that are on screen, so it doesn't
    // land on one of them and push it on in turn. Only if that leaves no room does it take one of their spots
    const ahead = boxes
      .slice(index + 1)
      .flatMap((b) => (b.at ? [{ ...clampBox(b, b.at, W, H), w: b.w, h: b.h }] : []));
    const search = (obstacles: readonly Rect[]): Point | undefined => {
      if (box.at) return nearestFree(clamp(box.at), box, obstacles, W, H);
      if (box.want) return nearestFree(clamp(box.want), box, obstacles, W, H);
      return gridSpot(box, obstacles, W, H) ?? nearestFree(clamp({ x: 0, y: 0 }), box, obstacles, W, H);
    };
    let spot: Point | undefined;
    if (box.at && free(clamp(box.at))) spot = clamp(box.at);
    else spot = search([...placed, ...ahead]) ?? search(placed);
    if (!spot) {
      // No free spot: the garden never grows past the window (docs/design.md "Layout"), so it overlaps instead. A box
      // on screen stays where it is; a new one goes where it covers the least of the others, nearest to where it wanted
      overflow.push(box.id);
      const from = clamp(box.at ?? box.want ?? { x: 0, y: 0 });
      spot = box.at || !fits ? from : leastCovered(from, box, placed, W, H);
    }
    at.set(box.id, spot);
    placed.push({ ...spot, w: box.w, h: box.h });
  });
  return { at, overflow };
}

function clampBox(box: PlaceBox, p: Point, W: number, H: number): Point {
  return {
    x: Math.max(PLACE_EDGE_PX, Math.min(W - PLACE_EDGE_PX - box.w, p.x)),
    y: Math.max(PLACE_EDGE_PX, Math.min(H - PLACE_EDGE_PX - box.h, p.y)),
  };
}

/**
 * The free spot nearest to p. Candidates are p itself, the garden's edges, and the spots right next to each placed box
 * (combined per axis), which covers every place a box can go without leaving a gap it doesn't need
 */
function nearestFree(p: Point, box: PlaceBox, placed: readonly Rect[], W: number, H: number): Point | undefined {
  const maxX = W - PLACE_EDGE_PX - box.w;
  const maxY = H - PLACE_EDGE_PX - box.h;
  if (maxX < PLACE_EDGE_PX || maxY < PLACE_EDGE_PX) return undefined;
  const xs = [p.x, PLACE_EDGE_PX, maxX];
  const ys = [p.y, PLACE_EDGE_PX, maxY];
  for (const r of placed) {
    xs.push(r.x - PLACE_GAP_PX - box.w, r.x + r.w + PLACE_GAP_PX, r.x);
    ys.push(r.y - PLACE_GAP_PX - box.h, r.y + r.h + PLACE_GAP_PX, r.y);
  }
  // Nearest first, so the search stops at the first free one. Edges of boxes laid out in rows repeat a lot; each value
  // is tried once
  const candidates: { x: number; y: number; d: number }[] = [];
  for (const x of unique(xs)) {
    if (x < PLACE_EDGE_PX || x > maxX) continue;
    for (const y of unique(ys)) {
      if (y < PLACE_EDGE_PX || y > maxY) continue;
      candidates.push({ x, y, d: Math.hypot(x - p.x, y - p.y) });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const { x, y } of candidates) {
    const rect = { x, y, w: box.w, h: box.h };
    if (!placed.some((r) => hits(r, rect))) return { x, y };
  }
  return undefined;
}

const unique = (values: number[]) => [...new Set(values.map((v) => Math.round(v * 2) / 2))];

/** The spot inside the garden where box covers the least area of the placed boxes (ties: nearest to p) */
function leastCovered(p: Point, box: PlaceBox, placed: readonly Rect[], W: number, H: number): Point {
  const maxX = W - PLACE_EDGE_PX - box.w;
  const maxY = H - PLACE_EDGE_PX - box.h;
  const xs = [p.x, PLACE_EDGE_PX, maxX];
  const ys = [p.y, PLACE_EDGE_PX, maxY];
  for (const r of placed) {
    xs.push(r.x - PLACE_GAP_PX - box.w, r.x + r.w + PLACE_GAP_PX, r.x);
    ys.push(r.y - PLACE_GAP_PX - box.h, r.y + r.h + PLACE_GAP_PX, r.y);
  }
  // Also a coarse grid, so a spot between boxes is found when no edge lines up
  for (let x = PLACE_EDGE_PX; x <= maxX; x += box.w / 4) xs.push(x);
  for (let y = PLACE_EDGE_PX; y <= maxY; y += box.h / 4) ys.push(y);
  let best = p;
  let bestArea = Infinity;
  let bestD = Infinity;
  for (const x of unique(xs)) {
    if (x < PLACE_EDGE_PX || x > maxX) continue;
    for (const y of unique(ys)) {
      if (y < PLACE_EDGE_PX || y > maxY) continue;
      let area = 0;
      for (const r of placed) {
        const ow = Math.min(x + box.w, r.x + r.w) - Math.max(x, r.x);
        const oh = Math.min(y + box.h, r.y + r.h) - Math.max(y, r.y);
        if (ow > 0 && oh > 0) area += ow * oh;
      }
      const d = Math.hypot(x - p.x, y - p.y);
      if (area < bestArea - 0.5 || (Math.abs(area - bestArea) <= 0.5 && d < bestD)) {
        best = { x, y };
        bestArea = area;
        bestD = d;
      }
    }
  }
  return best;
}

/**
 * A free cell for a new bird: the garden is split into as many cells as fit the box, and the box goes in the middle of
 * the first free one starting from the cell picked by seed (so birds don't fill the garden in reading order). Using
 * cells, not the nearest free spot, keeps new birds from leaving gaps too small for the next one
 */
function gridSpot(box: PlaceBox, placed: readonly Rect[], W: number, H: number): Point | undefined {
  const cols = Math.floor((W - 2 * PLACE_EDGE_PX + PLACE_GAP_PX) / (box.w + PLACE_GAP_PX));
  const rows = Math.floor((H - 2 * PLACE_EDGE_PX + PLACE_GAP_PX) / (box.h + PLACE_GAP_PX));
  if (cols < 1 || rows < 1) return undefined;
  const cellW = (W - 2 * PLACE_EDGE_PX) / cols;
  const cellH = (H - 2 * PLACE_EDGE_PX) / rows;
  const cells = cols * rows;
  const start = (box.seed ?? 0) % cells;
  for (let i = 0; i < cells; i++) {
    const cell = (start + i) % cells;
    const x = PLACE_EDGE_PX + (cell % cols) * cellW + (cellW - box.w) / 2;
    const y = PLACE_EDGE_PX + Math.floor(cell / cols) * cellH + (cellH - box.h) / 2;
    const rect = { x, y, w: box.w, h: box.h };
    if (!placed.some((r) => hits(r, rect))) return { x, y };
  }
  return undefined;
}

/**
 * The origin of the garden moved on screen by (dx, dy) because the window was resized (grown, shrunk, or resized by
 * hand from its left or top edge). Shifts what is on screen back by that much so it stays at the same place on
 * screen. A plain window move (size unchanged) moves everything with the window, so it isn't passed here
 */
export function shiftPoints<K>(points: Map<K, Point>, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const [k, p] of points) points.set(k, { x: p.x - dx, y: p.y - dy });
}
