// A transcript started as a fork (a side chat of the Claude desktop app, or a fork another session started) begins with
// its parent's lines, copied with the parent's sessionId. Every read of a main transcript skips them; a chick's
// transcript, whose lines all carry the main session's id, is read as before (docs/design.md "Side chats and forked
// sessions of the Claude desktop app"). Lines shaped like the real records on this machine, ids and names made up
import { describe, expect, test } from "bun:test";
import type { NativeFile } from "../src/lib/native-fs.ts";
import { isForeignLine, readEventsInRange, readTail, scanChickSignals } from "../src/lib/transcript.ts";
import { deriveState } from "../src/lib/bird-state.ts";

const OWN = "0a1b2c3d-0000-4000-8000-00000000f0f0";
const PARENT = "0a1b2c3d-0000-4000-8000-00000000aaaa";
const SIBLING = "local_0a1b2c3d-0000-4000-8000-0000000000bb";
const PARENT_HOST = "local_0a1b2c3d-0000-4000-8000-0000000000aa";

function fileOf(lines: object[], name = `${OWN}.jsonl`): NativeFile {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  return {
    path: `/tmp/${name}`,
    name,
    size: bytes.length,
    lastModified: 0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
}

const at = (s: string) => `2026-01-01T${s}.000Z`;

// The parent's lines as the fork's transcript copies them: its first prompt, a start of a sibling and a message to it,
// a background command, a chick's completion, and its last turn, which ended in a reply
const copied: object[] = [
  { type: "queue-operation", sessionId: PARENT, timestamp: at("00:00:00") },
  { type: "user", sessionId: PARENT, timestamp: at("00:00:01"), turnOrigin: "human", origin: { kind: "human" }, isSidechain: false, message: { content: "task" } },
  { type: "assistant", sessionId: PARENT, timestamp: at("00:00:02"), isSidechain: false, message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__ccd_session__send_message", input: { session_id: SIBLING } }] } },
  { type: "user", sessionId: PARENT, timestamp: at("00:00:03"), isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: `Started session "x" (session_id: ${SIBLING}, name: x)` }] } },
  { type: "user", sessionId: PARENT, timestamp: at("00:00:04"), isSidechain: false, toolUseResult: { backgroundTaskId: "bg1" }, message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "started" }] } },
  { type: "queue-operation", sessionId: PARENT, timestamp: at("00:00:05"), content: "<task-notification>\n<task-id>chick1</task-id>\n</task-notification>" },
  { type: "user", sessionId: PARENT, timestamp: at("00:00:06"), turnOrigin: "human", origin: { kind: "human" }, isSidechain: false, message: { content: "again" } },
  { type: "assistant", sessionId: PARENT, timestamp: at("00:00:07"), isSidechain: false, message: { content: [{ type: "text", text: "Done: the parent's reply" }] } },
];

// A side chat the user typed in
const sideChatOwn: object[] = [
  { type: "custom-title", customTitle: "side chat", sessionId: OWN },
  { type: "user", sessionId: OWN, timestamp: at("01:00:01"), origin: { kind: "task-notification" }, isSidechain: false, message: { content: "<task-notification>x</task-notification>" } },
  { type: "user", sessionId: OWN, timestamp: at("01:00:02"), turnOrigin: "human", origin: { kind: "human" }, isSidechain: false, message: { content: [{ type: "text", text: "<system-reminder>\n## The user forked this session from another session\n</system-reminder>\n\nwhat is X" }] } },
  { type: "assistant", sessionId: OWN, timestamp: at("01:00:05"), isSidechain: false, message: { content: [{ type: "text", text: "X is a header" }] } },
];

// A side chat closed without typing, or a fork that hasn't written yet: untimed lines of its own only
const untimedOwn: object[] = [
  { type: "custom-title", customTitle: "side chat", sessionId: OWN },
  { type: "mode", mode: "normal", sessionId: OWN },
];

// A fork another session started: the app's first prompt naming the starter's notes folder, then a send to it
const forkOwn: object[] = [
  { type: "user", sessionId: OWN, timestamp: at("01:00:00"), turnOrigin: "sdk", isSidechain: false, message: { content: `## You are a session started from another session\nnotes: /a/side-session-notes/${PARENT_HOST}` } },
  { type: "assistant", sessionId: OWN, timestamp: at("01:00:05"), isSidechain: false, message: { content: [{ type: "tool_use", id: "tu9", name: "mcp__ccd_session__send_message", input: { session_id: PARENT_HOST } }] } },
];

const own = { ownSessionId: OWN };

describe("isForeignLine", () => {
  test.each([
    ["the session's own line", { sessionId: OWN }, OWN, false],
    ["the parent's copied line", { sessionId: PARENT }, OWN, true],
    ["a line without sessionId", {}, OWN, false],
    ["sessionId that isn't a string", { sessionId: null }, OWN, false],
    ["a read without an own id (a chick's)", { sessionId: PARENT }, undefined, false],
  ] as const)("%s", (_name, entry, ownId, expected) => {
    expect(isForeignLine(entry, ownId)).toBe(expected);
  });
});

describe("readTail of a forked transcript reads only its own lines", () => {
  test("a side chat the user typed in: its own reply, its own times, no peer, no background task, its own first prompt", async () => {
    const tail = await readTail(fileOf([...copied, ...sideChatOwn]), own);
    expect(tail.kind).toBe("assistant_text");
    expect(tail.events.map((e) => e.text)).not.toContain("Done: the parent's reply");
    expect(tail.events.every((e) => e.at >= Date.parse(at("01:00:00")))).toBe(true);
    expect(tail.lastEventAt).toBe(Date.parse(at("01:00:05")));
    expect([...tail.peerNames.keys()]).toEqual([]);
    expect([...tail.backgroundTaskStarts.keys()]).toEqual([]);
    expect([...tail.chickSignals.keys()]).toEqual([]);
  });

  test("a fork with no timestamped line of its own reads as a session that has just started: no events, never done", async () => {
    const tail = await readTail(fileOf([...copied, ...untimedOwn]), own);
    expect(tail.kind).toBe("unknown");
    expect(tail.events).toEqual([]);
    expect(tail.lastEventAt).toBeUndefined();
    // Its time comes from the file then: working while written recently, dozing after, never done
    expect(deriveState(tail, 1_000, false)).toBe("working");
    expect(deriveState(tail, 60 * 60_000, false)).toBe("dozing");
  });

  test("a fork another session started: links to its starter from its own lines, not to its parent's sibling", async () => {
    const tail = await readTail(fileOf([...copied, ...forkOwn]), own);
    expect([...tail.peerNames.keys()].sort()).toEqual([PARENT_HOST]);
    expect(tail.kind).toBe("tool_use");
  });

  test("without an own id (as before, and as chicks are read) every line is read", async () => {
    const tail = await readTail(fileOf([...copied, ...untimedOwn]));
    expect(tail.kind).toBe("assistant_text");
    expect(tail.events.map((e) => e.text)).toContain("Done: the parent's reply");
    expect([...tail.peerNames.keys()]).toContain(SIBLING);
    expect([...tail.backgroundTaskStarts.keys()]).toEqual(["bg1"]);
  });

  test("the parent's own transcript, read with its own id, is unchanged", async () => {
    const tail = await readTail(fileOf(copied, `${PARENT}.jsonl`), { ownSessionId: PARENT });
    const before = await readTail(fileOf(copied, `${PARENT}.jsonl`));
    expect(tail).toEqual(before);
    expect(tail.kind).toBe("assistant_text");
  });

  test("a chick's lines carry the main session's id and are read whole with includeSidechain", async () => {
    const chick = copied.map((l) => ({ ...l, isSidechain: true }));
    const tail = await readTail(fileOf(chick, "agent-a1.jsonl"), { includeSidechain: true });
    expect(tail.kind).toBe("assistant_text");
    expect(tail.lastEventAt).toBe(Date.parse(at("00:00:07")));
  });
});

describe("the other reads of a main transcript", () => {
  test("readEventsInRange skips the copied lines", async () => {
    const file = fileOf([...copied, ...sideChatOwn]);
    const mine = await readEventsInRange(file, 0, file.size, own);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.at >= Date.parse(at("01:00:00")))).toBe(true);
    const all = await readEventsInRange(file, 0, file.size);
    expect(all.some((e) => e.at < Date.parse(at("01:00:00")))).toBe(true);
  });

  test("scanChickSignals skips the parent's chicks' records", async () => {
    const file = fileOf([...copied, ...forkOwn]);
    expect([...(await scanChickSignals(file, 0, own)).signals.keys()]).toEqual([]);
    expect([...(await scanChickSignals(file, 0)).signals.keys()].sort()).toEqual(["chick1", "tu1", "tu2"]);
  });
});
