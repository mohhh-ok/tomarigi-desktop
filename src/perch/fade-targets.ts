// What takes clicks at rest in "Fade until hovered" (docs/design.md "Fade until hovered", "Platforms"). At rest the
// window lets clicks through everywhere except over these, decided on the Rust side (fade_tick in
// src-tauri/src/fade.rs) from the rectangles garden-fade.ts measures with the selectors below. Something new that should
// take clicks at rest gets one of these classes; nothing else does:
// - .fade-handle / .fade-target: one rectangle per line box, so a name wrapped onto two lines doesn't take clicks on the
//   text between its parts (the window handles, the session names in the concierge's bubble)
// - .fade-box: the whole box, its empty space included, so a click there never reaches what is hidden under it (the
//   concierge's speech bubble, in the Garden and in the Concierge tab). The same class turns its clicks on in the page
//   (pointer-events: auto in styles/base.css), shown or at rest, so a bird drawn under it isn't pressed through it either
// Birds (their glyph with the badges sticking out of it) are measured apart, since Rust also needs to know when the
// cursor is on a bird. A bird's own speech bubble takes no class: clicks on it go through at rest
// This file has no DOM or Tauri dependency, so tests/fade-targets.test.ts runs it as is

export const FADE_LINES_SELECTOR = ".fade-handle, .fade-target";
export const FADE_BOX_SELECTOR = ".fade-box";
export const FADE_TARGET_SELECTOR = `${FADE_LINES_SELECTOR}, ${FADE_BOX_SELECTOR}`;
export const BIRD_GLYPH_SELECTOR = ".garden-node .garden-glyph";
export const BIRD_BADGE_SELECTOR = ".bird-badge";

/** A rectangle in window content coordinates (CSS px, origin at the top left), as sent to Rust */
export interface FadeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A DOMRect's edges */
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One element that takes clicks, as measured: its box, its line boxes, and whether the whole box counts */
export interface MeasuredTarget {
  box: Edges;
  lines: Edges[];
  whole: boolean;
}

const toRect = ({ left, top, right, bottom }: Edges): FadeRect | null =>
  right <= left || bottom <= top ? null : { x: left, y: top, width: right - left, height: bottom - top };

/** The rectangles that take clicks for these elements: the whole box for .fade-box, else one per line box. Empty
 * (not laid out) boxes are left out */
export function targetRects(targets: MeasuredTarget[]): FadeRect[] {
  const rects: FadeRect[] = [];
  for (const t of targets) {
    for (const edges of t.whole ? [t.box] : t.lines) {
      const r = toRect(edges);
      if (r) rects.push(r);
    }
  }
  return rects;
}

/** A bird's rectangle: its glyph grown to hold the badges ("?", anger mark) that stick out of it. None while the
 * glyph isn't laid out */
export function birdRect(glyph: Edges, badges: Edges[]): FadeRect | null {
  if (!toRect(glyph)) return null;
  let { left, top, right, bottom } = glyph;
  for (const b of badges) {
    left = Math.min(left, b.left);
    top = Math.min(top, b.top);
    right = Math.max(right, b.right);
    bottom = Math.max(bottom, b.bottom);
  }
  return toRect({ left, top, right, bottom });
}
