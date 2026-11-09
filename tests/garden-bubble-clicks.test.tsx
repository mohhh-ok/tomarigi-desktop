// What takes clicks at rest (docs/design.md "Fade until hovered", "Platforms"; src/perch/fade-targets.ts): the
// concierge's speech bubble carries .fade-box, so its whole box takes clicks, in the Garden and in the Concierge tab; a
// bird's bubble doesn't, so clicks on it go through. The class is what garden-fade.ts measures (FADE_BOX_SELECTOR)
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FADE_BOX_SELECTOR, FADE_TARGET_SELECTOR } from "../src/perch/fade-targets.ts";
import { GardenBubble } from "../src/perch/bubble.tsx";

const BOX_CLASS = FADE_BOX_SELECTOR.slice(1);
// The class list of the bubble's outer box (.speech-bubble-below), which carries the tail and the position
const outerClasses = (html: string) => (/^<span class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");

test.each([
  ["the concierge's bubble in the Garden", true, undefined, true],
  ["the concierge's bubble in the Concierge tab", true, <b>suggestions</b>, true],
  ["a bird's bubble", false, undefined, false],
] as const)("%s → whole box takes clicks: %p", (_, concierge, content, want) => {
  const classes = outerClasses(renderToStaticMarkup(<GardenBubble text="Publish now?" content={content} concierge={concierge} />));
  expect(classes).toContain("speech-bubble-below");
  expect(classes.includes(BOX_CLASS)).toBe(want);
});

test("garden-fade.ts measures the box class", () => {
  expect(FADE_TARGET_SELECTOR.split(",").map((s) => s.trim())).toContain(FADE_BOX_SELECTOR);
});

// The bubble layer and its anchors let presses through (speech-bubble.css), and the bubble inherits that. The box class
// turns them back on in the page too, so a click on the concierge's bubble, shown or at rest, doesn't reach the bird
// drawn under it; a bird's bubble keeps letting them through. The tail lets them through, as the window does at rest
const { readFileSync } = await import("node:fs");
const css = (name: string) => readFileSync(new URL(`../src/perch/styles/${name}`, import.meta.url), "utf8");
// The declarations of the rule whose selector is exactly this one
const rule = (source: string, selector: string) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&");
  return new RegExp(`(?:^|\\}|\\*/)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? "";
};

test("the box class takes clicks in the page", () => {
  expect(rule(css("base.css"), FADE_BOX_SELECTOR)).toMatch(/pointer-events:\s*auto/);
});

test("the bubble layer and anchors still let presses through, and so does the tail", () => {
  const bubble = css("speech-bubble.css");
  expect(rule(bubble, ".garden-bubble-layer")).toMatch(/pointer-events:\s*none/);
  expect(rule(bubble, ".garden-bubble-anchor")).toMatch(/pointer-events:\s*none/);
  expect(rule(bubble, ".speech-bubble-below::after")).toMatch(/pointer-events:\s*none/);
});
