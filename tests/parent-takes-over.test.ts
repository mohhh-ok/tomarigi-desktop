// Sessions started by another session (docs/design.md "Watching", "Sessions started by another session"): the parent
// takes over their results and questions, so their done isn't read aloud and the concierge asks nothing of them.
// Each scene calls the app's own functions: the first-prompt check, the link check, the readout, and the concierge's
// payload and drop checks
import { describe, expect, test } from "bun:test";
import {
  buildConciergePayload,
  conciergeStateOf,
  conciergeTriggerClasses,
  dropReason,
  type ConciergeSessionInput,
} from "../src/lib/concierge.ts";
import { ConciergeReadout } from "../src/lib/concierge-readout.ts";
import { conciergeStatusOf } from "../src/lib/concierge-status.ts";
import type { SessionEvent, SessionView } from "../src/lib/session-types.ts";
import { hasQuestion, waitsOnDeveloper } from "../src/lib/turn-verdict.ts";
import { isReadAloudEvent } from "../src/lib/voice.ts";
import { silentForParent, startedBySession, takenOverByParent, type FirstPrompt } from "../src/lib/watching.ts";
import { conciergeTabCounts } from "../src/perch/concierge-tab.ts";

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
    ["a terminal session with a name but no SessionStart hook line: not told apart", prompt("human", true), false],
    ["an older transcript without turnOrigin", prompt(undefined), false],
    ["no first prompt yet", undefined, false],
  ];
  for (const [scene, first, want] of scenes) test(scene, () => expect(startedBySession(first)).toBe(want));
});

describe("the user talks to it after its first prompt", () => {
  const scenes: [string, FirstPrompt | undefined, boolean, boolean][] = [
    ["started by start_session, only its parent's messages since", prompt("sdk"), false, true],
    ["started by start_session, the user typed in its pane", prompt("sdk"), true, false],
    ["started by the user, the user typed again", prompt("human"), true, false],
  ];
  for (const [scene, first, typed, want] of scenes) {
    test(scene, () => expect(startedBySession(first, typed)).toBe(want));
  }
});

// First prompts as transcripts write them. A terminal session given a name and a prompt at launch writes the agent-name
// line first and its prompt within a tenth of a second of the SessionStart hook; one the user typed comes seconds later
const AT0 = "2026-11-11T03:00:00.000Z";
const launched = (afterMs: number, named: boolean, turnOrigin = "human"): FirstPrompt => ({
  turnOrigin,
  namedAtLaunch: named,
  sessionStartAt: AT0,
  at: new Date(Date.parse(AT0) + afterMs).toISOString(),
});
const TYPED = launched(20_000, false); // the user started it and typed its first prompt
const TERMINAL_CHILD = launched(20, true); // `claude --name <name> "<prompt>"` from another session
const DESKTOP_CHILD = prompt("sdk"); // the desktop app's start_session
const DESKTOP_USER = prompt("human"); // the user started it in the desktop app

describe("started by another session, in a terminal", () => {
  const scenes: [string, FirstPrompt, boolean][] = [
    ["a name and a prompt at launch", TERMINAL_CHILD, true],
    ["a name at launch, the prompt typed seconds later", launched(8_000, true), false],
    ["a prompt at launch without a name (the user typed fast, or `claude \"...\"`)", launched(300, false), false],
    ["a name and a prompt, but no SessionStart hook line to compare with", { ...TERMINAL_CHILD, sessionStartAt: null }, false],
    ["the user started it and typed", TYPED, false],
  ];
  for (const [scene, first, want] of scenes) test(scene, () => expect(startedBySession(first)).toBe(want));
});

/** A set of running sessions: when each started, its first prompt, whether the user typed in it later, and the links */
interface Scene {
  sessions: Record<string, { startedAt: number; first: FirstPrompt; typed?: boolean }>;
  links: [string, string][];
}
function takenOver(scene: Scene): Record<string, boolean> {
  const peers = (id: string) => scene.links.flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));
  const world = {
    startedAt: (id: string) => scene.sessions[id]?.startedAt,
    startedBySession: (id: string) => {
      const s = scene.sessions[id];
      return s !== undefined && startedBySession(s.first, s.typed);
    },
    peers,
  };
  return Object.fromEntries(Object.keys(scene.sessions).map((id) => [id, takenOverByParent(id, world)]));
}

describe("which sessions a parent takes over", () => {
  const P = { startedAt: 100, first: TYPED };
  const C = { startedAt: 200, first: TERMINAL_CHILD };
  const G = { startedAt: 300, first: TERMINAL_CHILD };
  const R = { startedAt: 400, first: TERMINAL_CHILD }; // P's rebirth: same name, a prompt at launch; P has closed
  const scenes: [string, Scene, Record<string, boolean>][] = [
    ["P started C", { sessions: { P, C }, links: [["P", "C"]] }, { P: false, C: true }],
    ["P started C, C started G", { sessions: { P, C, G }, links: [["P", "C"], ["C", "G"]] }, { P: false, C: true, G: true }],
    [
      "P started C, then P was reborn as R and R talks with C: R isn't C's child (C lost its parent); C is read aloud",
      { sessions: { C, R }, links: [["C", "R"]] },
      { C: false, R: false },
    ],
    [
      "known error: after the rebirth, C's child G is read aloud too, since C lost its parent",
      { sessions: { C, G, R }, links: [["C", "R"], ["C", "G"]] },
      { C: false, G: false, R: false },
    ],
    [
      "known error: the user ran `claude --name foo \"...\"` and it talks with an older session the user started",
      { sessions: { P, foo: { startedAt: 200, first: TERMINAL_CHILD } }, links: [["P", "foo"]] },
      { P: false, foo: true },
    ],
    [
      "the user typed in that session after its first prompt: it is no longer taken over",
      { sessions: { P, foo: { startedAt: 200, first: TERMINAL_CHILD, typed: true } }, links: [["P", "foo"]] },
      { P: false, foo: false },
    ],
    [
      "the user typed in C's pane: C is no longer taken over, and G still is (C is now a parent the user talks to)",
      { sessions: { P, C: { ...C, typed: true }, G }, links: [["P", "C"], ["C", "G"]] },
      { P: false, C: false, G: true },
    ],
    [
      "a desktop app session started C by start_session",
      { sessions: { P: { startedAt: 100, first: DESKTOP_USER }, C: { startedAt: 200, first: DESKTOP_CHILD } }, links: [["P", "C"]] },
      { P: false, C: true },
    ],
    [
      "two sessions the user started exchanged messages: neither is taken over",
      { sessions: { P, Q: { startedAt: 200, first: TYPED } }, links: [["P", "Q"]] },
      { P: false, Q: false },
    ],
    ["C's parent closed and nothing else is linked", { sessions: { C }, links: [] }, { C: false }],
  ];
  for (const [name, scene, want] of scenes) test(name, () => expect(takenOver(scene)).toEqual(want));
});

const ev = (type: SessionEvent["type"], sessionId: string, patch: Partial<SessionEvent> = {}): SessionEvent => ({
  key: `${type}:${sessionId}`,
  sessionId,
  project: sessionId,
  type,
  at: 0,
  ...patch,
});

describe("which events of a session go silent", () => {
  const types: SessionEvent["type"][] = ["done", "waiting", "started", "closed"];
  const scenes: [string, boolean, SessionEvent["type"][]][] = [
    ["a parent takes it over: its done and needs reply", true, ["done", "waiting"]],
    ["no parent takes it over: none", false, []],
  ];
  for (const [scene, takenOver, silent] of scenes) {
    test(scene, () => {
      const got = types.filter((type) => silentForParent(ev(type, "s"), takenOver).silent);
      expect(got).toEqual(silent);
    });
  }
});

describe("readout of a done whose parent takes it over", () => {
  test("which events are read aloud", () => {
    expect(isReadAloudEvent(ev("done", "child", { silent: true }))).toBe(false);
    expect(isReadAloudEvent(ev("waiting", "child", { silent: true }))).toBe(false);
    expect(isReadAloudEvent(ev("done", "solo"))).toBe(true);
    expect(isReadAloudEvent(ev("waiting", "child"))).toBe(true);
    expect(isReadAloudEvent(ev("started", "solo"))).toBe(false);
  });

  test("outside the Concierge tab it isn't read; another done is", () => {
    const readout = new ConciergeReadout();
    expect(readout.event(ev("done", "child", { silent: true }))).toBe("skip");
    expect(readout.event(ev("done", "solo"))).toBe("speak");
  });

  test("its needs reply isn't read outside the tab either", () => {
    expect(new ConciergeReadout().event(ev("waiting", "child", { silent: true }))).toBe("skip");
  });

  test("in the tab it isn't held, so a failed request doesn't read it", () => {
    const readout = new ConciergeReadout();
    readout.opened([], false);
    expect(readout.event(ev("done", "child", { silent: true }))).toBe("skip");
    expect(readout.event(ev("waiting", "child", { silent: true }))).toBe("skip");
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

describe("one check for waiting on the developer, everywhere the concierge counts it", () => {
  // child waits on a permission prompt and its parent takes it over; solo waits on one the user started
  const child = view("child", { state: "waiting", waitingOn: "permission", parentTakesOver: true });
  const childAsking = view("child2", { state: "done", ask: { status: "asking", at: 0 } as SessionView["ask"], parentTakesOver: true });
  const solo = view("solo", { state: "waiting", waitingOn: "permission" });
  const scenes: [string, SessionView, { waits: boolean; status: string; state: string; trigger: string }][] = [
    ["a child on a permission prompt", child, { waits: false, status: "working", state: "stopped", trigger: "working" }],
    ["a child whose last reply asks its parent", childAsking, { waits: false, status: "done", state: "stopped", trigger: "done" }],
    ["a session the user started, on a permission prompt", solo, { waits: true, status: "reply", state: "reply", trigger: "reply" }],
  ];
  for (const [scene, v, want] of scenes) {
    test(scene, () => {
      expect({
        waits: waitsOnDeveloper(v),
        status: conciergeStatusOf(v),
        state: conciergeStateOf(v),
        trigger: conciergeTriggerClasses([v]).get(v.id),
      }).toEqual(want);
      // The "?" stays on its bird
      expect(hasQuestion(v)).toBe(true);
    });
  }

  test("the Concierge tab counts only the session the user started", () => {
    expect(conciergeTabCounts([child, childAsking, solo])).toEqual({ others: 3, waiting: 1 });
  });
});
