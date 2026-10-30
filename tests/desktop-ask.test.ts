// A Claude desktop app session puts its question in the wrap_up tool's `ask`, not in the reply's text (docs/design.md
// "The "?" for sessions waiting on you"). A turn that ends so waits on the user, as a question tool does: it needs a
// reply by the machine state, before any turn verdict. Before, plan-icons ended on 「この中身で試しを打ってよいですか？」
// in the ask and was shown done, and the concierge didn't treat it as waiting (the user: 「はんのうしてない」)
import { describe, expect, test } from "bun:test";
import type { NativeFile } from "../src/lib/native-fs.ts";
import { deriveState } from "../src/lib/bird-state.ts";
import { deriveSessionEvents } from "../src/lib/session-events.ts";
import { desktopAskOf, pendingAskOf, readTail, type TailEvent } from "../src/lib/transcript.ts";

const WRAP_UP = "mcp__ccd_turn__wrap_up";
const ASK = "この中身で試しを打ってよいですか？";

describe("which wrap_up asks", () => {
  test.each<[string, string, unknown, ReturnType<typeof desktopAskOf>]>([
    ["an ask", WRAP_UP, { recap: "書きました", ask: ASK, blocked: true }, { question: ASK }],
    ["an ask, not blocked", WRAP_UP, { recap: "書きました", ask: "  どれにしますか？\n" }, { question: "どれにしますか？" }],
    ["blocked alone", WRAP_UP, { recap: "止まっています", blocked: true }, {}],
    ["a recap alone (nothing pending)", WRAP_UP, { recap: "終わりました" }, undefined],
    ["a blank ask", WRAP_UP, { recap: "終わりました", ask: "  " }, undefined],
    ["another tool with an ask field", "Bash", { ask: ASK }, undefined],
    ["no input", WRAP_UP, undefined, undefined],
  ])("%s", (_, tool, input, expected) => {
    expect(desktopAskOf(tool, input)).toEqual(expected);
  });
});

const ev = (kind: TailEvent["kind"], at: number, patch: Partial<TailEvent> = {}): TailEvent => ({ kind, at, ...patch });
const asking = (at: number) => ev("tool_use", at, { toolName: WRAP_UP, ask: { question: ASK } });

describe("whether the last turn still waits on its ask", () => {
  test.each<[string, TailEvent[], ReturnType<typeof pendingAskOf>]>([
    ["the ask, its result and the closing text", [ev("user", 1), asking(2), ev("tool_result", 3), ev("assistant_text", 4)], { question: ASK, at: 2 }],
    ["the user answered", [asking(2), ev("tool_result", 3), ev("assistant_text", 4), ev("user", 5)], undefined],
    ["the user answered and it works", [asking(2), ev("assistant_text", 4), ev("user", 5), ev("tool_use", 6, { toolName: "Bash" })], undefined],
    ["it went on with another tool", [asking(2), ev("tool_result", 3), ev("tool_use", 4, { toolName: "Bash" })], undefined],
    ["closed after it", [asking(2), ev("assistant_text", 3), ev("closed", 4)], undefined],
    ["a wrap_up without an ask", [ev("tool_use", 2, { toolName: WRAP_UP }), ev("assistant_text", 3)], undefined],
    ["an earlier turn asked, this one didn't", [asking(2), ev("user", 3), ev("assistant_text", 4)], undefined],
    ["nothing", [], undefined],
  ])("%s", (_, events, expected) => {
    expect(pendingAskOf(events)).toEqual(expected);
  });
});

const tailOf = (events: TailEvent[]) => ({
  kind: events.at(-1)?.kind ?? ("unknown" as const),
  events,
  chickSignals: new Map(),
  backgroundTaskStarts: new Map(),
  peerNames: new Map(),
});

describe("the machine state", () => {
  const turn = [ev("user", 1, { text: "書いて" }), asking(2), ev("tool_result", 3), ev("assistant_text", 4, { text: "お見せします" })];
  test.each<[string, TailEvent[], number, boolean, string]>([
    ["asked, long after", turn, 30 * 60_000, false, "waiting"],
    ["asked, right after the closing text", turn, 1_000, false, "waiting"],
    ["answered", [...turn, ev("user", 5)], 1_000, false, "working"],
    ["no ask: done as before", [ev("user", 1), ev("tool_use", 2, { toolName: WRAP_UP }), ev("tool_result", 3), ev("assistant_text", 4)], 60_000, false, "done"],
    ["a chick doesn't ask the user (past its own 2 minutes)", turn, 3 * 60_000, true, "done"],
  ])("%s", (_, events, sinceMs, isChick, expected) => {
    expect(deriveState(tailOf(events), sinceMs, isChick)).toBe(expected);
  });

  test("Recent activity: the turn is a needs reply at the ask, not a done at its closing text", () => {
    const got = deriveSessionEvents(tailOf(turn), "s", "plan-icons", [], new Map(), undefined, 10 * 60_000);
    expect(got.map((e) => [e.type, e.at])).toEqual([
      ["started", 1],
      ["waiting", 2],
    ]);
    // Without an ask the closing text is a done
    const plain = [ev("user", 1), ev("tool_use", 2, { toolName: WRAP_UP }), ev("tool_result", 3), ev("assistant_text", 4)];
    expect(deriveSessionEvents(tailOf(plain), "s", "p", [], new Map(), undefined, 10 * 60_000).map((e) => e.type)).toEqual([
      "started",
      "done",
    ]);
  });
});

test("the transcript's wrap_up line gives the ask to the tail", async () => {
  const lines = [
    { type: "user", timestamp: "2026-10-30T07:50:00.000Z", message: { content: "書いて" } },
    {
      type: "assistant",
      timestamp: "2026-10-30T07:51:00.000Z",
      message: { content: [{ type: "tool_use", id: "t1", name: WRAP_UP, input: { recap: "x".repeat(600), ask: ASK, blocked: true } }] },
    },
    { type: "user", timestamp: "2026-10-30T07:51:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Shown" }] } },
    { type: "assistant", timestamp: "2026-10-30T07:51:05.000Z", message: { content: [{ type: "text", text: "中身をお見せします。" }] } },
  ];
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const file = {
    path: "/tmp/t.jsonl",
    name: "t.jsonl",
    size: bytes.length,
    lastModified: 0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
  const tail = await readTail(file);
  // The ask comes from the tool's input itself, so a long recap before it in the JSON doesn't cut it off
  expect(pendingAskOf(tail.events)).toEqual({ question: ASK, at: Date.parse("2026-10-30T07:51:00.000Z") });
});
