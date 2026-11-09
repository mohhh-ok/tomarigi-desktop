// The colors that tell a session's state, kept in one place: the bird's "?" badge, the working bird's glow, and the
// speech bubble's ground are set from here as CSS custom properties at boot (applyStateColors, perch/boot.tsx) and read
// by the birds' styles, and the Concierge tab's state dots take the same values (docs/design.md "Concierge"), so a color
// means the same in the tab as at the bird
import type { ConciergeStatus } from "./concierge-status";

/** The "?" badge of a bird that needs a reply (styles/bird-badge.css) */
export const ASK_BADGE = "#f2b33d";
/** The gold of a working bird's glow (styles/perch-rows.css .bird-aura-gold) */
export const WORKING_GLOW = "#ffc45a";
/** The speech bubble's ground (styles/speech-bubble.css), the Concierge tab's state lines included */
export const BUBBLE_BG = "#ece6d6";
/** Done in the Concierge tab: the palette has no blue; it keeps 5.4:1 on the bubble */
export const DONE_DOT = "#1d5ba6";

/** The contrast a state dot keeps on the bubble (WCAG's for a graphic part); a lighter color is darkened to it */
export const DOT_MIN_CONTRAST = 3;

const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
const luminance = (hex: string) => {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two #rrggbb colors */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The color itself when it keeps min on bg, else the lightest darker shade of it (mixed toward black in 1% steps)
    that does */
export function shadeForContrast(color: string, bg: string, min: number): string {
  const rgb = rgbOf(color);
  for (let pct = 0; pct <= 100; pct++) {
    const shade = hexOf(rgb.map((c) => c * (1 - pct / 100)));
    if (contrastRatio(shade, bg) >= min) return shade;
  }
  return "#000000";
}

/** The dot before a Concierge tab state line: done blue, needs reply the "?" badge's color, working the glow's (a
    finished session continuing in the background is working, so it gets the working color), each darkened where it
    doesn't keep DOT_MIN_CONTRAST on the bubble */
export function conciergeDotColor(status: ConciergeStatus): string {
  const base = status === "done" ? DONE_DOT : status === "reply" ? ASK_BADGE : WORKING_GLOW;
  return shadeForContrast(base, BUBBLE_BG, DOT_MIN_CONTRAST);
}

/** Sets the colors above as CSS custom properties on the root, for the styles that draw them */
export function applyStateColors(root: HTMLElement) {
  root.style.setProperty("--ask-badge", ASK_BADGE);
  root.style.setProperty("--working-glow", WORKING_GLOW);
  root.style.setProperty("--bubble-bg", BUBBLE_BG);
}
