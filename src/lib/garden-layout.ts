// Persisting node positions in the Garden tab (issue #12).
//
// Stored through idb in the same "tomarigi" DB / "kv" store as lib/settings-store.ts (IndexedDB was chosen in the tomarigi Chrome
// extension to avoid the "storage" permission; the desktop app keeps the same store).

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "tomarigi";
const STORE = "kv";
const KEY_GARDEN_POSITIONS = "gardenPositions";

/** A dragged position as saved: the bird's center (x) and top edge (y), as % of the garden. Used when the bird first
    appears (e.g. on the next launch); once on screen a bird is kept in px (lib/garden-place.ts) */
export interface GardenPosition {
  x: number; // % of container width
  y: number; // % of container height
  /** The user dropped it there (or its block): it opens there even over other birds (docs/design.md "Layout") */
  byUser?: boolean;
  /** The user dragged it: drawn in front of the birds and bubbles, higher in front of lower (docs/design.md "Layout") */
  front?: number;
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

/**
 * What is saved after the user drops a bird: every bird where it settled on screen (center and top in px), not where
 * the pointer was released. A bird dropped onto another settles beside it, and the birds that appear on the next launch
 * are each placed at their saved spot, so the Garden opens as it was right after the drop (docs/design.md "Layout").
 * Birds the user placed (byUser: dropped, or in a block that was) are marked, so they open there over others too.
 * Saved spots of birds not on screen are kept
 */
export function positionsAfterDrop(args: {
  prev: Record<string, GardenPosition>;
  settled: Map<string, { x: number; y: number }>;
  byUser: ReadonlySet<string>;
  /** The birds dropped now (a block's all together): in front of every bird dropped before */
  front?: ReadonlySet<string>;
  w: number;
  h: number;
}): Record<string, GardenPosition> {
  const { prev, settled, byUser, front = new Set<string>(), w, h } = args;
  const top = Math.max(0, ...Object.values(prev).map((p) => p.front ?? 0)) + 1;
  const next = { ...prev };
  for (const [id, p] of settled) {
    const rank = front.has(id) ? top : prev[id]?.front;
    next[id] = {
      x: (p.x / w) * 100,
      y: (p.y / h) * 100,
      ...(byUser.has(id) && { byUser: true }),
      ...(rank !== undefined && { front: rank }),
    };
  }
  return next;
}

/** Birds the user dragged, by how far in front (1 the back; docs/design.md "Layout"). Ranks are made consecutive, so
    they don't grow without end as birds are dragged again and again */
export function frontRanks(positions: Record<string, GardenPosition>): Map<string, number> {
  const fronts = [...new Set(Object.values(positions).flatMap((p) => (p.front === undefined ? [] : [p.front])))].sort(
    (a, b) => a - b,
  );
  return new Map(
    Object.entries(positions)
      .filter(([, p]) => p.front !== undefined)
      .sort(([, a], [, b]) => a.front! - b.front!)
      .map(([id, p]) => [id, fronts.indexOf(p.front!) + 1]),
  );
}
