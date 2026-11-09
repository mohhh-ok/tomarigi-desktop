// The bird's colors (lib/bird-colors.ts): set at boot as CSS custom properties, and the styles that draw them read
// those properties instead of keeping their own copies of the values
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyBirdColors, ASK_BADGE, BUBBLE_BG, WORKING_GLOW } from "../src/lib/bird-colors.ts";

describe("the bird's colors in one place", () => {
  test("set at boot as custom properties", () => {
    const set: Record<string, string> = {};
    applyBirdColors({ style: { setProperty: (k: string, v: string) => (set[k] = v) } } as unknown as HTMLElement);
    expect(set).toEqual({ "--ask-badge": ASK_BADGE, "--working-glow": WORKING_GLOW, "--bubble-bg": BUBBLE_BG });
  });

  test("the styles use the properties, not their own copies of the values", () => {
    const read = (f: string) => readFileSync(new URL(`../src/perch/styles/${f}`, import.meta.url), "utf8").toLowerCase();
    const all = ["bird-badge.css", "perch-rows.css", "speech-bubble.css"].map(read).join("\n");
    for (const v of [ASK_BADGE, WORKING_GLOW, "rgb(255, 196, 90)", BUBBLE_BG]) expect(all).not.toContain(v);
    expect(read("bird-badge.css")).toContain("background: var(--ask-badge);");
    expect(read("perch-rows.css")).toContain("drop-shadow(0 0 3px var(--working-glow))");
    expect(read("speech-bubble.css")).toContain("background: var(--bubble-bg);");
  });
});
