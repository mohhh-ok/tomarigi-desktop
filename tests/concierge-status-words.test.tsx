// The concierge's state words are the birds' state words (docs/design.md "Concierge"): the same keys, so they read the
// same in every language. A dictionary whose every message is its own key (with the first substitution in []) is
// loaded for this file only, then an empty one, so the other files still render t() empty
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "../src/lib/i18n.ts";
import type { ShownSuggestion, StatusLine } from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/sessions.ts";
import { ConciergeStatusReport } from "../src/perch/concierge-status-report.tsx";

const KEY_DICT = new Proxy(
  {},
  { get: (_, key) => ({ message: `${String(key)}[$1$]`, placeholders: { "1": { content: "$1" } } }) },
);
const g = globalThis as Record<string, unknown>;
const saved = { fetch: g.fetch, navigator: g.navigator, document: g.document };
const load = async (dict: object) => {
  g.fetch = async () => ({ ok: true, json: async () => dict });
  await initI18n();
};

beforeAll(async () => {
  Object.defineProperty(globalThis, "navigator", { value: { language: "en" }, configurable: true, writable: true });
  g.document = { documentElement: {} };
  await load(KEY_DICT);
});
afterAll(async () => {
  await load({});
  g.fetch = saved.fetch;
  Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true, writable: true });
  g.document = saved.document;
});

const view = (id: string, state: SessionView["state"]): SessionView => ({ id, project: id, slug: id, state, sinceMs: 1000 });
const render = (lines: StatusLine[], suggestions: ShownSuggestion[] = [], sessions: SessionView[] = []) =>
  renderToStaticMarkup(
    <ConciergeStatusReport lines={lines} more={0} suggestions={suggestions} sessions={sessions} canJump={() => false} />,
  );
const suggestion = (status: ShownSuggestion["status"]): ShownSuggestion => ({
  sessionId: "blog",
  kind: "reply",
  text: "it has waited longest",
  name: "blog",
  status,
});

describe("the state words", () => {
  test("a state line says needs reply, done and working with the birds' words", () => {
    const html = render([
      { sessionId: "blog", name: "blog", text: "Publish now?", status: "reply" },
      { sessionId: "api", name: "api", text: "Fixed the links", status: "done" },
      { sessionId: "web", name: "web", status: "working" },
    ]);
    expect(html).toContain('data-status="reply"> birdWaitingLabel[]</span>');
    expect(html).toContain('data-status="done"> eventDoneLabel[]</span>');
    expect(html).toContain('data-status="working"> birdWorkingLabel[]</span>');
  });

  test("a suggestion whose session changed says its state now with the same words", () => {
    expect(render([], [suggestion("done")], [view("blog", "waiting")])).toContain("conciergeSummaryNow[birdWaitingLabel[]]");
    expect(render([], [suggestion("reply")], [view("blog", "done")])).toContain("conciergeSummaryNow[eventDoneLabel[]]");
    expect(render([], [suggestion("reply")], [view("blog", "working")])).toContain("conciergeSummaryNow[birdWorkingLabel[]]");
    expect(render([], [suggestion("reply")], [])).toContain("conciergeSummaryGone[]");
  });
});
