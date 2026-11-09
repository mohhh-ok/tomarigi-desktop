// The concierge's bubble (docs/design.md "Concierge"; perch/concierge-status-report.tsx): a line per session built by the
// app as 「<name>: <text> <state>」 with the name linking to its session, then the suggestions under their heading. No
// name is searched for in text. Dictionaries aren't loaded here, so the app's own words (t()) render empty
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConciergeStatus, ShownSuggestion, StatusLine } from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/sessions.ts";
import { conciergeStatusLines } from "../src/lib/concierge-status.ts";
import { BUBBLE_BG } from "../src/lib/bird-colors.ts";
import { ConciergeStatusReport } from "../src/perch/concierge-status-report.tsx";

const view = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "working",
  sinceMs: 1000,
  ...patch,
});
const LINES: StatusLine[] = [
  { sessionId: "root/blog.jsonl", name: "blog", text: "Publish now?", status: "reply" },
  { sessionId: "api", name: "api", text: "Fixed the links", status: "done" },
  { sessionId: "web", name: "web", status: "working" },
];
const SUGGESTIONS: ShownSuggestion[] = [
  { sessionId: "root/blog.jsonl", kind: "reply", text: "it has waited longest", name: "blog", status: "reply" },
];
const NOW = [view("root/blog.jsonl", { project: "blog", state: "waiting" }), view("api", { state: "done" }), view("web")];

const render = (sessions = NOW, suggestions = SUGGESTIONS, more = 0, canJump = (id: string) => id !== "nojump") =>
  renderToStaticMarkup(
    <ConciergeStatusReport lines={LINES} more={more} suggestions={suggestions} sessions={sessions} canJump={canJump} />,
  );
const LINK = '<span role="button" tabindex="0" class="concierge-status-name fade-target">';
const DOT = (status: ConciergeStatus) => `<span class="concierge-status-dot" data-status="${status}" aria-hidden="true"></span>`;

describe("the state lines", () => {
  test("「<name>: <text>」 with the name linking to its session and the app's state after the text", () => {
    const html = render();
    expect(html).toContain(`${LINK}blog</span>: Publish now?<span class="concierge-status-state" data-status="reply">`);
    expect(html).toContain(`${LINK}api</span>: Fixed the links<span class="concierge-status-state" data-status="done">`);
    // No text: 「<name>: <state>」, the state in the same part as after a text, once
    expect(html).toContain(`${LINK}web</span>:<span class="concierge-status-state" data-status="working"> </span></span>`);
  });

  test("a session that needs a reply without a text says its state in the same part as the others", () => {
    const html = renderToStaticMarkup(
      <ConciergeStatusReport
        lines={[{ sessionId: "blog", name: "blog", status: "reply" }]}
        more={0}
        suggestions={[]}
        sessions={[view("blog", { state: "waiting" })]}
        canJump={() => true}
      />,
    );
    expect(html).toBe(
      `<span class="concierge-status"><span class="concierge-status-lines"><span class="concierge-status-line">${DOT("reply")}${LINK}blog</span>:<span class="concierge-status-state" data-status="reply"> </span></span></span></span>`,
    );
  });

  test("in the order given; 「ほか N 件」 only when lines were cut", () => {
    const html = render();
    expect(html.indexOf("Publish now?")).toBeLessThan(html.indexOf("Fixed the links"));
    expect(html).not.toContain("concierge-status-more");
    expect(render(NOW, SUGGESTIONS, 3)).toContain('class="concierge-status-more"');
  });

  test("a session that can't be jumped to is plain text", () => {
    expect(render(NOW, [], 0, () => false)).not.toContain("concierge-status-name");
  });
});

describe("the suggestions", () => {
  test("at the top under their heading, before the lines, each with its session's name as a link; no advice line", () => {
    const html = render();
    expect(html.indexOf("concierge-status-heading")).toBeLessThan(html.indexOf("Publish now?"));
    expect(html.indexOf("it has waited longest")).toBeLessThan(html.indexOf('class="concierge-status-lines"'));
    expect(html).toContain(`<span class="concierge-status-line">${LINK}blog</span>: it has waited longest</span>`);
  });

  test("none: no heading, and the lines start the bubble", () => {
    expect(render(NOW, [])).not.toContain("concierge-status-heading");
    expect(render(NOW, [])).toMatch(/^<span class="concierge-status"><span class="concierge-status-lines">/);
  });

  test("dimmed with its session's state now once that changed; gone is no longer a link", () => {
    const moved = render([view("root/blog.jsonl", { project: "blog" }), NOW[1], NOW[2]]);
    expect(moved).toContain('<span class="concierge-status-line is-stale">');
    expect(moved).toContain('class="concierge-status-now"');
    const gone = render([NOW[1], NOW[2]]);
    expect(gone).toContain('<span class="concierge-status-line is-stale">blog: it has waited longest');
  });
});

// The state lines' rules (styles/concierge.css)
const css = readFileSync(new URL("../src/perch/styles/concierge.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? undefined : css.slice(at, css.indexOf("}", at));
};

// The color a rule gives, its custom property resolved from .concierge-status
const colorIn = (selector: string, prop: string) => {
  const v = rule(selector)?.match(new RegExp(`(?:^|\\s)${prop}: ([^;]+);`))?.[1];
  const custom = v?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return custom ? rule(".concierge-status")?.match(new RegExp(`${custom}: ([^;]+);`))?.[1] : v;
};
// WCAG contrast of two #rrggbb colors
const contrast = (a: string, b: string) => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("the dot at each state line's left (docs/design.md \"Concierge\")", () => {
  test.each([
    // [scene, the session, its dot's color, its word's color, its word's weight]
    ["finished", view("s", { state: "done", summary: "ok" }), "#1d5ba6", "#6b6456", undefined],
    ["finished (dozing)", view("s", { state: "dozing" }), "#1d5ba6", "#6b6456", undefined],
    ["needs a reply (waiting)", view("s", { state: "waiting", question: "Go?" }), "#a0461c", "#a0461c", "600"],
    ["needs a reply (done, asking)", view("s", { state: "done", ask: { status: "asking" } }), "#a0461c", "#a0461c", "600"],
    ["working", view("s"), "#ffffff", "#6b6456", undefined],
    ["finished but continuing: working white, its word grey", view("s", { state: "done", continuing: true }), "#ffffff", "#6b6456", undefined],
  ] as const)("%s: dot %p, word %p", (_, session, dot, word, weight) => {
    const { lines } = conciergeStatusLines([session], () => "t");
    const status = lines[0].status;
    const html = renderToStaticMarkup(
      <ConciergeStatusReport lines={lines} more={0} suggestions={[]} sessions={[session]} canJump={() => true} />,
    );
    // The line starts with its state's dot, before the name; one dot only, the state word's part has none
    expect(html).toContain(`<span class="concierge-status-line">${DOT(status)}${LINK}s</span>: t`);
    expect(html.match(/concierge-status-dot/g)).toHaveLength(1);
    expect(colorIn(`.concierge-status-dot[data-status="${status}"]`, "background")).toBe(dot);
    const wordRule = `.concierge-status-state[data-status="${status}"]`;
    expect(colorIn(wordRule, "color") ?? colorIn(".concierge-status-state", "color")).toBe(word);
    expect(rule(wordRule)?.match(/font-weight: (\d+);/)?.[1]).toBe(weight);
    // A dot keeps 3:1 on the bubble (a graphic part), except working's plain white, quiet on purpose (the user chose it);
    // a word 4.5:1
    if (status !== "working") expect(contrast(dot, BUBBLE_BG)).toBeGreaterThanOrEqual(3);
    expect(contrast(word, BUBBLE_BG)).toBeGreaterThanOrEqual(4.5);
  });

  test("a suggestion has no dot", () => {
    expect(render(NOW, SUGGESTIONS).split('class="concierge-status-lines"')[0]).not.toContain("concierge-status-dot");
  });

  test("a wrapped line continues under the name: the line hangs from the dot by its width and gap", () => {
    const line = rule(".concierge-status-lines .concierge-status-line");
    const dot = rule(".concierge-status-dot");
    const px = (r: string | undefined, prop: string) => Number(r?.match(new RegExp(`${prop}: (-?[\\d.]+)px;`))?.[1]);
    expect(px(line, "padding-left")).toBe(px(dot, "width") + px(dot, "margin-right"));
    expect(px(line, "text-indent")).toBe(-px(line, "padding-left"));
  });
});
