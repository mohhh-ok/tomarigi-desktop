// Persisting node positions in the Garden tab (issue #12).
//
// Design note: the issue's instructions named browser.storage.local, but the tomarigi Chrome extension
// relies on "zero permissions" for trust (see the comment in wxt.config.ts) and keeps manifest.permissions
// empty. chrome.storage APIs need the "storage" permission, so using them here would be
// the only permission added. IndexedDB can be used from extension pages without permissions,
// so this goes through idb into the same "tomarigi" DB / "kv" store as fsa.ts,
// persisting without breaking zero permissions.

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_GARDEN_POSITIONS = "gardenPositions";

export interface GardenPosition {
  x: number; // % of container width
  y: number; // % of container height
}

// Range of motion (% of the container) so nodes aren't cut off too much at the container edges.
// The same values are used for clamping while dragging and for automatic placement.
const CLAMP_X_MIN = 8;
const CLAMP_X_MAX = 92;
const CLAMP_Y_MIN = 10;
const CLAMP_Y_MAX = 90;

/**
 * Grid for automatic placement. Columns and rows are decided from the garden size and one bird's size in px (docs/design.md "Garden layout").
 * jitterX / jitterY are how far a bird may shift within its cell (as a fraction of the cell). It shifts only by the room left over when the bird is smaller than the cell,
 * so it doesn't overlap birds in neighboring cells
 */
export interface GardenGrid {
  cols: number;
  rows: number;
  jitterX: number;
  jitterY: number;
}

// Grid used while the garden size isn't known yet (the old fixed 4×3)
const FALLBACK_GRID: GardenGrid = { cols: 4, rows: 3, jitterX: 0.6, jitterY: 0.6 };
// Upper limit of the shift within a cell (just enough to break a too-neat alignment)
const MAX_JITTER = 0.6;

/**
 * Columns and rows that fit birds (nodeW×nodeH px) without overlap in a garden of w×h px. If count birds don't fit,
 * add columns/rows starting from the direction with more room relative to one bird (birds overlap in a narrow garden; "as far as possible", as before)
 */
export function gardenGrid(
  w: number,
  h: number,
  nodeW: number,
  nodeH: number,
  count: number,
): GardenGrid {
  if (w <= 0 || h <= 0) return FALLBACK_GRID;
  let cols = Math.max(1, Math.floor(w / nodeW));
  let rows = Math.max(1, Math.floor(h / nodeH));
  while (cols * rows < count) {
    if (w / (cols + 1) / nodeW >= h / (rows + 1) / nodeH) cols++;
    else rows++;
  }
  const jitter = (cell: number, node: number) => Math.min(MAX_JITTER, Math.max(0, (cell - node) / cell));
  return {
    cols,
    rows,
    jitterX: jitter(w / cols, nodeW),
    jitterY: jitter(h / rows, nodeH),
  };
}

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
}

export async function loadGardenPositions(): Promise<Record<string, GardenPosition>> {
  const saved = (await (await db()).get(STORE, KEY_GARDEN_POSITIONS)) as
    | Record<string, GardenPosition>
    | undefined;
  return saved ?? {};
}

export async function saveGardenPositions(
  positions: Record<string, GardenPosition>,
): Promise<void> {
  await (await db()).put(STORE, positions, KEY_GARDEN_POSITIONS);
}

export function clampGardenPosition(x: number, y: number): GardenPosition {
  return {
    x: Math.min(CLAMP_X_MAX, Math.max(CLAMP_X_MIN, x)),
    y: Math.min(CLAMP_Y_MAX, Math.max(CLAMP_Y_MIN, y)),
  };
}

// Makes a deterministic non-negative integer from a string (a simple FNV-like hash). Randomness would
// move positions on every re-render, so the same value has to be reproduced from the id every time.
// (Also used to decide which way a bird faces in the garden (horizontal flip), besides placement)
export function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Which grid cell a position belongs to (0 to cols*rows-1). For finding empty cells */
export function gardenCellOf(pos: GardenPosition, grid: GardenGrid): number {
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor(pos.x / (100 / grid.cols))));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor(pos.y / (100 / grid.rows))));
  return row * grid.cols + col;
}

/**
 * Initial placement of a session with no saved position. Starting from the cell given by the id hash, search linearly
 * for an empty cell avoiding taken (cells that already have a bird) (if all cells are full, overlap on the start cell = avoid overlaps "as far as possible").
 * The jitter within the cell is a small deterministic offset decided only by the id hash (breaks a too-neat alignment). The shift is
 * limited to the room left over when the bird is smaller than the cell (grid.jitterX / jitterY).
 * Randomness or the array index would make positions jump on every re-render or state change, so they aren't used (this caused real problems).
 */
export function autoGardenPosition(id: string, taken: ReadonlySet<number>, grid: GardenGrid): GardenPosition {
  const cells = grid.cols * grid.rows;
  const hash = hashId(id);
  const start = hash % cells;
  let slot = start;
  for (let i = 0; i < cells; i++) {
    const cand = (start + i) % cells;
    if (!taken.has(cand)) {
      slot = cand;
      break;
    }
  }
  const col = slot % grid.cols;
  const row = Math.floor(slot / grid.cols);
  const cellW = 100 / grid.cols;
  const cellH = 100 / grid.rows;
  const jitterX = ((hash % 100) / 100 - 0.5) * cellW * grid.jitterX;
  const jitterY = (((hash >> 8) % 100) / 100 - 0.5) * cellH * grid.jitterY;
  // Doesn't go through clampGardenPosition. Cell centers and jitter already stay inside their cells, and pulling edge cells into 8–92%
  // squeezed the space to birds in neighboring cells so their status lines overlapped
  return { x: col * cellW + cellW / 2 + jitterX, y: row * cellH + cellH / 2 + jitterY };
}
