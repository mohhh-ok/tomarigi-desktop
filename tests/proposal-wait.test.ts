// A Claude desktop app session that ends its turn leaving a proposal card (start_session's `Proposed "…" (task_id: …)`)
// waits on the user to start it, as a question tool does (docs/design.md "The "?" for sessions waiting on you"). Before,
// a parent ended its turn asking the user to start its card, the turn verdict was not asking, and the concierge said nothing
// needed a reply. The wait is told from the tool calls in the transcript, not the reply's text; a card is started when
// the desktop app's record of a session says it came from that card; the next turn ends the wait too
import { describe, expect, test } from "bun:test";
import type { NativeFile } from "../src/lib/native-fs.ts";
import { deriveSessionEvents } from "../src/lib/session-events.ts";
import { deriveState, replyWaitOf } from "../src/lib/bird-state.ts";
import { pendingProposalsOf, readTail } from "../src/lib/transcript.ts";
import { cardKey, unstartedProposals } from "../src/lib/proposals.ts";

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
const WRAP_UP = "mcp__ccd_turn__wrap_up";
const PARENT = "local_0a1b2c3d-0000-4000-8000-000000000001";
const OTHER_PARENT = "local_0a1b2c3d-0000-4000-8000-000000000009";
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

const TITLE = "検索結果に画像を出す";
// The reported scene: an own_initiative card, then a reply asking the user to start it
const reported = [prompt(0), ...proposed(10, "task_0000aaaa", TITLE), reply(20, "カードを出しました。押してください。")];
const startedFromCard = (parent: string, task: string) => new Set([cardKey(parent, task)]);
const none = new Set<string>();

describe("which proposal cards the session still waits on", () => {
  test.each<[string, object[], ReadonlySet<string>, string[]]>([
    ["the reported scene: a card nobody started", reported, none, ["task_0000aaaa"]],
    ["the reported scene: a session's record says it came from the card", reported, startedFromCard(PARENT, "task_0000aaaa"), []],
    ["a record of another session's card with the same task id doesn't start it", reported, startedFromCard(OTHER_PARENT, "task_0000aaaa"), ["task_0000aaaa"]],
    ["withdrawn with dismiss_task", [prompt(0), ...proposed(10, "task_1", TITLE), call(12, DISMISS, { task_id: "task_1" }), reply(20, "取り下げました")], none, []],
    [
      "withdrawn and proposed again: the new card waits",
      [prompt(0), ...proposed(10, "task_1", TITLE), call(12, DISMISS, { task_id: "task_1" }), ...proposed(14, "task_2", TITLE), reply(20, "どうぞ")],
      none,
      ["task_2"],
    ],
    ["started by the session itself with proposal_id", [prompt(0), ...proposed(10, "task_1", TITLE), call(12, START, { proposal_id: "task_1" }), reply(20, "始めました")], none, []],
    ["the next turn started: the wait is over", [...reported, prompt(30, "はい")], none, []],
    [
      "a side-sessions event starts the next turn too",
      [...reported, { type: "user", timestamp: at(30), turnOrigin: "sdk", message: { content: "<side-sessions-event>x" } }],
      none,
      [],
    ],
    [
      "two cards, one started: the other still waits",
      [prompt(0), ...proposed(10, "task_1", "A"), ...proposed(12, "task_2", "B"), reply(20, "どうぞ")],
      startedFromCard(PARENT, "task_1"),
      ["task_2"],
    ],
    [
      "a session started right away (user_asked) is no card",
      [prompt(0), call(10, START, { initiation: "user_asked" }), result(11, `Started session "別件" (session_id: ${OTHER_PARENT}, name: x).`), reply(20, "立てました")],
      none,
      [],
    ],
    [
      "an offer the user answered within the call is no card",
      [
        prompt(0),
        call(10, START, { initiation: "offer", title: TITLE }),
        result(11, `The user chose "New session" — the session is already opening for "${TITLE}" (task_id: task_1).`),
        reply(20, "立てます"),
      ],
      none,
      [],
    ],
    [
      "a card the app refused to make is no card",
      [prompt(0), call(10, START, { initiation: "own_initiative", cwd: "/x" }), result(11, "A proposal card cannot carry a host, folder"), reply(20, "x")],
      none,
      [],
    ],
    [
      "the card's text in a command's output is no card",
      [prompt(0), call(10, "Bash", { command: "grep Proposed log.txt" }), result(11, `Proposed "${TITLE}" (task_id: task_1). The user sees a card`), reply(20, "ログにありました")],
      none,
      [],
    ],
    [
      "the card's text in a file read is no card",
      [prompt(0), call(10, "Read", { file_path: "/tmp/x.md" }), result(11, `Proposed "${TITLE}" (task_id: task_1).`), reply(20, "読みました")],
      none,
      [],
    ],
  ])("%s", async (_, lines, started, want) => {
    const tail = await readTail(fileOf(lines));
    expect(unstartedProposals(pendingProposalsOf(tail.events), PARENT, started).map((p) => p.taskId)).toEqual(want);
  });

  test("the card's title is folded onto one line, like a wrap_up's ask", async () => {
    const tail = await readTail(fileOf([prompt(0), ...proposed(10, "task_1", "  検索結果に\n\n   画像を出す  "), reply(20, "どうぞ")]));
    expect(pendingProposalsOf(tail.events)?.proposals).toEqual([{ taskId: "task_1", title: "検索結果に 画像を出す", at: ms(11) }]);
  });
});

describe("where the wait comes from (replyWaitOf)", () => {
  const card = { taskId: "task_0000aaaa", title: TITLE, at: ms(11) };
  const cardThenAsk = [prompt(0), ...proposed(10, "task_0000aaaa", TITLE), call(15, WRAP_UP, { recap: "x", ask: "始めますか？" }), result(16, "Shown"), reply(20, "どうぞ")];
  test.each<[string, object[], { status?: string; waitingFor?: string } | undefined, boolean, object | undefined]>([
    ["a card not started", reported, undefined, true, { source: "proposal", waitingOn: "proposal", question: TITLE }],
    ["the card started", reported, undefined, false, undefined],
    ["a card and a wrap_up's ask in the same turn: the card comes first", cardThenAsk, undefined, true, { source: "proposal", waitingOn: "proposal", question: TITLE }],
    ["the ask alone once the card started", cardThenAsk, undefined, false, { source: "wrap_up_ask", waitingOn: "question", question: "始めますか？" }],
    [
      "Claude Code's own permission prompt comes first",
      reported,
      { status: "waiting", waitingFor: "permission prompt" },
      true,
      { source: "claude", waitingOn: "permission", question: undefined },
    ],
    ["a question tool", [prompt(0), call(10, "AskUserQuestion", { questions: [{ question: "どちらにしますか" }] })], undefined, false, { source: "question_tool", waitingOn: "question" }],
  ])("%s", async (_, lines, live, cardOpen, want) => {
    const tail = await readTail(fileOf(lines));
    const tailState = deriveState(tail, 10 * 60_000, false);
    const got = replyWaitOf(tail.events, tailState, live, cardOpen ? [card] : []);
    if (want === undefined) expect(got).toBeUndefined();
    else expect(got).toMatchObject(want);
  });

  test("cards don't count while the turn goes on", async () => {
    const working = [prompt(0), ...proposed(10, "task_0000aaaa", TITLE)];
    const tail = await readTail(fileOf(working));
    expect(replyWaitOf(tail.events, "working", undefined, [card])).toBeUndefined();
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
  test("a card and a wrap_up's ask in one turn: the needs reply isn't the ask's (a parent can't start the card)", async () => {
    const lines = [prompt(0), ...proposed(10, "task_1", TITLE), call(15, WRAP_UP, { recap: "x", ask: "始めますか？" }), result(16, "Shown"), reply(20, "どうぞ")];
    expect(await eventsOf(lines)).toEqual([
      ["started", ms(0), false],
      ["waiting", ms(15), false],
    ]);
  });
  test("a card withdrawn within the turn leaves a done", async () => {
    const lines = [prompt(0), ...proposed(10, "task_1", TITLE), call(12, DISMISS, { task_id: "task_1" }), reply(20, "取り下げました")];
    expect((await eventsOf(lines)).map(([type]) => type)).toEqual(["started", "done"]);
  });
  test("the card's text in a command's output leaves a done", async () => {
    const lines = [prompt(0), call(10, "Bash", { command: "x" }), result(11, `Proposed "${TITLE}" (task_id: task_1).`), reply(20, "ログにありました")];
    expect((await eventsOf(lines)).map(([type]) => type)).toEqual(["started", "done"]);
  });
});
