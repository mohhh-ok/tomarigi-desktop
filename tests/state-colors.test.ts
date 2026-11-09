// The colors that tell a session's state (lib/state-colors.ts; docs/design.md "Concierge"): the Concierge tab's state
// dots take the bird's own colors, darkened only where they don't keep 3:1 on the bubble, and the birds' styles read
// the same values from the CSS custom properties set at boot
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { conciergeStatusLines, conciergeStatusOf } from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/sessions.ts";
import {
  applyStateColors,
  ASK_BADGE,
  BUBBLE_BG,
  conciergeDotColor,
  contrastRatio,
  DONE_DOT,
  DOT_MIN_CONTRAST,
  shadeForContrast,
  WORKING_GLOW,
} from "../src/lib/state-colors.ts";

const view = (patch: Partial<SessionView>): SessionView => ({
  id: "s",
  project: "s",
  slug: "s",
  state: "working",
  sinceMs: 1000,
  ...patch,
});

describe("the dot's color by where a session stands", () => {
  test.each([
    ["finished", view({ state: "done", summary: "ok" }), DONE_DOT],
    ["finished (dozing)", view({ state: "dozing" }), DONE_DOT],
    ["needs a reply (waiting)", view({ state: "waiting", question: "Go?" }), ASK_BADGE],
    ["needs a reply (done, asking)", view({ state: "done", ask: { status: "asking" } }), ASK_BADGE],
    ["working", view({ toolName: "Edit" }), WORKING_GLOW],
    ["finished but continuing: working, like its word", view({ state: "done", continuing: true }), WORKING_GLOW],
  ])("%s: the color of %p, kept at 3:1 on the bubble", (_, v, base) => {
    const line = conciergeStatusLines([v], () => undefined).lines[0];
    const color = conciergeDotColor(line.status);
    expect(color).toBe(shadeForContrast(base, BUBBLE_BG, DOT_MIN_CONTRAST));
    expect(contrastRatio(color, BUBBLE_BG)).toBeGreaterThanOrEqual(DOT_MIN_CONTRAST);
    expect(conciergeStatusOf(v)).toBe(line.status);
  });

  test("done keeps its blue as it is (5.4:1); the light bird colors are darkened, and only as far as needed", () => {
    expect(conciergeDotColor("done")).toBe(DONE_DOT);
    expect(contrastRatio(DONE_DOT, BUBBLE_BG)).toBeCloseTo(5.4, 1);
    for (const base of [ASK_BADGE, WORKING_GLOW]) {
      expect(contrastRatio(base, BUBBLE_BG)).toBeLessThan(DOT_MIN_CONTRAST);
      const shade = shadeForContrast(base, BUBBLE_BG, DOT_MIN_CONTRAST);
      expect(contrastRatio(shade, BUBBLE_BG)).toBeGreaterThanOrEqual(DOT_MIN_CONTRAST);
      // One step lighter would fall short
      const rgb = [1, 3, 5].map((i) => parseInt(shade.slice(i, i + 2), 16));
      const base3 = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16));
      const pct = Math.round((1 - rgb[0] / base3[0]) * 100);
      const lighter = `#${base3.map((c) => Math.round(c * (1 - (pct - 1) / 100)).toString(16).padStart(2, "0")).join("")}`;
      expect(contrastRatio(lighter, BUBBLE_BG)).toBeLessThan(DOT_MIN_CONTRAST);
    }
  });

  test("contrast ratio is WCAG's", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });
});

describe("the birds' styles read the same values", () => {
  test("set at boot as custom properties", () => {
    const set: Record<string, string> = {};
    applyStateColors({ style: { setProperty: (k: string, v: string) => (set[k] = v) } } as unknown as HTMLElement);
    expect(set).toEqual({ "--ask-badge": ASK_BADGE, "--working-glow": WORKING_GLOW, "--bubble-bg": BUBBLE_BG });
  });

  test("the styles use the properties, not their own copies of the values", () => {
    const read = (f: string) => readFileSync(new URL(`../src/perch/styles/${f}`, import.meta.url), "utf8").toLowerCase();
    const all = ["bird-badge.css", "perch-rows.css", "speech-bubble.css", "concierge.css"].map(read).join("\n");
    for (const v of [ASK_BADGE, WORKING_GLOW, "rgb(255, 196, 90)", DONE_DOT]) expect(all).not.toContain(v);
    expect(read("bird-badge.css")).toContain("background: var(--ask-badge);");
    expect(read("perch-rows.css")).toContain("var(--working-glow)");
    expect(read("speech-bubble.css")).toContain("background: var(--bubble-bg);");
  });
});
