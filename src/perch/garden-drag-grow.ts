// Where a drag grows the floating window (docs/design.md "Layout"). Pure computation from the pointer and the garden's
// rect (no DOM or Tauri access); garden-grow.ts sends it to the Rust side (src-tauri/src/garden_grow.rs)

// How close to the garden's edge the pointer must come for a drag to grow the window (CSS px; DRAG_BAND_PX in
// src-tauri/src/garden_grow.rs, which also pulls the edge this far past the pointer)
const DRAG_BAND_PX = 24;

export type Edges = { left: number; top: number; right: number; bottom: number };

/**
 * While a bird or block is dragged (docs/design.md "Layout"): whether the pointer (client px) is within the band of the
 * garden's edge or past it, and if so the garden's edges inside the window (insets, for garden_drag_grow) and the part
 * of the window that stays put (the anchor, the same as drag_anchor in src-tauri/src/garden_grow.rs: the right / bottom
 * edge when growing left / up). garden: the garden's rect; only the part inside the window counts
 */
export function dragGrowRequest(
  pointer: { x: number; y: number },
  garden: Edges,
  view: { width: number; height: number },
): { insets: Edges; anchor: { x: number; y: number } } | undefined {
  const left = Math.max(garden.left, 0);
  const top = Math.max(garden.top, 0);
  const right = Math.min(garden.right, view.width);
  const bottom = Math.min(garden.bottom, view.height);
  const axis = (p: number, lo: number, hi: number) => (p > hi - DRAG_BAND_PX ? 0 : p < lo + DRAG_BAND_PX ? 1 : undefined);
  const x = axis(pointer.x, left, right);
  const y = axis(pointer.y, top, bottom);
  if (x === undefined && y === undefined) return undefined;
  return {
    insets: { left, top, right: view.width - right, bottom: view.height - bottom },
    anchor: { x: x ?? 0, y: y ?? 0 },
  };
}
