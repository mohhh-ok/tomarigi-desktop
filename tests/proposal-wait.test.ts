// A Claude desktop app session that ends its turn leaving a proposal card (start_session's `Proposed "…" (task_id: …)`)
// waits on the user to start it, as a question tool does (docs/design.md "The "?" for sessions waiting on you"). Before,
// a parent ended on 「カードを出しているので、始めてください」, the turn verdict was not asking, and the concierge said nothing
// needed a reply (the user: 「はんのうしてない」). The wait is told from the tool calls in the transcript, not the reply's
// text, and it ends when a session started from the card links to the parent, or the next turn starts
import { describe, expect, test } from "bun:test";
import type { NativeFile } from "../src/lib/native-fs.ts";
import { deriveSessionEvents } from "../src/lib/session-events.ts";
import { pendingProposalsOf, readTail } from "../src/lib/transcript.ts";
import { unstartedProposals, type ProposalChild } from "../src/lib/proposals.ts";

function fileOf(lines: object[]): NativeFile {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    path: "/tmp/t.jsonl",
    name: "t.jsonl",
    size: bytes.length,
    lastModified: 0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
}

const START = "mcp__ccd_session__start_session";
const DISMISS = "mcp__ccd_session__dismiss_task";
const CHILD = "local_0a1b2c3d-0000-4000-8000-000000000002";
const OTHER = "local_0a1b2c3d-0000-4000-8000-000000000003";
const at = (s: number) => new Date(Date.parse("2026-11-12T12:50:00.000Z") + s * 1000).toISOString();
const ms = (s: number) => Date.parse(at(s));

let n = 0;
const prompt = (s: number, text = "直して") => ({ type: "user", timestamp: at(s), turnOrigin: "human", message: { content: text } });
const call = (s: number, name: string, input: object) => ({
  type: "assistant",
  timestamp: at(s),
  message: { content: [{ type: "tool_use", id: `t${++n}`, name, input }] },
});
const result = (s: number, text: string) => ({
  type: "user",
  timestamp: at(s),
  message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: [{ type: "text", text }] }] },
});
const reply = (s: number, text: string) => ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text }] } });
const proposed = (s: number, task: string, title: string) => [
  call(s, START, { initiation: "own_initiative", context: "fresh", title, prompt: "…" }),
  result(s + 1, `Proposed "${title}" (task_id: ${task}). The user sees a card and nothing runs until they start it`),
];
const startedHere = (s: number, id: string) => [
  call(s, START, { initiation: "user_asked", context: "fresh", title: "別件", prompt: "…" }),
  result(s + 1, `Started session "別件" (session_id: ${id}, name: x). It runs on its own`),
];

const TITLE = "検索結果に画像を出す";
// The reported scene: an own_initiative card, then 「始めてください」
const reported = [prompt(0), ...proposed(10, "task_0000aaaa", TITLE), reply(20, "カードを出しているので、始めてください。")];

// A session linked to the parent, as the scan sees it: started from a card (first prompt by the app) at second s
const child = (s: number, extra: Partial<ProposalChild> = {}): ProposalChild => ({
  startedAt: ms(s),
  hostSessionId: CHILD,
  startedBySession: true,
  ...extra,
});

describe("which proposal cards the parent still waits on", () => {
  test.each<[string, object[], ProposalChild[], string[]]>([
    ["the reported scene: a card, nothing started from it yet", reported, [], ["task_0000aaaa"]],
    ["the reported scene: the session started from the card linked", reported, [child(60)], []],
    ["a linked session started before the card isn't from it", reported, [child(5)], ["task_0000aaaa"]],
    ["a linked session the user started isn't from a card", reported, [child(60, { startedBySession: false })], ["task_0000aaaa"]],
    ["a linked session whose start isn't known isn't counted", reported, [child(60, { startedAt: undefined })], ["task_0000aaaa"]],
    [
      "a session the turn's own start_session started isn't from the card",
      [prompt(0), ...proposed(10, "task_1", TITLE), ...startedHere(12, OTHER), reply(20, "どうぞ")],
      [child(13, { hostSessionId: OTHER })],
      ["task_1"],
    ],
    ["withdrawn with dismiss_task", [prompt(0), ...proposed(10, "task_1", TITLE), call(12, DISMISS, { task_id: "task_1" }), reply(20, "取り下げました")], [], []],
    [
      "withdrawn and proposed again: the new card waits",
      [prompt(0), ...proposed(10, "task_1", TITLE), call(12, DISMISS, { task_id: "task_1" }), ...proposed(14, "task_2", TITLE), reply(20, "どうぞ")],
      [],
      ["task_2"],
    ],
    ["started by the session itself with proposal_id", [prompt(0), ...proposed(10, "task_1", TITLE), call(12, START, { proposal_id: "task_1" }), reply(20, "始めました")], [], []],
    ["the next turn started: the wait is over", [...reported, prompt(30, "はい")], [], []],
    [
      "a side-sessions event starts the next turn too",
      [...reported, { type: "user", timestamp: at(30), turnOrigin: "sdk", message: { content: "<side-sessions-event>x" } }],
      [],
      [],
    ],
    [
      "two cards, one started: the newer still waits",
      [prompt(0), ...proposed(10, "task_1", "A"), ...proposed(12, "task_2", "B"), reply(20, "どうぞ")],
      [child(60)],
      ["task_2"],
    ],
    ["a session started right away (user_asked) is no card", [prompt(0), ...startedHere(10, OTHER), reply(20, "立てました")], [], []],
    [
      "an offer the user answered within the call is no card",
      [
        prompt(0),
        call(10, START, { initiation: "offer", title: TITLE }),
        result(11, `The user chose "New session" — the session is already opening for "${TITLE}" (task_id: task_1).`),
        reply(20, "立てます"),
      ],
      [],
      [],
    ],
    [
      "a card the app refused to make is no card",
      [prompt(0), call(10, START, { initiation: "own_initiative", cwd: "/x" }), result(11, "A proposal card cannot carry a host, folder"), reply(20, "x")],
      [],
      [],
    ],
  ])("%s", async (_, lines, children, want) => {
    const tail = await readTail(fileOf(lines));
    expect(unstartedProposals(pendingProposalsOf(tail.events), children).map((p) => p.taskId)).toEqual(want);
  });

  test("the card's title is kept for the bubble and the concierge", async () => {
    const tail = await readTail(fileOf(reported));
    expect(pendingProposalsOf(tail.events)?.proposals).toEqual([{ taskId: "task_0000aaaa", title: TITLE, at: ms(11) }]);
  });
});

describe("Recent activity", () => {
  const eventsOf = async (lines: object[]) => {
    const tail = await readTail(fileOf(lines));
    return deriveSessionEvents(tail, "s", "app-x", [], new Map(), undefined, ms(600)).map((e) => [e.type, e.at, !!e.wrapUpAsk]);
  };
  test("the turn that leaves a card is a needs reply at its closing text, not a done", async () => {
    // Not marked wrapUpAsk: only the user can start a card, so a parent that takes the session over can't answer it
    expect(await eventsOf(reported)).toEqual([
      ["started", ms(0), false],
      ["waiting", ms(20), false],
    ]);
  });
  test("a card withdrawn within the turn leaves a done", async () => {
    const lines = [prompt(0), ...proposed(10, "task_1", TITLE), call(12, DISMISS, { task_id: "task_1" }), reply(20, "取り下げました")];
    expect((await eventsOf(lines)).map(([type]) => type)).toEqual(["started", "done"]);
  });
});
