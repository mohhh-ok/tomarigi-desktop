// Telling side chats of the Claude desktop app from the answers read from its records (docs/design.md "Side chats and
// forked sessions of the Claude desktop app"); the listing that drops them is tested in tests/liveness.test.ts
import { describe, expect, mock, test } from "bun:test";

mock.module("@tauri-apps/api/core", () => ({ invoke: async () => ({ answers: [], reliable: true }) }));
const { hostIdsToAsk, isSideChat, forgetSideChats, hostIdOfTranscript } = await import("../src/lib/side-chats.ts");
const { sessionEventCache } = await import("../src/lib/session-store.ts");
import type { LiveSession, SessionEvent } from "../src/lib/session-types.ts";

const MAIN = "0a1b2c3d-0000-4000-8000-0000000000a1";
const SIDE = "0a1b2c3d-0000-4000-8000-0000000000b1";
const FORK = "0a1b2c3d-0000-4000-8000-0000000000f1";
const TERMINAL = "0a1b2c3d-0000-4000-8000-0000000000c1";
const live: LiveSession[] = [
  { pid: 1, sessionId: MAIN, hostSessionId: `local_${MAIN}` },
  { pid: 2, sessionId: SIDE, hostSessionId: `local_${SIDE}` },
  { pid: 3, sessionId: FORK, hostSessionId: `local_${FORK}` },
  { pid: 4, sessionId: TERMINAL },
];
const byId = new Map(live.map((l) => [l.sessionId, l] as const));

describe("hostIdsToAsk", () => {
  test.each([
    ["nothing answered: every desktop session, never a terminal one", new Map(), [`local_${MAIN}`, `local_${SIDE}`, `local_${FORK}`]],
    ["answered ones aren't asked again", new Map([[`local_${MAIN}`, false], [`local_${SIDE}`, true]]), [`local_${FORK}`]],
    ["all answered", new Map([[`local_${MAIN}`, false], [`local_${SIDE}`, true], [`local_${FORK}`, false]]), []],
  ] as const)("%s", (_name, answers, expected) => {
    expect(hostIdsToAsk(live, answers)).toEqual([...expected]);
  });
});

describe("isSideChat", () => {
  const answers = new Map([
    [`local_${MAIN}`, false],
    [`local_${SIDE}`, true],
    [`local_${FORK}`, false],
    [`local_${"0a1b2c3d-0000-4000-8000-0000000000e1"}`, true],
  ]);
  test.each([
    ["the main session", MAIN, false],
    ["a side chat by its live session's desktop id", SIDE, true],
    ["a fork another session started", FORK, false],
    ["a terminal session", TERMINAL, false],
    ["a side chat whose process isn't seen yet, by its own id", "0a1b2c3d-0000-4000-8000-0000000000e1", true],
    ["a transcript with no answer yet", "0a1b2c3d-0000-4000-8000-0000000000d1", false],
  ] as const)("%s", (_name, id, expected) => {
    expect(isSideChat(id, byId, answers)).toBe(expected);
  });

  test("a live session's desktop id wins over the transcript's own form", () => {
    const moved = new Map([[MAIN, { pid: 1, sessionId: MAIN, hostSessionId: "local_0a1b2c3d-0000-4000-8000-000000000099" }]]);
    expect(isSideChat(MAIN, moved, new Map([[hostIdOfTranscript(MAIN), true]]))).toBe(false);
  });
});

test("forgetSideChats removes only the side chats' Recent activity rows", () => {
  const event = (sessionId: string, at: number) => ({ key: `${sessionId}:${at}:done`, sessionId, project: "p", at, kind: "done" }) as unknown as SessionEvent;
  sessionEventCache.clear();
  for (const e of [event("v/side.jsonl", 1), event("v/side.jsonl", 2), event("v/main.jsonl", 3)]) sessionEventCache.set(e.key, e);
  forgetSideChats(new Set(["v/side.jsonl"]));
  expect([...sessionEventCache.values()].map((e) => e.sessionId)).toEqual(["v/main.jsonl"]);
  forgetSideChats(new Set());
  expect(sessionEventCache.size).toBe(1);
  sessionEventCache.clear();
});
