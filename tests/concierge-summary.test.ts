// "What's going on?" in "Concierge only" (docs/design.md "Concierge"; issue #6): the concierge sums up every session at
// the user's timing. The summary stays in the bubble until closed with ×; an advice that comes meanwhile goes below it
import { expect, test } from "bun:test";
import type { JudgeRunner } from "../src/lib/ai-judge.ts";
import { buildConciergePayload } from "../src/lib/concierge.ts";
import {
  askConciergeSummary,
  CONCIERGE_SUMMARY_TASK,
  conciergeBubbleParts,
  nextSummaryState,
  parseConciergeSummary,
  type SummaryState,
} from "../src/lib/concierge-summary.ts";
import { LOCAL_NO_MATCHING_JSON } from "../src/lib/local-judge.ts";
import type { SessionView } from "../src/lib/sessions.ts";

const NOW = 1_000_000;
const view = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "working",
  sinceMs: 1000,
  ...patch,
});
const payload = buildConciergePayload(
  [
    { view: view("blog", { state: "waiting", question: "Publish now?" }) },
    { view: view("api") },
    { view: view("docs", { state: "done", summary: "Fixed the links" }) },
  ],
  [],
  [],
  NOW,
  "en",
);
const answering =
  (verdict: unknown): JudgeRunner =>
  async () =>
    ({ ok: true, verdict }) as never;

test("the summary is a few trimmed lines; blank lines dropped, cut at 6", () => {
  expect(parseConciergeSummary({ summary: "  blog waits for your reply \n\n api is working\n" })).toBe(
    "blog waits for your reply\napi is working",
  );
  const many = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
  expect(parseConciergeSummary({ summary: many })?.split("\n")).toHaveLength(6);
  expect(parseConciergeSummary({ summary: "  \n " })).toBeNull();
  expect(parseConciergeSummary({})).toBeNull();
  expect(parseConciergeSummary(null)).toBeNull();
});

test("asked with the same facts as the advice, in its own output form", async () => {
  let sent: unknown;
  const run: JudgeRunner = async (task, body) => {
    sent = body;
    expect(task.name).toBe(CONCIERGE_SUMMARY_TASK.name);
    return { ok: true, verdict: { summary: "blog waits for your reply\napi is working" } } as never;
  };
  expect(await askConciergeSummary("openai", payload, run)).toEqual({
    ok: true,
    verdict: "blog waits for your reply\napi is working",
  });
  expect(sent).toBe(payload);
});

test("the prompt puts sessions that need a reply first and names each session", () => {
  expect(CONCIERGE_SUMMARY_TASK.systemPrompt).toContain("needs a reply first");
  // What it waits for and what it did, not only its name
  expect(CONCIERGE_SUMMARY_TASK.systemPrompt).toContain("then what it waits for");
  expect(CONCIERGE_SUMMARY_TASK.systemPrompt).toContain("then what it did");
  expect(CONCIERGE_SUMMARY_TASK.systemPrompt).toContain("by its name");
  expect(CONCIERGE_SUMMARY_TASK.systemPrompt).toContain("untrusted input");
});

test("an empty or unreadable answer is a failure the user sees", async () => {
  expect(await askConciergeSummary("anthropic", payload, answering({ summary: "" }))).toMatchObject({
    ok: false,
    kind: "malformed",
  });
  const local: JudgeRunner = async () => ({ ok: false, kind: "malformed", message: LOCAL_NO_MATCHING_JSON }) as never;
  expect(await askConciergeSummary("local", payload, local)).toMatchObject({ ok: false, kind: "malformed" });
  const down: JudgeRunner = async () => ({ ok: false, kind: "server", status: 503 }) as never;
  expect(await askConciergeSummary("openai", payload, down)).toMatchObject({ ok: false, kind: "server" });
});

test("pressing, the answer, a failure, ×, and pressing again", () => {
  let s: SummaryState = { kind: "idle" };
  s = nextSummaryState(s, { type: "ask", seq: 1 });
  expect(s).toEqual({ kind: "loading", seq: 1 });
  // An older request that comes back after a newer press is dropped
  expect(nextSummaryState(s, { type: "answer", seq: 0, text: "old" })).toBe(s);
  s = nextSummaryState(s, { type: "answer", seq: 1, text: "blog waits" });
  expect(s).toEqual({ kind: "shown", text: "blog waits" });
  // Pressing again makes a new summary
  s = nextSummaryState(s, { type: "ask", seq: 2 });
  expect(s).toEqual({ kind: "loading", seq: 2 });
  s = nextSummaryState(s, { type: "fail", seq: 2 });
  expect(s).toEqual({ kind: "failed" });
  s = nextSummaryState(s, { type: "close" });
  expect(s).toEqual({ kind: "idle" });
  // Closed while it was on its way: the answer doesn't bring it back
  s = nextSummaryState(nextSummaryState(s, { type: "ask", seq: 3 }), { type: "close" });
  expect(nextSummaryState(s, { type: "answer", seq: 3, text: "late" })).toEqual({ kind: "idle" });
});

test("the bubble: the summary on top, an advice that came meanwhile below it; closed, the advice alone", () => {
  const advice = { line: "Reply to blog first" };
  expect(conciergeBubbleParts({ kind: "shown", text: "blog waits" }, advice)).toEqual({
    summary: { kind: "shown", text: "blog waits" },
    advice: "Reply to blog first",
  });
  expect(conciergeBubbleParts({ kind: "shown", text: "blog waits" }, null)).toEqual({
    summary: { kind: "shown", text: "blog waits" },
  });
  expect(conciergeBubbleParts({ kind: "loading", seq: 1 }, advice)).toEqual({
    summary: { kind: "loading" },
    advice: "Reply to blog first",
  });
  expect(conciergeBubbleParts({ kind: "failed" }, null)).toEqual({ summary: { kind: "failed" } });
  expect(conciergeBubbleParts({ kind: "idle" }, advice)).toEqual({ advice: "Reply to blog first" });
  expect(conciergeBubbleParts({ kind: "idle" }, null)).toEqual({});
});
