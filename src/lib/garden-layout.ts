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
