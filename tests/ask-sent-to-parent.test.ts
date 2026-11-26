// A parent takes over the question a child's reply asks only when the child's turn sent the parent a message
// (docs/design.md "Sessions started by another session"). The scene is the reported one, with made-up names and texts:
// a session another session started asked the user, in its own pane, to open a URL and allow a sign-in, while its own
// child kept working and that child's messages started its later turns. Its turns sent messages only to its own child,
// so the question stayed with the user, yet the concierge was given needs_reply false and never brought it up
import { describe, expect, test } from "bun:test";
import { buildConciergePayload, dropReason } from "../src/lib/concierge.ts";
import type { NativeFile } from "../src/lib/native-fs.ts";
import type { LiveSession, PeerLink, SessionView } from "../src/lib/session-types.ts";
import type { WatchLinks } from "../src/lib/session-watch.ts";
import { readTail } from "../src/lib/transcript.ts";
import { waitsOnDeveloper } from "../src/lib/turn-verdict.ts";
import { askSentToParent, takenOverByParent, takenOverWorld } from "../src/lib/watching.ts";
import { rememberTurnSends, turnSentToAt } from "../src/lib/turn-sends.ts";
import type { TailInfo } from "../src/lib/transcript.ts";

/** What the reply's turn sent, as lib/sessions.ts reads it: one tail read into a fresh ledger */
function replySentTo(tail: TailInfo): string[] | undefined {
  const ledgers = new Map();
  rememberTurnSends(ledgers, "v", tail.turnSends!);
  return turnSentToAt(ledgers.get("v"), tail.events.at(-1)?.at);
}

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

const at = (s: number) => `2026-01-01T00:${String(8 + Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`;
const say = (s: number, text: string) => ({ type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text }] } });
const tool = (s: number, name: string, input: object) => ({
  type: "assistant",
  timestamp: at(s),
  message: { content: [{ type: "tool_use", id: `t${s}`, name, input }] },
});
const result = (s: number) => ({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: `t${s - 1}`, content: "ok" }] } });
const fromPeer = (s: number, name: string, pid: number) => ({
  type: "user",
  isMeta: true,
  timestamp: at(s),
  origin: { kind: "peer", name, from: `uds:/tmp/cc-socks/${pid}.sock`, verifiedPeerPid: pid },
  message: { content: `Another Claude session sent a message:\n<cross-session-message from-name="${name}">…</cross-session-message>` },
});

const HUB = { id: "hub", pid: 100, name: "hub-1", startedAt: 1 };
const CHILD = { id: "child", pid: 200, name: "app-x-chores", startedAt: 2 };
const GRANDCHILD = { id: "grandchild", pid: 300, name: "app-x-chores-deps", startedAt: 3 };

/** The child's transcript, in the shape of the reported one */
const CHILD_LINES = [
  { type: "user", timestamp: at(0), turnOrigin: "peer", origin: { kind: "human" }, message: { content: "# 担当: app-x-chores\n親のセッション名: hub-1" } },
  tool(10, "SendMessage", { to: "hub-1", message: "起動しました" }),
  result(11),
  say(60, "続きにはサインインが要ります。下の URL で許可をお願いします。\nhttps://login.example.com/authorize?state=x"),
  fromPeer(400, GRANDCHILD.name, GRANDCHILD.pid),
  tool(410, "SendMessage", { to: GRANDCHILD.name, message: "まず一覧だけ見てください" }),
  result(411),
  say(418, "まだサインインできていません。先ほど貼った URL を開いて許可してもらえたら、続きに進みます。"),
  fromPeer(419, GRANDCHILD.name, GRANDCHILD.pid),
  tool(425, "Bash", { command: "ls" }),
  result(426),
  say(443, "サインインはまだ終わっていません。先ほどの URL から許可してもらえるのを待っています。"),
];

function watchOf(): Pick<
  WatchLinks,
  "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf" | "childOf" | "latestTurnOf"
> {
  const all = [HUB, CHILD, GRANDCHILD];
  const links: Record<string, string[]> = { hub: ["child"], child: ["hub", "grandchild"], grandchild: ["child"] };
  const link = (id: string): PeerLink => {
    const s = all.find((x) => x.id === id)!;
    return { sessionId: s.id, name: s.name, startedAt: s.startedAt, active: false };
  };
  return {
    liveBySessionId: new Map(all.map((s) => [s.id, { pid: s.pid, sessionId: s.id, name: s.name, startedAt: s.startedAt } as LiveSession])),
    viewIdBySessionId: new Map(all.map((s) => [s.id, `root/${s.id}.jsonl`])),
    peerLinksOf: (id) => (links[id] ?? []).map(link),
    // hub was started in a terminal, the child by hub, and the child's own child by the child
    startedBySessionOf: (v) => v !== "root/hub.jsonl",
    childOf: (v) => v !== "root/hub.jsonl",
    latestTurnOf: () => undefined,
  };
}

describe("the question a child's reply asks, by whether its turn sent its parent a message", () => {
  test("the reported child: its last turn sent nothing to its parent, so its question waits on the user", async () => {
    const tail = await readTail(fileOf(CHILD_LINES));
    // The last turn was started by its own child's message and only ran a command
    expect(replySentTo(tail)).toEqual([]);
    const world = takenOverWorld(watchOf());
    expect(takenOverByParent("child", world)).toBe(true);
    expect(askSentToParent("child", replySentTo(tail), world)).toBe(false);

    // The app's facts when it was left out: done, its turn verdict asking, its parent taking it over
    const child: SessionView = {
      id: "child",
      project: "app-x",
      slug: "child",
      state: "done",
      sinceMs: 229_000,
      ask: { status: "asking" },
      continuing: true,
      parentTakesOver: true,
    };
    expect(waitsOnDeveloper(child)).toBe(true);
    const p = buildConciergePayload(
      [
        { view: { id: "hub", project: "hub", slug: "hub", state: "done", sinceMs: 60_000 } },
        { view: child, parentId: "hub" },
      ],
      [],
      [],
      0,
      "ja",
    );
    const fact = p.sessions.find((s) => s.id === "child")!;
    expect(fact.needs_reply).toBe(true);
    expect(fact.needs_reply_source).toBe("verdict");
    expect(dropReason({ line: "app-xのURLを開いて許可", targetId: "child" }, "reply", p.sessions)).toBeUndefined();
  });

  test("a turn that sent a message to its own child doesn't count as sending to its parent", async () => {
    const tail = await readTail(fileOf(CHILD_LINES.slice(0, 8)));
    expect(replySentTo(tail)).toEqual([GRANDCHILD.name]);
    expect(askSentToParent("child", replySentTo(tail), takenOverWorld(watchOf()))).toBe(false);
  });

  test("a turn that sent its question to the parent is taken over", async () => {
    const tail = await readTail(
      fileOf([
        ...CHILD_LINES,
        fromPeer(500, HUB.name, HUB.pid),
        tool(510, "SendMessage", { to: `${HUB.name} [3fa9c1]`, message: "コンテナを立ててよいですか？" }),
        result(511),
        say(520, "親に、コンテナを立ててよいかを聞きました。返事を待っています。"),
      ]),
    );
    expect(replySentTo(tail)).toEqual([HUB.name]);
    const world = takenOverWorld(watchOf());
    expect(askSentToParent("child", replySentTo(tail), world)).toBe(true);
    const child: SessionView = {
      id: "child",
      project: "app-x",
      slug: "child",
      state: "done",
      sinceMs: 10_000,
      ask: { status: "asking" },
      parentTakesOver: true,
      askSentToParent: true,
    };
    expect(waitsOnDeveloper(child)).toBe(false);
  });

  test("a window that doesn't reach the turn's prompt still counts the messages it read", async () => {
    const tail = await readTail(fileOf([tool(10, "SendMessage", { to: HUB.name, message: "x" }), result(11), say(20, "済みました")]));
    expect(replySentTo(tail)).toEqual([HUB.name]);
  });
});
