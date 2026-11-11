// Sessions started by another session (docs/design.md "Watching", "Sessions started by another session"): the parent
// takes over their results and questions, so their done isn't read aloud and the concierge asks nothing of them.
// Each scene calls the app's own functions: the first-prompt check, the link check (with the same reading of the links
// as a scan, takenOverWorld, over a small stand-in for the links a scan resolves), the readout, and the concierge's
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
import {
  rememberLatestTurnTyped,
  silentForParent,
  startedBySession,
  takenOverByParent,
  takenOverWorld,
  type FirstPrompt,
} from "../src/lib/watching.ts";
import type { LiveSession, PeerLink } from "../src/lib/session-types.ts";
import type { WatchLinks } from "../src/lib/session-watch.ts";
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

describe("the user started its latest turn", () => {
  const scenes: [string, FirstPrompt | undefined, boolean, boolean][] = [
    ["started by start_session, only its parent's messages since", prompt("sdk"), false, true],
    ["started by start_session, the user typed in its pane in the latest turn", prompt("sdk"), true, false],
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

/**
 * A set of running sessions: when each started, its first prompt, what each read of its transcript after the first
 * prompt said of who started the latest turn (lastTurnTyped of scan_peer_names: true typed, false its parent or the app,
 * null no prompt in that part), whether it is on screen (has a view id; default yes), and the links. Read as a scan reads them: a stand-in for the WatchLinks that
 * resolveWatchLinks gives, passed to the app's takenOverWorld
 */
interface Scene {
  sessions: Record<string, { startedAt: number; first: FirstPrompt; reads?: (boolean | null)[]; onScreen?: boolean }>;
  links: [string, string][];
}
function watchOf(scene: Scene): Pick<WatchLinks, "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf"> {
  const entries = Object.entries(scene.sessions);
  const viewId = (id: string) => `root/${id}.jsonl`;
  // Each read of a session's transcript recorded as a scan records it
  const typedIds = new Set<string>();
  for (const [id, s] of entries) for (const read of s.reads ?? []) rememberLatestTurnTyped(typedIds, viewId(id), read);
  return {
    liveBySessionId: new Map(entries.map(([id, s], i) => [id, { pid: i + 1, sessionId: id, startedAt: s.startedAt } as LiveSession])),
    viewIdBySessionId: new Map(entries.filter(([, s]) => s.onScreen !== false).map(([id]) => [id, viewId(id)])),
    peerLinksOf: (id) =>
      scene.links
        .flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []))
        .map((p) => ({ sessionId: p, name: p, startedAt: scene.sessions[p]?.startedAt, active: false }) as PeerLink),
    startedBySessionOf: (v) => {
      const s = entries.find(([id]) => viewId(id) === v)?.[1];
      return s !== undefined && startedBySession(s.first, typedIds.has(v));
    },
  };
}
function takenOver(scene: Scene): Record<string, boolean> {
  const world = takenOverWorld(watchOf(scene));
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
      "the user started that session's latest turn by typing in it: it isn't taken over",
      { sessions: { P, foo: { startedAt: 200, first: TERMINAL_CHILD, reads: [true] } }, links: [["P", "foo"]] },
      { P: false, foo: false },
    ],
    [
      "the user started C's latest turn by typing in its pane: C isn't taken over, and G still is (C is now a parent the user talks to)",
      { sessions: { P, C: { ...C, reads: [true] }, G }, links: [["P", "C"], ["C", "G"]] },
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
    [
      "C's parent is not on screen (another watched folder): it isn't known to be started by another session, so it counts as a parent",
      { sessions: { P: { ...C, startedAt: 100, onScreen: false }, C }, links: [["P", "C"]] },
      { P: false, C: true },
    ],
    [
      "the older linked session is on screen: whether it was started by another session is read from it (a reborn pair stays apart)",
      { sessions: { C: { ...C, onScreen: true }, R }, links: [["C", "R"]] },
      { C: false, R: false },
    ],
  ];
  for (const [name, scene, want] of scenes) test(name, () => expect(takenOver(scene)).toEqual(want));
});

describe("who started the child's latest turn", () => {
  // Reads of the child's transcript, one per scan, in order: the first from the top (its first prompt never counts), the
  // later ones from where the last stopped (start > 0). What arrives while it works is an attachment: a prompt the user
  // typed into it then says true, while a read that has only a task notification or a message says null
  const scenes: [string, FirstPrompt, (boolean | null)[], boolean][] = [
    ["desktop: only its parent's task so far", DESKTOP_CHILD, [null], true],
    ["desktop: the user typed and the turn ended", DESKTOP_CHILD, [true], false],
    ["desktop: then a turn started by its parent's message", DESKTOP_CHILD, [true, false], true],
    ["desktop: typed and then its parent's message in the same read", DESKTOP_CHILD, [false], true],
    ["desktop: a task notification arrives while it works on the typed turn (a later read with no prompt)", DESKTOP_CHILD, [true, null], false],
    ["desktop: back with its parent, then a later read with no prompt", DESKTOP_CHILD, [true, false, null], true],
    ["desktop: the user typed again after its parent's turn", DESKTOP_CHILD, [true, false, true], false],
    ["desktop: the user typed into it while it worked on its parent's turn (a queued prompt)", DESKTOP_CHILD, [false, true], false],
    ["desktop: typed into it while it worked, then its parent's next turn", DESKTOP_CHILD, [false, true, false], true],
    ["ghostty: only its first prompt, human too", TERMINAL_CHILD, [null], true],
    ["ghostty: the user typed in its pane", TERMINAL_CHILD, [null, true], false],
    ["ghostty: then its parent's message", TERMINAL_CHILD, [null, true, false], true],
    ["ghostty: a task notification arrives while it works on the typed turn", TERMINAL_CHILD, [true, null], false],
    ["ghostty: the user typed into it while it worked on its parent's turn (a queued prompt)", TERMINAL_CHILD, [null, false, true], false],
  ];
  const P = { startedAt: 100, first: TYPED };
  for (const [scene, first, reads, want] of scenes) {
    test(scene, () => expect(takenOver({ sessions: { P, C: { startedAt: 200, first, reads } }, links: [["P", "C"]] }).C).toBe(want));
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
