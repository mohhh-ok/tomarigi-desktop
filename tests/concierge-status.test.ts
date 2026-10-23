// The Concierge tab's bubble (docs/design.md "Concierge"; lib/concierge-status.ts): a line per session built by the app
// from its own facts on every poll, and the suggestions that come with the advice, dimmed once their session changed
import { describe, expect, test } from "bun:test";
import {
  conciergeStatusLines,
  conciergeStatusOf,
  MAX_STATUS_LINES,
  statusesAt,
  suggestionNow,
  suggestionsAt,
  suggestionsOutdated,
} from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/sessions.ts";

const view = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "working",
  sinceMs: 1000,
  ...patch,
});
// The speech bubble's text as perch/bubble.tsx gives it: the question while waiting, the summary when stopped
const bubbleOf = (v: SessionView) =>
  v.state === "waiting" ? v.question : v.state === "done" || v.state === "dozing" ? v.summary : undefined;

// Needs a reply (the longest waiting first), finished (the most recently finished first), working
const MIXED = [
  view("k1", { sinceMs: 5_000, toolName: "Bash" }),
  view("w1", { state: "waiting", sinceMs: 60_000, question: "Deploy?" }),
  view("d1", { state: "done", sinceMs: 120_000, summary: "Fixed the links" }),
  view("w2", { state: "waiting", sinceMs: 240_000, question: "Publish?" }),
  view("v", { state: "done", sinceMs: 30_000, ask: { status: "asking" }, summary: "Asks which plan to take" }),
  view("d2", { state: "dozing", sinceMs: 900_000, summary: "Wrote the report" }),
  view("d3", { state: "done", sinceMs: 10_000, continuing: true, summary: "The export runs until 19:13" }),
  view("k2", { sinceMs: 2_000 }),
];

describe("where a session stands comes from the app's facts", () => {
  test("needs a reply by the machine state or the turn verdict; done or dozing and not continuing is finished", () => {
    expect(MIXED.map((v) => [v.id, conciergeStatusOf(v)])).toEqual([
      ["k1", "working"],
      ["w1", "reply"],
      ["d1", "done"],
      ["w2", "reply"],
      ["v", "reply"],
      ["d2", "done"],
      // A finished turn whose own work goes on is working, as the advice treats it
      ["d3", "working"],
      ["k2", "working"],
    ]);
  });
});

describe("the state lines", () => {
  test("ordered: needs a reply (longest waiting first), finished (latest first), working (as given)", () => {
    const { lines, more } = conciergeStatusLines(MIXED.slice(0, 7), bubbleOf);
    expect(lines.map((l) => l.sessionId)).toEqual(["w2", "w1", "v", "d1", "d2", "k1"]);
    expect(more).toBe(1);
  });

  test("the text: the question, the turn's line, or the current tool; the state is the app's", () => {
    const { lines } = conciergeStatusLines(MIXED, bubbleOf);
    const byId = Object.fromEntries(lines.map((l) => [l.sessionId, l]));
    expect(byId.w2).toEqual({ sessionId: "w2", name: "w2", text: "Publish?", status: "reply" });
    expect(byId.v).toEqual({ sessionId: "v", name: "v", text: "Asks which plan to take", status: "reply" });
    expect(byId.d1).toEqual({ sessionId: "d1", name: "d1", text: "Fixed the links", status: "done" });
  });

  test("a working session shows its tool; one continuing in the background shows its line; none has no text", () => {
    const { lines } = conciergeStatusLines([MIXED[0], MIXED[6], MIXED[7]], bubbleOf);
    expect(lines).toEqual([
      { sessionId: "k1", name: "k1", text: "Bash", status: "working" },
      { sessionId: "d3", name: "d3", text: "The export runs until 19:13", status: "working" },
      { sessionId: "k2", name: "k2", status: "working" },
    ]);
  });

  test(`at most ${MAX_STATUS_LINES} lines; the ones cut are working ones first`, () => {
    const views = [
      ...Array.from({ length: 4 }, (_, i) => view(`k${i}`, { toolName: "Read" })),
      view("w", { state: "waiting", question: "Go?" }),
      ...Array.from({ length: 4 }, (_, i) => view(`d${i}`, { state: "done", sinceMs: (i + 1) * 1000, summary: "ok" })),
    ];
    const { lines, more } = conciergeStatusLines(views, bubbleOf);
    expect(lines.map((l) => l.sessionId)).toEqual(["w", "d0", "d1", "d2", "d3", "k0"]);
    expect(more).toBe(3);
  });

  test("rebuilt from the facts each time: a session that moved is on its new line at once", () => {
    const before = conciergeStatusLines([view("a", { state: "waiting", question: "Go?" })], bubbleOf).lines[0];
    const after = conciergeStatusLines([view("a", { toolName: "Edit" })], bubbleOf).lines[0];
    expect(before).toMatchObject({ text: "Go?", status: "reply" });
    expect(after).toMatchObject({ text: "Edit", status: "working" });
  });

  test("line breaks in a text become spaces, and the display name is the one on screen", () => {
    const { lines } = conciergeStatusLines(
      [view("root/a.jsonl", { project: "blog (2)", state: "waiting", question: "Which\n  plan?" })],
      bubbleOf,
    );
    expect(lines[0]).toMatchObject({ name: "blog (2)", text: "Which plan?" });
  });
});

describe("suggestions as kept until the next answer", () => {
  const views = [view("a", { state: "waiting" }), view("b", { state: "done" })];
  const kept = suggestionsAt(
    [
      { sessionId: "a", kind: "reply", text: "answer it first" },
      { sessionId: "b", kind: "check_result", text: "look at the build" },
      { sessionId: "gone", kind: "reply", text: "x" },
    ],
    views,
  );

  test("each keeps its session's state when it came; one whose session isn't on screen is left out", () => {
    expect(kept).toEqual([
      { sessionId: "a", kind: "reply", text: "answer it first", name: "a", status: "reply" },
      { sessionId: "b", kind: "check_result", text: "look at the build", name: "b", status: "done" },
    ]);
  });

  test("dimmed with its session's state now once that changed, or gone once it left", () => {
    expect(suggestionNow(kept[0], views)).toBeNull();
    expect(suggestionNow(kept[0], [view("a"), views[1]])).toBe("working");
    expect(suggestionNow(kept[1], [views[0], view("b", { state: "dozing" })])).toBeNull();
    expect(suggestionNow(kept[1], [views[0]])).toBe("gone");
  });
});

describe("whether opening the Concierge tab asks for suggestions", () => {
  const views = [view("a", { state: "waiting" }), view("b", { state: "done" }), view("c", { toolName: "Read" })];

  test("none at hand yet: asks", () => {
    expect(suggestionsOutdated(undefined, views)).toBe(true);
  });

  test("still as they were when the suggestions came (a new tool line or time passing aside): doesn't ask", () => {
    const at = statusesAt(views);
    expect(suggestionsOutdated(at, views)).toBe(false);
    expect(suggestionsOutdated(at, [views[0], view("b", { state: "dozing", sinceMs: 99_000 }), view("c", { toolName: "Edit" })])).toBe(false);
  });

  test("a session changed state, came, or left since: asks", () => {
    const at = statusesAt(views);
    expect(suggestionsOutdated(at, [view("a"), views[1], views[2]])).toBe(true);
    expect(suggestionsOutdated(at, [...views, view("d")])).toBe(true);
    expect(suggestionsOutdated(at, views.slice(0, 2))).toBe(true);
    // As many sessions, but another one in place of one that left
    expect(suggestionsOutdated(at, [views[0], views[1], view("d", { toolName: "Read" })])).toBe(true);
  });
});
