// The question a child's reply asks reaches its parent when the reply's own turn sent the parent a message, read from
// the ledger of what each turn sent (docs/design.md "Sessions started by another session"). The scene is the reported
// one, with made-up names: a child started by another session reviewed branches in a turn 270 lines long, sent its parent
// the report and its questions with SendMessage, ended its turn with「親に決めてほしいこと（返事待ち）」, and its parent's
// answer arrived 4 seconds later as a meta line starting the next turn. The prompt of that turn was out of the tail
// window, and the parent's answer started a new turn that had sent nothing, so the app took the question as the user's,
// the concierge advised replying to it, and it was read aloud
import { describe, expect, test } from "bun:test";
import { buildConciergePayload, dropReason } from "../src/lib/concierge.ts";
import type { NativeFile } from "../src/lib/native-fs.ts";
import type { FoundEntry, LiveSession, PeerLink, SessionView } from "../src/lib/session-types.ts";
import type { WatchLinks } from "../src/lib/session-watch.ts";
import { pruneCaches, turnSendsCache } from "../src/lib/session-store.ts";
import { readTail, TAIL_BYTES, type TailInfo } from "../src/lib/transcript.ts";
import { rememberTurnSends, turnSendsOfScan, turnSentToAt, TURN_SENDS_KEPT, type TurnSends } from "../src/lib/turn-sends.ts";
import { waitsOnDeveloper } from "../src/lib/turn-verdict.ts";
import { askSentToParent, takenOverByParent, takenOverWorld } from "../src/lib/watching.ts";

function fileOf(lines: object[]): NativeFile {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
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

const BASE = Date.parse("2026-01-01T11:14:16.169Z");
const at = (ms: number) => new Date(BASE + ms).toISOString();
const PARENT = { id: "parent", pid: 100, name: "hub-19", startedAt: BASE - 3_600_000 };
const CHILD = { id: "child", pid: 200, name: "hub-branch-review", startedAt: BASE - 2_000 };

const FIRST = {
  type: "user",
  timestamp: at(0),
  turnOrigin: "human",
  origin: { kind: "human" },
  message: { content: "# 担当: branch-review\n\n残っている 4 本のブランチを見直してください" },
};
const send = (ms: number, id: string) => ({
  type: "assistant",
  timestamp: at(ms),
  message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to: PARENT.name, message: "見直しの結果と、決めてほしいこと 3 点" } }] },
});
const sendResult = (ms: number, id: string) => ({
  type: "user",
  timestamp: at(ms),
  message: { content: [{ type: "tool_result", tool_use_id: id, content: '{"success":true}' }] },
});
// The turn's work between its first message and its report: commands with long output, more than the tail window
const WORK = Array.from({ length: 135 }, (_, i) => [
  { type: "assistant", timestamp: at(10_000 + i * 1_200), message: { content: [{ type: "tool_use", id: `b${i}`, name: "Bash", input: { command: `git log --oneline main..branch-${i}` } }] } },
  { type: "user", timestamp: at(10_600 + i * 1_200), message: { content: [{ type: "tool_result", tool_use_id: `b${i}`, content: "x".repeat(1_000) }] } },
]).flat();
const REPLY = {
  type: "assistant",
  timestamp: at(190_453),
  message: { content: [{ type: "text", text: "4 本のうち、いま取り込むべきなのは 1 本です。\n\n親に決めてほしいこと（返事待ち）:\n1. 次の版上げ\n2. 取り込む時期\n3. 監視の設定" }] },
};
const TURN_END = { type: "system", subtype: "turn_duration", timestamp: at(191_060) };
const ANSWER = {
  type: "user",
  isMeta: true,
  timestamp: at(195_337),
  turnOrigin: "peer",
  origin: { kind: "peer", name: PARENT.name, from: `uds:/tmp/cc-socks/${PARENT.pid}.sock`, verifiedPeerPid: PARENT.pid },
  message: { content: `Another Claude session sent a message:\n<cross-session-message from-name="${PARENT.name}">3 点はこう決めます</cross-session-message>` },
};
/** The child's transcript, in the shape of the reported one */
const LINES = [FIRST, send(9_032, "s1"), sendResult(9_300, "s1"), ...WORK, send(179_194, "s2"), sendResult(179_469, "s2"), REPLY, TURN_END, ANSWER];
const UP_TO_REPLY = LINES.length - 1;

function watchOf(): Pick<
  WatchLinks,
  "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf" | "childOf" | "latestTurnOf"
> {
  const all = [PARENT, CHILD];
  const links: Record<string, string[]> = { parent: ["child"], child: ["parent"] };
  const link = (id: string): PeerLink => {
    const s = all.find((x) => x.id === id)!;
    return { sessionId: s.id, name: s.name, startedAt: s.startedAt, active: false };
  };
  return {
    liveBySessionId: new Map(all.map((s) => [s.id, { pid: s.pid, sessionId: s.id, name: s.name, startedAt: s.startedAt } as LiveSession])),
    viewIdBySessionId: new Map(all.map((s) => [s.id, `root/${s.id}.jsonl`])),
    peerLinksOf: (id) => (links[id] ?? []).map(link),
    startedBySessionOf: (v) => v === "root/child.jsonl",
    childOf: (v) => v === "root/child.jsonl",
    latestTurnOf: () => undefined,
  };
}

/** The reply turn's sends as lib/sessions.ts reads them, after adding this scan's tail to the ledger */
function replySentTo(ledgers: Map<string, TurnSends[]>, tail: TailInfo): string[] | undefined {
  rememberTurnSends(ledgers, "child", tail.turnSends!);
  return turnSentToAt(ledgers.get("child"), tail.events.at(-1)?.at);
}

/** The child as the app shows it to the concierge once its turn ended asking */
function childView(sentToParent: boolean): SessionView {
  return {
    id: "child",
    project: "hub",
    slug: "child",
    state: "done",
    sinceMs: 3_000,
    ask: { status: "asking" },
    parentTakesOver: true,
    ...(sentToParent && { askSentToParent: true as const }),
  };
}

describe("the reported child that asked its parent at the end of a long turn", () => {
  test("the tail window doesn't reach the turn's prompt", async () => {
    const file = fileOf(LINES.slice(0, UP_TO_REPLY));
    expect(file.size).toBeGreaterThan(TAIL_BYTES);
    const tail = await readTail(file);
    expect(tail.turnSends!.turns).toEqual([]);
    expect(tail.turnSends!.sentBefore).toEqual([PARENT.name]);
  });

  test("(A) right after its reply: the window misses the prompt, but the turn's message to the parent counts", async () => {
    const ledgers = new Map<string, TurnSends[]>();
    // The app was running all along: earlier scans saw the prompt and the first message
    rememberTurnSends(ledgers, "child", (await readTail(fileOf(LINES.slice(0, 3)))).turnSends!);
    expect(replySentTo(ledgers, await readTail(fileOf(LINES.slice(0, UP_TO_REPLY))))).toEqual([PARENT.name]);
    expect(askSentToParent("child", [PARENT.name], takenOverWorld(watchOf()))).toBe(true);
  });

  test("(B) the parent's answer starts the next turn before the child writes: the reply's turn still sent it", async () => {
    const ledgers = new Map<string, TurnSends[]>();
    rememberTurnSends(ledgers, "child", (await readTail(fileOf(LINES.slice(0, 3)))).turnSends!);
    const tail = await readTail(fileOf(LINES));
    // The answer is a meta line: the bird stays done on the reply
    expect(tail.events.at(-1)?.kind).toBe("assistant_text");
    expect(tail.turnSends!.turns.map((t) => t.startAt)).toEqual([Date.parse(ANSWER.timestamp)]);
    const sentTo = replySentTo(ledgers, tail);
    expect(sentTo).toEqual([PARENT.name]);

    const world = takenOverWorld(watchOf());
    expect(takenOverByParent("child", world)).toBe(true);
    expect(askSentToParent("child", sentTo, world)).toBe(true);
    const child = childView(true);
    expect(waitsOnDeveloper(child)).toBe(false);
    const p = buildConciergePayload(
      [{ view: { id: "parent", project: "hub", slug: "parent", state: "done", sinceMs: 15_000 } }, { view: child, parentId: "parent" }],
      [],
      [],
      0,
      "ja",
    );
    const fact = p.sessions.find((s) => s.id === "child")!;
    expect(fact.needs_reply).toBe(false);
    expect(fact.parent_takes_over).toBe(true);
    // The advice that was read aloud is dropped
    expect(dropReason({ line: "3点の判断を返信", targetId: "child" }, "reply", p.sessions)).toBe("parent_takes_over");
  });

  test("the app started mid-turn: an empty ledger and a window from the middle of the turn still count the message", async () => {
    const ledgers = new Map<string, TurnSends[]>();
    expect(replySentTo(ledgers, await readTail(fileOf(LINES)))).toEqual([PARENT.name]);
  });

  test("the app started mid-turn and the only message was before the window: the whole-file read gives it", async () => {
    const lines = [FIRST, send(9_032, "s1"), sendResult(9_300, "s1"), ...WORK, REPLY, TURN_END, ANSWER];
    const ledgers = new Map<string, TurnSends[]>();
    // scan_peer_names in src-tauri, read from the top on the app's first scan
    rememberTurnSends(
      ledgers,
      "child",
      turnSendsOfScan({
        turnSends: [
          { startAt: FIRST.timestamp, sentTo: [PARENT.name] },
          { startAt: ANSWER.timestamp, sentTo: [] },
        ],
        sentBeforeTurn: [],
      }),
      { replace: true },
    );
    const tail = await readTail(fileOf(lines));
    expect(tail.turnSends!.sentBefore).toEqual([]);
    expect(replySentTo(ledgers, tail)).toEqual([PARENT.name]);
  });

  test("without the ledger's fix, the same facts asked the user (what was reported)", () => {
    const p = buildConciergePayload(
      [{ view: { id: "parent", project: "hub", slug: "parent", state: "done", sinceMs: 15_000 } }, { view: childView(false), parentId: "parent" }],
      [],
      [],
      0,
      "ja",
    );
    const fact = p.sessions.find((s) => s.id === "child")!;
    expect(fact.needs_reply).toBe(true);
    expect(fact.needs_reply_source).toBe("verdict");
  });
});

describe("the ledger of what each turn sent", () => {
  test("a reply in a turn that sent nothing, after a turn that messaged the parent, doesn't count", () => {
    const ledgers = new Map<string, TurnSends[]>();
    rememberTurnSends(ledgers, "v", {
      turns: [
        { startAt: 10, sentTo: ["hub-19"] },
        { startAt: 20, sentTo: [] },
      ],
      sentBefore: [],
    });
    expect(turnSentToAt(ledgers.get("v"), 15)).toEqual(["hub-19"]);
    expect(turnSentToAt(ledgers.get("v"), 25)).toEqual([]);
  });

  test("keeps only the last few turns", () => {
    const ledgers = new Map<string, TurnSends[]>();
    for (let i = 0; i < 50; i++) rememberTurnSends(ledgers, "v", { turns: [{ startAt: i, sentTo: [`s${i}`] }], sentBefore: [] });
    expect(ledgers.get("v")?.length).toBe(TURN_SENDS_KEPT);
    expect(turnSentToAt(ledgers.get("v"), 49)).toEqual(["s49"]);
  });

  test("a session that is gone leaves no ledger", () => {
    turnSendsCache.set("root/gone.jsonl", [{ startAt: 1, sentTo: new Set(["hub-19"]) }]);
    turnSendsCache.set("root/here.jsonl", [{ startAt: 1, sentTo: new Set(["hub-19"]) }]);
    pruneCaches([{ id: "root/here.jsonl", chicks: [] } as unknown as FoundEntry], new Set());
    expect(turnSendsCache.has("root/gone.jsonl")).toBe(false);
    expect(turnSendsCache.has("root/here.jsonl")).toBe(true);
    turnSendsCache.clear();
  });
});
