// The concierge's bubble with a "What's going on?" summary (docs/design.md "Concierge"): each line is built by the app
// as 「<name>: <text>」 with the name linking to its session; no name is searched for in text. Dictionaries aren't loaded
// here, so the app's own words (t()) render empty
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Summary } from "../src/lib/concierge-summary.ts";
import type { SessionView } from "../src/lib/sessions.ts";
import { ConciergeReport } from "../src/perch/concierge-report.tsx";

const view = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "working",
  sinceMs: 1000,
  ...patch,
});
const SUMMARY: Summary = {
  madeAt: 0,
  items: [
    { sessionId: "blog", name: "blog", text: "whether to publish", status: "reply" },
    { sessionId: "api", name: "api", text: "fixed the links", status: "done" },
    { sessionId: "old", name: "old", text: "building", status: "working" },
  ],
  more: 0,
  suggestions: [{ sessionId: "blog", name: "blog", text: "answer blog first: it waited longest", status: "reply" }],
};

const render = (sessions: SessionView[], advice?: { line: string; targetId?: string }, summary = SUMMARY) =>
  renderToStaticMarkup(
    <ConciergeReport
      parts={{ summary: { kind: "shown", summary }, advice }}
      sessions={sessions}
      canJump={(id) => id !== "nojump"}
      onCloseSummary={() => {}}
    />,
  );
const LINK = '<span role="button" tabindex="0" class="concierge-summary-name fade-target">';

describe("the summary's lines", () => {
  const now = [view("blog", { state: "waiting" }), view("api", { state: "done" }), view("old")];

  test("each line is 「<name>: <text>」 and the name links to its session", () => {
    const html = render(now);
    expect(html).toContain(`${LINK}blog</span>: whether to publish`);
    expect(html).toContain(`${LINK}api</span>: fixed the links`);
  });

  test("the state is added by the app from its facts, after the AI's text; a changed line shows only its state now", () => {
    const html = render(now);
    expect(html).toContain('whether to publish<span class="concierge-summary-state" data-status="reply">');
    expect(html).toContain('fixed the links<span class="concierge-summary-state" data-status="done">');
    const changed = render([view("blog"), view("api", { state: "done" }), view("old")]);
    expect(changed).toContain('whether to publish<span class="concierge-summary-now">');
    expect(changed).not.toContain('data-status="reply"');
  });

  test("a session the AI left out: its state is the line's text, not added twice", () => {
    const summary: Summary = { ...SUMMARY, items: [{ sessionId: "old", name: "old", status: "working" }], suggestions: [] };
    expect(render(now, undefined, summary)).not.toContain("concierge-summary-state");
  });

  test("suggestions don't get a state", () => {
    const summary: Summary = { ...SUMMARY, items: [] };
    expect(render(now, undefined, summary)).not.toContain("concierge-summary-state");
  });

  test("names in the text are not links: nothing is searched for in text", () => {
    const html = render(now);
    expect(html).toContain(": answer blog first: it waited longest");
  });

  test("suggestions come under their own heading below the items", () => {
    const html = render(now);
    expect(html.indexOf("concierge-summary-heading")).toBeGreaterThan(html.indexOf("fixed the links"));
    expect(html.indexOf("answer blog first")).toBeGreaterThan(html.indexOf("concierge-summary-heading"));
  });

  test("a line whose session changed since is dimmed with its state now; one that left the screen isn't a link", () => {
    const html = render([view("blog"), view("api", { state: "done" })]);
    expect(html).toContain('<span class="concierge-summary-line is-stale">');
    expect(html).toContain('class="concierge-summary-now"');
    // "old" left the screen: its name is plain text
    expect(html).toContain("old: building");
    expect(html).not.toContain(`${LINK}old</span>`);
  });

  test("a session that can't be jumped to isn't a link", () => {
    const summary: Summary = { ...SUMMARY, items: [{ sessionId: "nojump", name: "nojump", text: "x", status: "working" }], suggestions: [] };
    expect(render([view("nojump")], undefined, summary)).toContain("nojump: x");
  });
});

describe("the advice below the dividing line", () => {
  const now = [view("blog", { state: "waiting" })];

  test("the whole line jumps to the advice's session; the names in it aren't searched for", () => {
    const html = render(now, { line: "Reply to blog first", targetId: "blog" });
    expect(html).toContain(
      '<span role="button" tabindex="0" class="concierge-summary-advice is-link fade-target">Reply to blog first</span>',
    );
  });

  test("without a session to jump to, it is plain text", () => {
    expect(render(now, { line: "Nothing to do" })).toContain('<span class="concierge-summary-advice">Nothing to do</span>');
    expect(render(now, { line: "x", targetId: "nojump" })).toContain('<span class="concierge-summary-advice">x</span>');
  });
});
