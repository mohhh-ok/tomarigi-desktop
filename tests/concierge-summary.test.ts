// "What's going on?" in "Concierge only" (docs/design.md "Concierge"; issue #6): the concierge sums up every session at
// the user's timing. The summary stays in the bubble until closed with ×; an advice that comes meanwhile goes below it
import { describe, expect, test } from "bun:test";
import type { JudgeRunner } from "../src/lib/ai-judge.ts";
import { buildConciergePayload } from "../src/lib/concierge.ts";
import {
  askConciergeSummary,
  CONCIERGE_SUMMARY_TASK,
  conciergeBubbleParts,
  nextSummaryState,
  parseConciergeSummary,
  summaryEntryNow,
  summaryStatusOf,
  type Summary,
  type SummaryState,
} from "../src/lib/concierge-summary.ts";
import { verdictSchema } from "../src/lib/judge.ts";
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
const payloadOf = (views: SessionView[]) =>
  buildConciergePayload(
    views.map((v) => ({ view: v })),
    [],
    [],
    NOW,
    "en",
  );
const payload = payloadOf([view("blog", { state: "waiting", question: "Publish now?" }), view("api")]);
const answering =
  (verdict: unknown): JudgeRunner =>
  async () =>
    ({ ok: true, verdict }) as never;
const I = (session_id: string, text: string) => ({ session_id, text });

// Needs a reply (the longest waiting first), finished (the most recently finished first), working
const MIXED = [
  view("w1", { state: "waiting", sinceMs: 60_000, question: "Deploy?" }),
  view("w2", { state: "waiting", sinceMs: 240_000, question: "Publish?" }),
  view("v", { state: "done", sinceMs: 30_000, ask: { status: "asking" } as never }),
  view("d1", { state: "done", sinceMs: 120_000 }),
  view("d2", { state: "dozing", sinceMs: 900_000 }),
  view("d3", { state: "done", sinceMs: 10_000, continuing: true }),
  view("k1", { sinceMs: 5_000 }),
];
const mixed = payloadOf(MIXED).sessions;

describe("whether a session needs a reply, is done, or is working comes from the app's facts", () => {
  test("needs a reply by needs_reply; done or dozing and not continuing is finished; the rest is working", () => {
    expect(MIXED.map((v) => [v.id, summaryStatusOf(v)])).toEqual([
      ["w1", "reply"],
      ["w2", "reply"],
      ["v", "reply"],
      ["d1", "done"],
      ["d2", "done"],
      // Finished its turn, but its work goes on in the background
      ["d3", "working"],
      ["k1", "working"],
    ]);
  });
});

describe("the answer: one object per session, put in order in code", () => {
  const all = mixed.map((s) => I(s.id, `${s.id} text`));

  test("items: needs a reply (longest waiting first), then finished (most recent first), then working", () => {
    const got = parseConciergeSummary({ items: all, suggestions: [] }, mixed, NOW)!;
    expect(got.summary.madeAt).toBe(NOW);
    expect(got.summary.items.map((e) => [e.sessionId, e.status])).toEqual([
      ["w2", "reply"],
      ["w1", "reply"],
      ["v", "reply"],
      ["d1", "done"],
      ["d2", "done"],
      ["d3", "working"],
    ]);
    // Cut at 6 after sorting, so working ones go first; the rest is counted
    expect(got.summary.more).toBe(1);
    expect(got.summary.items[0]).toEqual({ sessionId: "w2", name: "w2", text: "w2 text", status: "reply" });
  });

  test("working ones keep the AI's order", () => {
    const sessions = payloadOf([view("a"), view("b"), view("c")]).sessions;
    const got = parseConciergeSummary({ items: [I("c", "c"), I("a", "a"), I("b", "b")], suggestions: [] }, sessions, NOW);
    expect(got!.summary.items.map((e) => e.sessionId)).toEqual(["c", "a", "b"]);
  });

  test("an unknown id is dropped and reported; a session left out gets a line with its state only", () => {
    const got = parseConciergeSummary(
      { items: [I("zzz", "who?"), I("blog", "whether to publish")], suggestions: [I("nope", "x")] },
      payload.sessions,
      NOW,
    )!;
    expect(got.dropped).toEqual(["zzz", "nope"]);
    expect(got.summary.items).toEqual([
      { sessionId: "blog", name: "blog", text: "whether to publish", status: "reply" },
      { sessionId: "api", name: "api", status: "working" },
    ]);
  });

  test("one object per session: a second one for the same session is dropped", () => {
    const got = parseConciergeSummary({ items: [I("api", "first"), I("api", "second")], suggestions: [] }, payload.sessions, NOW)!;
    expect(got.summary.items.find((e) => e.sessionId === "api")?.text).toBe("first");
  });

  test("text is one trimmed line, without the session's name when the AI still wrote it", () => {
    const got = parseConciergeSummary(
      { items: [I("blog", " blog: whether to\npublish now "), I("api", "  ")], suggestions: [] },
      payload.sessions,
      NOW,
    )!;
    expect(got.summary.items).toEqual([
      { sessionId: "blog", name: "blog", text: "whether to publish now", status: "reply" },
      { sessionId: "api", name: "api", status: "working" },
    ]);
  });

  test("suggestions: at most 3, in the AI's order, with their sessions' states", () => {
    const got = parseConciergeSummary(
      {
        items: all,
        suggestions: [I("k1", "check it"), I("w2", "answer it"), I("d1", "review it"), I("w1", "fourth")],
      },
      mixed,
      NOW,
    )!;
    expect(got.summary.suggestions).toEqual([
      { sessionId: "k1", name: "k1", text: "check it", status: "working" },
      { sessionId: "w2", name: "w2", text: "answer it", status: "reply" },
      { sessionId: "d1", name: "d1", text: "review it", status: "done" },
    ]);
  });

  test("an answer without items is a failure", () => {
    expect(parseConciergeSummary({ summary: "blog waits" }, payload.sessions, NOW)).toBeNull();
    expect(parseConciergeSummary({}, payload.sessions, NOW)).toBeNull();
    expect(parseConciergeSummary(null, payload.sessions, NOW)).toBeNull();
  });
});

describe("a summary goes out of date", () => {
  const entry = { sessionId: "blog", name: "blog", text: "whether to publish", status: "reply" as const };

  test("unchanged: shown as it is; changed: its state now; left the screen: gone", () => {
    expect(summaryEntryNow(entry, [view("blog", { state: "waiting" })])).toBeNull();
    expect(summaryEntryNow(entry, [view("blog")])).toBe("working");
    expect(summaryEntryNow(entry, [view("blog", { state: "done" })])).toBe("done");
    expect(summaryEntryNow(entry, [view("api")])).toBe("gone");
  });
});

describe("asking", () => {
  test("asked with the same facts as the advice, with short references in place of the long ids", async () => {
    const blog = "root-1/blog/0b6f2c1e-8a4d-4f7e-9c3a-2d5e7f9a1b3c.jsonl";
    const api = "root-1/api/5e7f9a1b-3c0b-6f2c-1e8a-4d4f7e9c3a2d.jsonl";
    const long = buildConciergePayload(
      [
        { view: view(blog, { project: "blog", state: "waiting" }) },
        { view: view(api, { project: "api" }), parentId: blog },
      ],
      [],
      [],
      NOW,
      "en",
    );
    let sent: { sessions: { id: string; name: string; watch_parent?: string }[] } | undefined;
    const run: JudgeRunner = async (task, body) => {
      sent = body as never;
      expect(task.name).toBe(CONCIERGE_SUMMARY_TASK.name);
      return { ok: true, verdict: { items: [I("s2", "building"), I("s1", "whether to publish")], suggestions: [I("s1", "answer it")] } } as never;
    };
    const got = await askConciergeSummary("openai", long, run, NOW);
    // The answer's references are read back as the sessions they stand for
    expect(got).toEqual({
      ok: true,
      verdict: {
        summary: {
          madeAt: NOW,
          items: [
            { sessionId: blog, name: "blog", text: "whether to publish", status: "reply" },
            { sessionId: api, name: "api", text: "building", status: "working" },
          ],
          more: 0,
          suggestions: [{ sessionId: blog, name: "blog", text: "answer it", status: "reply" }],
        },
        dropped: [],
      },
    });
    expect(sent!.sessions.map((s) => [s.id, s.name, s.watch_parent])).toEqual([
      ["s1", "blog", undefined],
      ["s2", "api", "s1"],
    ]);
    // Everything else is sent as built, and the payload itself isn't changed
    expect({ ...sent, sessions: undefined }).toEqual({ ...long, sessions: undefined } as never);
    expect(long.sessions[0].id).toBe(blog);
  });

  test("the answer is items and suggestions, each an object with a session id and a text", () => {
    const { properties } = verdictSchema(CONCIERGE_SUMMARY_TASK);
    for (const key of ["items", "suggestions"]) {
      const field = properties[key] as { type: string; items: { properties: object } };
      expect(field.type).toBe("array");
      expect(Object.keys(field.items.properties)).toEqual(["session_id", "text"]);
    }
  });

  test("the prompt: one object per session, no name in the text, suggestions with why, order left to the app", () => {
    const p = CONCIERGE_SUMMARY_TASK.systemPrompt;
    expect(p).toContain("one object per session");
    expect(p).toContain("without its name");
    expect(p).toContain("and why");
    expect(p).toContain("the app puts the items in order");
    // The state comes from the app (a session that said it will report its result is still working)
    expect(p).toContain("Never write a session's state in a text");
    expect(p).toContain("still working, not finished");
    expect(p).toContain("untrusted input");
  });

  test("an empty or unreadable answer is a failure the user sees", async () => {
    expect(await askConciergeSummary("anthropic", payload, answering({ lines: [] }))).toMatchObject({
      ok: false,
      kind: "malformed",
    });
    const local: JudgeRunner = async () => ({ ok: false, kind: "malformed", message: LOCAL_NO_MATCHING_JSON }) as never;
    expect(await askConciergeSummary("local", payload, local)).toMatchObject({ ok: false, kind: "malformed" });
    const down: JudgeRunner = async () => ({ ok: false, kind: "server", status: 503 }) as never;
    expect(await askConciergeSummary("openai", payload, down)).toMatchObject({ ok: false, kind: "server" });
  });
});

const summary = (madeAt: number): Summary => ({ madeAt, items: [], more: 0, suggestions: [] });

test("pressing, the answer, a failure, ×, and pressing again", () => {
  let s: SummaryState = { kind: "idle" };
  s = nextSummaryState(s, { type: "ask", seq: 1 });
  expect(s).toEqual({ kind: "loading", seq: 1 });
  // An older request that comes back after a newer press is dropped
  expect(nextSummaryState(s, { type: "answer", seq: 0, summary: summary(0) })).toBe(s);
  s = nextSummaryState(s, { type: "answer", seq: 1, summary: summary(1) });
  expect(s).toEqual({ kind: "shown", summary: summary(1) });
  // Pressing again makes a new summary
  s = nextSummaryState(s, { type: "ask", seq: 2 });
  expect(s).toEqual({ kind: "loading", seq: 2 });
  s = nextSummaryState(s, { type: "fail", seq: 2 });
  expect(s).toEqual({ kind: "failed" });
  s = nextSummaryState(s, { type: "close" });
  expect(s).toEqual({ kind: "idle" });
  // Closed while it was on its way: the answer doesn't bring it back
  s = nextSummaryState(nextSummaryState(s, { type: "ask", seq: 3 }), { type: "close" });
  expect(nextSummaryState(s, { type: "answer", seq: 3, summary: summary(3) })).toEqual({ kind: "idle" });
});

test("the bubble: the summary on top, an advice that came meanwhile below it; closed, the advice alone", () => {
  const advice = { line: "Reply to blog first", targetId: "blog" };
  const shown = { kind: "shown" as const, summary: summary(1) };
  expect(conciergeBubbleParts(shown, advice)).toEqual({ summary: shown, advice });
  expect(conciergeBubbleParts(shown, null)).toEqual({ summary: shown });
  expect(conciergeBubbleParts({ kind: "loading", seq: 1 }, advice)).toEqual({ summary: { kind: "loading" }, advice });
  expect(conciergeBubbleParts({ kind: "failed" }, null)).toEqual({ summary: { kind: "failed" } });
  expect(conciergeBubbleParts({ kind: "idle" }, advice)).toEqual({ advice });
  expect(conciergeBubbleParts({ kind: "idle" }, null)).toEqual({});
});
