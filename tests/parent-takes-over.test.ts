// Sessions started by another session (docs/design.md "Watching", "Sessions started by another session"): the parent
// takes over their results and questions, so their done isn't read aloud and the concierge asks nothing of them.
// Each scene calls the app's own functions: the first-prompt check, the link check, the readout, and the concierge's
// payload and drop checks
import { describe, expect, test } from "bun:test";
import { buildConciergePayload, dropReason, type ConciergeSessionInput } from "../src/lib/concierge.ts";
import { ConciergeReadout } from "../src/lib/concierge-readout.ts";
import type { SessionEvent, SessionView } from "../src/lib/session-types.ts";
import { isReadAloudEvent } from "../src/lib/voice.ts";
import { parentTakesOver, startedBySession, type FirstPrompt } from "../src/lib/watching.ts";

const prompt = (turnOrigin: string | null | undefined, namedAtLaunch = false): FirstPrompt => ({
  turnOrigin,
  namedAtLaunch,
  at: "2026-11-11T03:29:26.475Z",
});

describe("started by another session, from the first prompt", () => {
  const scenes: [string, FirstPrompt | undefined, boolean][] = [
    ["a desktop app session started by start_session (sdk)", prompt("sdk"), true],
    ["a desktop app session started by start_session (host_synthetic)", prompt("host_synthetic"), true],
    ["a session the user started in the desktop app", prompt("human"), false],
    ["a terminal session started with a name and a prompt: written like the user's, not told apart", prompt("human", true), false],
    ["an older transcript without turnOrigin", prompt(undefined), false],
    ["no first prompt yet", undefined, false],
  ];
  for (const [scene, first, want] of scenes) test(scene, () => expect(startedBySession(first)).toBe(want));
});

describe("a parent takes over", () => {
  const scenes: [string, boolean, number | undefined, { startedAt?: number }[], boolean][] = [
    ["started by a session and linked to an older one", true, 200, [{ startedAt: 100 }], true],
    ["started by a session, linked only to a younger one (its own child)", true, 200, [{ startedAt: 300 }], false],
    ["started by a session, not linked (its parent closed)", true, 200, [], false],
    ["started by the user and linked to an older one: the user talks to it", false, 200, [{ startedAt: 100 }], false],
    ["a start time unknown: the link counts", true, undefined, [{ startedAt: 100 }], true],
  ];
  for (const [scene, started, own, peers, want] of scenes) {
    test(scene, () => expect(parentTakesOver(started, own, peers)).toBe(want));
  }
});

const ev = (type: SessionEvent["type"], sessionId: string, patch: Partial<SessionEvent> = {}): SessionEvent => ({
  key: `${type}:${sessionId}`,
  sessionId,
  project: sessionId,
  type,
  at: 0,
  ...patch,
});

describe("readout of a done whose parent takes it over", () => {
  test("which events are read aloud", () => {
    expect(isReadAloudEvent(ev("done", "child", { silent: true }))).toBe(false);
    expect(isReadAloudEvent(ev("done", "solo"))).toBe(true);
    expect(isReadAloudEvent(ev("waiting", "child"))).toBe(true);
    expect(isReadAloudEvent(ev("started", "solo"))).toBe(false);
  });

  test("outside the Concierge tab it isn't read; another done is", () => {
    const readout = new ConciergeReadout();
    expect(readout.event(ev("done", "child", { silent: true }))).toBe("skip");
    expect(readout.event(ev("done", "solo"))).toBe("speak");
  });

  test("in the tab it isn't held, so a failed request doesn't read it", () => {
    const readout = new ConciergeReadout();
    readout.opened([], false);
    expect(readout.event(ev("done", "child", { silent: true }))).toBe("skip");
    expect(readout.event(ev("done", "solo"))).toBe("held");
    expect(readout.failed().map((e) => e.sessionId)).toEqual(["solo"]);
  });
});

const view = (id: string, patch: Partial<SessionView> = {}): SessionView => ({
  id,
  project: id,
  slug: id,
  state: "done",
  sinceMs: 10_000,
  ...patch,
});

describe("the concierge asks nothing of a session its parent takes over", () => {
  // parent watches child (started by it); solo is a finished session the user started
  const inputs = (child: Partial<SessionView>): ConciergeSessionInput[] => [
    { view: view("parent", { state: "done" }) },
    { view: view("child", { parentTakesOver: true, ...child }), parentId: "parent" },
    { view: view("solo") },
  ];
  const payloadOf = (child: Partial<SessionView>) => buildConciergePayload(inputs(child), [], [], 0, "ja");

  const scenes: [string, Partial<SessionView>][] = [
    ["stopped on a permission prompt", { state: "waiting", waitingOn: "permission" }],
    ["stopped on a question tool", { state: "waiting", waitingOn: "question" }],
    ["its last reply asks its parent", { ask: { status: "asking", at: 0 } as SessionView["ask"] }],
  ];
  for (const [scene, child] of scenes) {
    test(`${scene}: sent as needing nothing, with parent_takes_over`, () => {
      const child0 = payloadOf(child).sessions.find((s) => s.id === "child")!;
      expect(child0.needs_reply).toBe(false);
      expect(child0.parent_takes_over).toBe(true);
    });
    test(`${scene}: a reply advice about it is dropped with its reason`, () => {
      const p = payloadOf(child);
      expect(dropReason({ line: "childの許可を確認してください", targetId: "child" }, "reply", p.sessions)).toBe("parent_takes_over");
      expect(dropReason({ line: "x", targetId: "child" }, "reply", p.sessions, false, new Set(), false)).toBe("parent_takes_over");
    });
    test(`${scene}: it doesn't keep a finished session out of the advice`, () => {
      const p = payloadOf(child);
      expect(dropReason({ line: "soloが終わりました。結果を確認", targetId: "solo" }, "check_result", p.sessions)).toBeUndefined();
    });
  }

  test("checking its result is dropped as watched", () => {
    const p = payloadOf({});
    expect(dropReason({ line: "childが終わりました。結果を確認", targetId: "child" }, "check_result", p.sessions)).toBe("watched");
  });

  test("a session the user started that waits on a permission prompt is still advised", () => {
    const p = buildConciergePayload([{ view: view("solo", { state: "waiting", waitingOn: "permission" }) }], [], [], 0, "ja");
    expect(p.sessions[0].needs_reply).toBe(true);
    expect(p.sessions[0].parent_takes_over).toBeUndefined();
    expect(dropReason({ line: "soloの許可を確認してください", targetId: "solo" }, "reply", p.sessions)).toBeUndefined();
  });
});
