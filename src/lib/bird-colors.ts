// The bird's colors, kept in one place: the "?" badge, the working bird's glow, and the speech bubble's ground are set
// from here as CSS custom properties at boot (applyBirdColors, perch/boot.tsx) and read by the styles that draw them

/** The "?" badge of a bird that needs a reply (styles/bird-badge.css) */
export const ASK_BADGE = "#f2b33d";
/** The gold of a working bird's glow (styles/perch-rows.css .bird-aura-gold) */
export const WORKING_GLOW = "#ffc45a";
/** The speech bubble's ground (styles/speech-bubble.css), the Concierge tab's state lines included */
export const BUBBLE_BG = "#ece6d6";
/** Sets the colors above as CSS custom properties on the root, for the styles that draw them */
export function applyBirdColors(root: HTMLElement) {
  root.style.setProperty("--ask-badge", ASK_BADGE);
  root.style.setProperty("--working-glow", WORKING_GLOW);
  root.style.setProperty("--bubble-bg", BUBBLE_BG);
}
