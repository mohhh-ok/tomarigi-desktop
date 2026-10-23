// The concierge's bubble (docs/design.md "Concierge"; perch/concierge-status-report.tsx): a line per session built by the
// app as 「<name>: <text> <state>」 with the name linking to its session, then the suggestions under their heading. No
// name is searched for in text. Dictionaries aren't loaded here, so the app's own words (t()) render empty
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShownSuggestion, StatusLine } from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/sessions.ts";
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

describe("the state lines", () => {
  test("「<name>: <text>」 with the name linking to its session and the app's state after the text", () => {
    const html = render();
    expect(html).toContain(`${LINK}blog</span>: Publish now?<span class="concierge-status-state" data-status="reply">`);
    expect(html).toContain(`${LINK}api</span>: Fixed the links<span class="concierge-status-state" data-status="done">`);
    // No text: only the state, without a second state after it
    expect(html).toContain(`${LINK}web</span>: </span>`);
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
  test("under their heading after the lines, each with its session's name as a link; no advice line of its own", () => {
    const html = render();
    expect(html.indexOf("concierge-status-heading")).toBeGreaterThan(html.indexOf("Fixed the links"));
    expect(html).toContain(`<span class="concierge-status-line">${LINK}blog</span>: it has waited longest</span>`);
  });

  test("none: no heading", () => {
    expect(render(NOW, [])).not.toContain("concierge-status-heading");
  });

  test("dimmed with its session's state now once that changed; gone is no longer a link", () => {
    const moved = render([view("root/blog.jsonl", { project: "blog" }), NOW[1], NOW[2]]);
    expect(moved).toContain('<span class="concierge-status-line is-stale">');
    expect(moved).toContain('class="concierge-status-now"');
    const gone = render([NOW[1], NOW[2]]);
    expect(gone).toContain('<span class="concierge-status-line is-stale">blog: it has waited longest');
  });
});
