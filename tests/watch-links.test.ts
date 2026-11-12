// Watching links (docs/design.md "Watching", "How links are found"): which traces in a transcript name a peer, and
// which running session a trace is matched to. The Claude desktop app's sessions are addressed by local_… ids
import { describe, expect, test } from "bun:test";
import type { NativeFile } from "../src/lib/native-fs.ts";
import type { LiveSession } from "../src/lib/session-types.ts";
import { readTail } from "../src/lib/transcript.ts";
import { peerLookup } from "../src/lib/watching.ts";

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

const ID = "local_3f97c278-cf60-45f9-b227-66ded583d16f";
const TOP = "local_0a1b2c3d-0000-4000-8000-0000000000aa";
const CHILD_OF_TOP = "local_0a1b2c3d-0000-4000-8000-0000000000bb";
const T = "2026-11-11T03:29:26.475Z";
const toolUse = (name: string, input: object) => ({
  type: "assistant",
  timestamp: T,
  message: { content: [{ type: "tool_use", id: "t1", name, input }] },
});
const toolResult = (content: unknown) => ({
  type: "user",
  timestamp: T,
  message: { content: [{ type: "tool_result", tool_use_id: "t1", content }] },
});

describe("peer traces in a transcript", () => {
  const scenes: [string, object, string[]][] = [
    ["SendMessage to a name", toolUse("SendMessage", { to: "web-build [3fa9c1]" }), ["web-build"]],
    ["SendMessage to the desktop app's id", toolUse("SendMessage", { to: ID }), [ID]],
    ["SendMessage to the parent conversation", toolUse("SendMessage", { to: "main" }), []],
    ["the desktop app's send_message", toolUse("mcp__ccd_session_mgmt__send_message", { session_id: ID, message: "x" }), [ID]],
    [
      "start_session's result (text blocks)",
      toolResult([{ type: "text", text: `Started session "Fix it" (session_id: ${ID}, name: fix-it). It runs on its own` }]),
      [ID],
    ],
    ["start_session's result (a string)", toolResult(`Started session "Fix it" (session_id: ${ID}, name: fix-it).`), [ID]],
    ["a tool result that only mentions an id is not a start", toolResult(`see ${ID}`), []],
    [
      "a received message: its name and the desktop app's id",
      { type: "user", isMeta: true, timestamp: T, origin: { kind: "peer", from: ID, name: "Fix it" }, message: { content: "x" } },
      ["Fix it", ID],
    ],
    [
      "a received message from a terminal session: its name only",
      {
        type: "user",
        isMeta: true,
        timestamp: T,
        origin: { kind: "peer", from: "uds:/tmp/cc-socks/1.sock", name: "web-build" },
        message: { content: "x" },
      },
      ["web-build"],
    ],
    [
      "a message that arrived mid-work",
      { type: "attachment", timestamp: T, attachment: { origin: { kind: "peer", from: ID, name: "Fix it" } } },
      ["Fix it", ID],
    ],
    [
      "an older received message: from-name in the body",
      {
        type: "user",
        isMeta: true,
        timestamp: T,
        message: { content: '<cross-session-message from="x" from-name="web-build">hi</cross-session-message>' },
      },
      ["web-build"],
    ],
    ["a subagent's line is not a link", { ...toolUse("SendMessage", { to: ID }), isSidechain: true }, []],
    // A session started from a proposal card: the app names its starter's shared notes folder in its first prompt
    [
      "the starter's notes folder in a prompt the app wrote (started from a proposal card)",
      { type: "user", timestamp: T, turnOrigin: "host_synthetic", message: { content: `notes: /Users/x/Library/Application Support/Claude/side-session-notes/${ID}\n` } },
      [ID],
    ],
    [
      "the notes folder in text blocks of a prompt started by start_session",
      { type: "user", timestamp: T, turnOrigin: "sdk", message: { content: [{ type: "text", text: `notes: /a/side-session-notes/${ID}` }] } },
      [ID],
    ],
    [
      "a grandchild names only its direct starter (the child), not the session that started the child",
      {
        type: "user",
        timestamp: T,
        turnOrigin: "sdk",
        message: { content: `notes: /a/side-session-notes/${CHILD_OF_TOP}\nThe top session is ${TOP} (not a link)` },
      },
      [CHILD_OF_TOP],
    ],
    [
      "the notes folder in a prompt the user typed is not a link",
      { type: "user", timestamp: T, turnOrigin: "human", message: { content: `look at /a/side-session-notes/${ID}` } },
      [],
    ],
  ];
  for (const [scene, line, want] of scenes) {
    test(scene, async () => {
      const tail = await readTail(fileOf([line]));
      expect([...tail.peerNames.keys()]).toEqual(want);
    });
  }
});

describe("matching a trace to a running session", () => {
  const live: LiveSession[] = [
    { pid: 1, sessionId: "parent", name: "子セッションの完了読み上げ・提案を止める", hostSessionId: "local_8850b4ff-ddab-4a58-a0ef-7f81c7313d90" },
    { pid: 2, sessionId: "child", name: "Desktop の子セッションを監視リンクとして読む", hostSessionId: ID },
    { pid: 3, sessionId: "terminal", name: "web-build" },
  ];
  const peerOf = peerLookup(live);
  const scenes: [string, string, string | undefined][] = [
    ["a desktop app child by the id its parent got from start_session", ID, "child"],
    ["a desktop app parent by the id its child sends to", "local_8850b4ff-ddab-4a58-a0ef-7f81c7313d90", "parent"],
    ["a desktop app session by its title, as before", "Desktop の子セッションを監視リンクとして読む", "child"],
    ["a renamed desktop app session: its old title no longer matches, its id still does", "古い題名", undefined],
    ["a terminal session by its name, as before", "web-build", "terminal"],
    ["an id of a session that isn't running", "local_00000000-0000-0000-0000-000000000000", undefined],
  ];
  for (const [scene, trace, want] of scenes) {
    test(scene, () => {
      expect(peerOf(trace)?.sessionId).toBe(want);
    });
  }
});
