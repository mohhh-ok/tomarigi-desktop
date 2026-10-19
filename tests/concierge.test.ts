// The concierge's request, its reading of the answer, and when it is asked (lib/concierge.ts; docs/design.md
// "Concierge"). The API is never called: askConcierge gets a stand-in for runJudge / runOpenAiJudge
import { expect, test } from "bun:test";
import {
  adviceStillHolds,
  askConcierge,
  buildConciergePayload,
  CONCIERGE_DEBOUNCE_MS,
  CONCIERGE_EVENT_LIMIT,
  CONCIERGE_REPEAT_MS,
  CONCIERGE_TASK,
  ConciergeScheduler,
  conciergeSignature,
  parseConciergeVerdict,
  type ConciergeSessionInput,
} from "../src/lib/concierge.ts";
import type { JudgeResult, JudgeTaskDefinition } from "../src/lib/judge.ts";
import type { SessionEvent, SessionView } from "../src/lib/session-types.ts";

const NOW = 1_000_000_000;

const view = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id.toUpperCase(),
  slug: id,
  state: "working",
  sinceMs: 10_000,
  ...patch,
});

const event = (sessionId: string, type: SessionEvent["type"], secondsAgo: number, patch: Partial<SessionEvent> = {}): SessionEvent => ({
  key: `${sessionId}:${secondsAgo}:${type}`,
  sessionId,
  project: sessionId,
  type,
  at: NOW - secondsAgo * 1000,
  ...patch,
});

test("each session carries its facts; chicks are counted, not listed", () => {
  const inputs: ConciergeSessionInput[] = [
    {
      view: view("a", {
        state: "waiting",
        question: "Which database should I use?",
        chicks: [
          { id: "a/c1", name: "Explore", state: "working", sinceMs: 1 },
          { id: "a/c2", name: "Plan", state: "working", sinceMs: 1 },
          { id: "a/c3", name: "Done", state: "done", sinceMs: 1 },
        ],
      }),
      agent: "claude",
      line: "Which database should I use?",
    },
    { view: view("b", { state: "done", ask: { status: "asking", probability: 0.9 } }), line: "Merge it?" },
  ];
  const payload = buildConciergePayload(inputs, [], [], NOW, "ja");
  expect(payload.ui_language).toBe("ja");
  expect(payload.sessions[0]).toEqual({
    id: "a",
    name: "A",
    agent: "claude",
    state: "waiting",
    needs_reply: true,
    seconds_since_last_activity: 10,
    line: "Which database should I use?",
    question: "Which database should I use?",
    chicks_working: 2,
  });
  expect(payload.sessions[1]).toMatchObject({ id: "b", needs_reply: true, jev: { asking: true, probability: 0.9 } });
  expect(JSON.stringify(payload)).not.toContain("Explore");
});

test("watch links come from the caller; a watching session is held up by a peer that needs a reply", () => {
  const parent = view("p", {
    state: "done",
    watching: 1,
    peers: [{ sessionId: "c", viewId: "c", name: "c", active: true }],
  });
  const child = view("c", { state: "waiting", peers: [{ sessionId: "p", viewId: "p", name: "p", active: false }] });
  const payload = buildConciergePayload([{ view: parent }, { view: child, parentId: "p" }], [], [], NOW, "en");
  expect(payload.sessions[0].watch_children).toEqual(["c"]);
  expect(payload.sessions[1].watch_parent).toBe("p");
  expect(payload.holds).toEqual([{ waiting_session: "p", held_up_by: "c", reason: "linked_session_needs_reply" }]);
});

test("a chick waiting on a reply holds up its parent", () => {
  const parent = view("p", { chicks: [{ id: "p/c1", name: "reviewer", state: "waiting", sinceMs: 1 }] });
  const payload = buildConciergePayload([{ view: parent }], [], [], NOW, "en");
  expect(payload.holds).toEqual([{ waiting_session: "p", held_up_by: "chick:reviewer", reason: "chick_needs_reply" }]);
});

test("events and jumps are merged oldest first, only for sessions sent, the last 20", () => {
  const events = [
    event("a", "waiting", 300),
    event("b", "done", 200, { ask: { status: "asking" } }),
    event("b", "started", 100),
    event("gone", "done", 50),
    event("a", "closed", 40),
  ];
  const payload = buildConciergePayload([{ view: view("a") }, { view: view("b") }], events, [{ sessionId: "b", at: NOW - 150_000 }], NOW, "en");
  expect(payload.recent_events).toEqual([
    { seconds_ago: 300, kind: "needs_reply", session: "a" },
    { seconds_ago: 200, kind: "needs_reply", session: "b" },
    { seconds_ago: 150, kind: "jump", session: "b" },
    { seconds_ago: 100, kind: "user_replied", session: "b" },
  ]);

  const many = Array.from({ length: 30 }, (_, i) => event("a", "done", 1000 - i));
  const capped = buildConciergePayload([{ view: view("a") }], many, [], NOW, "en");
  expect(capped.recent_events.length).toBe(CONCIERGE_EVENT_LIMIT);
  expect(capped.recent_events.at(-1)?.seconds_ago).toBe(971);
});

test("long questions and lines are cut", () => {
  const long = "x".repeat(500);
  const payload = buildConciergePayload([{ view: view("a", { state: "waiting", question: long }), line: long }], [], [], NOW, "en");
  expect(payload.sessions[0].question!.length).toBeLessThan(130);
  expect(payload.sessions[0].line!.length).toBeLessThan(130);
});

test("the answer: empty advice is no advice; an id that wasn't sent leaves no jump target", () => {
  const sent = new Set(["a", "b"]);
  expect(parseConciergeVerdict({ advice: "  ", session_id: "a" }, sent)).toBeNull();
  expect(parseConciergeVerdict({ advice: "Reply to A first", session_id: "a" }, sent)).toEqual({
    line: "Reply to A first",
    targetId: "a",
  });
  expect(parseConciergeVerdict({ advice: "Reply to Z", session_id: "z" }, sent)).toEqual({ line: "Reply to Z" });
  expect(parseConciergeVerdict({ advice: "Look at the sessions", session_id: "" }, sent)).toEqual({
    line: "Look at the sessions",
  });
  expect(parseConciergeVerdict(null, sent)).toBeNull();
});

test("askConcierge sends one request with the task and payload, and returns the advice", async () => {
  const calls: { task: JudgeTaskDefinition; payload: unknown }[] = [];
  const run = async <V>(task: JudgeTaskDefinition, payload: unknown): Promise<JudgeResult<V>> => {
    calls.push({ task, payload });
    return { ok: true, verdict: { advice: "Go back to A", session_id: "a" } as V };
  };
  const payload = buildConciergePayload([{ view: view("a", { state: "waiting" }) }], [], [], NOW, "en");
  const result = await askConcierge("anthropic", payload, run);
  expect(calls.length).toBe(1);
  expect(calls[0].task).toBe(CONCIERGE_TASK);
  expect(calls[0].payload).toBe(payload);
  expect(result).toEqual({ ok: true, verdict: { line: "Go back to A", targetId: "a" } });

  const failing = async <V>(): Promise<JudgeResult<V>> => ({ ok: false, kind: "rate_limit", status: 429 });
  expect(await askConcierge("openai", payload, failing)).toEqual({ ok: false, kind: "rate_limit", status: 429 });
});

test("the task asks for two strings and states that the input is untrusted", () => {
  expect(Object.keys(CONCIERGE_TASK.outputFields)).toEqual(["advice", "session_id"]);
  expect(CONCIERGE_TASK.systemPrompt).toContain("untrusted");
});

test("the signature changes on needs reply, the user replying, and done, not on dozing or time", () => {
  const base = conciergeSignature([view("a", { state: "done" })]);
  expect(conciergeSignature([view("a", { state: "dozing", sinceMs: 999_999 })])).toBe(base);
  expect(conciergeSignature([view("a", { state: "waiting" })])).not.toBe(base);
  expect(conciergeSignature([view("a", { state: "done", ask: { status: "asking" } })])).not.toBe(base);
  expect(conciergeSignature([view("a", { state: "working" })])).not.toBe(base);
  expect(conciergeSignature([view("a", { state: "done" }), view("b")])).not.toBe(base);
});

/** Timers driven by hand: advance(ms) runs what is due, in order */
function fakeTimers() {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        pending.set(++next, { at: now + ms, fn });
        return next;
      },
      clear: (handle: unknown) => void pending.delete(handle as number),
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

test("changes that come together make one request, 3 seconds after the last", () => {
  const clock = fakeTimers();
  let requests = 0;
  const scheduler = new ConciergeScheduler(() => requests++, clock.timers);
  scheduler.update("s1", false, true);
  clock.advance(2_000);
  scheduler.update("s2", false, true);
  clock.advance(2_000);
  expect(requests).toBe(0);
  clock.advance(1_000);
  expect(requests).toBe(1);
  // The same signature again doesn't ask
  scheduler.update("s2", false, true);
  clock.advance(CONCIERGE_DEBOUNCE_MS * 2);
  expect(requests).toBe(1);
});

test("asked again every 5 minutes while something needs a reply, not while nothing waits", () => {
  const clock = fakeTimers();
  let requests = 0;
  const scheduler = new ConciergeScheduler(() => requests++, clock.timers);
  scheduler.update("waiting", true, true);
  clock.advance(CONCIERGE_DEBOUNCE_MS);
  expect(requests).toBe(1);
  clock.advance(CONCIERGE_REPEAT_MS);
  expect(requests).toBe(2);
  clock.advance(CONCIERGE_REPEAT_MS);
  expect(requests).toBe(3);
  // Nothing waits any more: one request for the change, then no repeat
  scheduler.update("calm", false, true);
  clock.advance(CONCIERGE_DEBOUNCE_MS);
  expect(requests).toBe(4);
  clock.advance(CONCIERGE_REPEAT_MS * 3);
  expect(requests).toBe(4);
});

test("without a key nothing is asked, and saving one asks again", () => {
  const clock = fakeTimers();
  let requests = 0;
  const scheduler = new ConciergeScheduler(() => requests++, clock.timers);
  scheduler.update("s", true, false);
  clock.advance(CONCIERGE_REPEAT_MS);
  expect(requests).toBe(0);
  scheduler.update("s", true, true);
  clock.advance(CONCIERGE_DEBOUNCE_MS);
  expect(requests).toBe(1);
  scheduler.update("s", true, false);
  clock.advance(CONCIERGE_REPEAT_MS * 2);
  expect(requests).toBe(1);
});

test("advice kept after a failed request stays only while its target is in the state it was in", () => {
  const advice = { line: "Reply to A", targetId: "a" };
  const waiting = [view("a", { state: "waiting" })];
  expect(adviceStillHolds(advice, "reply", waiting)).toBe(true);
  // The user replied: A is working again
  expect(adviceStillHolds(advice, "reply", [view("a", { state: "working" })])).toBe(false);
  // A left the screen
  expect(adviceStillHolds(advice, "reply", [view("b")])).toBe(false);
  // Advice without a target stays
  expect(adviceStillHolds({ line: "All calm" }, undefined, [view("b")])).toBe(true);
});
