// Every text the concierge's bubble draws with phrases (Japanese, Chinese) is in a part with data-phrased, which gives it
// keep-all, and only those (docs/design.md "Concierge"; perch/concierge-status-report.tsx, Phrase): a name, a suggestion's
// text, a state line's text and a suggestion's 「now」 label. The Japanese dictionary is loaded for this file only, then an
// empty one, so the other files still render t() empty
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { initI18n } from "../src/lib/i18n.ts";
import { NO_BREAK_SPACE, PHRASE_BREAK } from "../src/lib/phrase-break.ts";
import type { ShownSuggestion, StatusLine } from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/sessions.ts";
import { ConciergeStatusReport } from "../src/perch/concierge-status-report.tsx";

const JA = JSON.parse(readFileSync(new URL("../public/_locales/ja/messages.json", import.meta.url), "utf8"));
const g = globalThis as Record<string, unknown>;
const saved = { fetch: g.fetch, navigator: g.navigator, document: g.document };
const load = async (dict: object) => {
  g.fetch = async () => ({ ok: true, json: async () => dict });
  await initI18n();
};

beforeAll(async () => {
  Object.defineProperty(globalThis, "navigator", { value: { language: "ja" }, configurable: true, writable: true });
  g.document = { documentElement: {} };
  await load(JA);
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
const suggestion = (text: string, name = "app-x"): ShownSuggestion => ({
  sessionId: "app-x",
  kind: "reply",
  text,
  name,
  status: "reply",
});
// The parts with data-phrased, their text as drawn
const phrasedParts = (html: string) =>
  [...html.matchAll(/<span(?: class="([^"]*)")? data-phrased="">([^<]*)<\/span>/g)].map(([, cls, text]) => ({
    cls: cls ?? "",
    text,
  }));

describe("data-phrased", () => {
  test("a suggestion's Japanese text and its 「now」 label, once its session changed", () => {
    const html = render([], [suggestion("いちばん長く待っているので先に返事を")], [view("app-x", "done")]);
    const parts = phrasedParts(html);
    expect(parts).toContainEqual({ cls: "", text: `: いちばん長く${PHRASE_BREAK}待っているので${PHRASE_BREAK}先に${PHRASE_BREAK}返事を` });
    const now = parts.find((p) => p.cls === "concierge-status-now");
    expect(now?.text).toBe(` →${NO_BREAK_SPACE}いま完了`);
  });

  test("a gone session's 「now」 label too", () => {
    const parts = phrasedParts(render([], [suggestion("先に返事を")], []));
    expect(parts.some((p) => p.cls === "concierge-status-now")).toBe(true);
  });

  test("a state line's Japanese text and a Japanese name; a space next to a kana kept from breaking", () => {
    const html = render([{ sessionId: "s", name: "日本語の名前", text: "README を更新しました", status: "done" }]);
    const parts = phrasedParts(html);
    expect(parts).toContainEqual({ cls: "concierge-status-text", text: `: README${NO_BREAK_SPACE}を${PHRASE_BREAK}更新しました` });
    expect(parts.some((p) => p.text.startsWith("日本語の"))).toBe(true);
  });

  test("English gets none, and stays as it is", () => {
    const html = render(
      [{ sessionId: "s", name: "app-x", text: "Fixed the links", status: "done" }],
      [suggestion("it has waited longest")],
      [view("app-x", "waiting")],
    );
    expect(html).not.toContain("data-phrased");
    expect(html).toContain('<span class="concierge-status-text">: Fixed the links</span>');
    expect(html).toContain(": it has waited longest");
  });
});
