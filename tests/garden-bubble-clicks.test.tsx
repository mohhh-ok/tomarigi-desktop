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
