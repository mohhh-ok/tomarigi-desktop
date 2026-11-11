// Sessions started by another session (docs/design.md "Watching", "Sessions started by another session"): the parent
// takes over their results and what it can answer (a reply that asks it, a wrap_up's ask), so those aren't read aloud
// and the concierge doesn't ask the developer about them; a question tool or a permission prompt still waits on the
// developer.
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
import { deriveState, waitsOnWrapUpAsk } from "../src/lib/bird-state.ts";
import { deriveSessionEvents } from "../src/lib/session-events.ts";
import type { TailEvent } from "../src/lib/transcript.ts";
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
  const events: [string, SessionEvent][] = [
    ["done", ev("done", "s")],
    ["waiting", ev("waiting", "s")],
    ["waiting on a wrap_up's ask", ev("waiting", "s", { wrapUpAsk: true })],
    ["started", ev("started", "s")],
    ["closed", ev("closed", "s")],
  ];
  const scenes: [string, boolean, string[]][] = [
    // A waiting on a question tool or a permission prompt only the user can answer; a wrap_up's ask reaches the parent
    ["a parent takes it over: its done and a wrap_up's ask", true, ["done", "waiting on a wrap_up's ask"]],
    ["no parent takes it over: none", false, []],
  ];
  for (const [scene, takenOver, silent] of scenes) {
    test(scene, () => {
      const got = events.filter(([, e]) => silentForParent(e, takenOver).silent).map(([name]) => name);
      expect(got).toEqual(silent);
    });
  }
});

describe("a waiting on a wrap_up's ask is told from a question tool and a permission prompt", () => {
  const WRAP_UP = "mcp__ccd_turn__wrap_up";
  const t = (kind: TailEvent["kind"], at: number, patch: Partial<TailEvent> = {}): TailEvent => ({ kind, at, ...patch });
  const tailOf = (events: TailEvent[]) => ({
    kind: events.at(-1)?.kind ?? ("unknown" as const),
    toolName: events.at(-1)?.toolName,
    events,
    chickSignals: new Map(),
    backgroundTaskStarts: new Map(),
    peerNames: new Map(),
  });
  const wrapUp = [t("user", 1, { text: "書いて" }), t("tool_use", 2, { toolName: WRAP_UP, ask: { question: "よいですか？" } }), t("tool_result", 3), t("assistant_text", 4)];
  const questionTool = [t("user", 1, { text: "書いて" }), t("tool_use", 2, { toolName: "AskUserQuestion" })];
  const scenes: [string, TailEvent[], boolean, boolean][] = [
    // scene, transcript, Claude Code's own waiting status (a permission prompt / an open question), wrapUpAsk
    ["a wrap_up's ask", wrapUp, false, true],
    ["a question tool", questionTool, false, false],
    ["a question tool still open (written after the answer)", [t("user", 1, { text: "書いて" })], true, false],
    ["a permission prompt after a wrap_up's ask", wrapUp, true, false],
  ];
  test("a permission prompt (or Claude Code's open question tool) makes no needs reply event: nothing to read", () => {
    // Claude Code writes the tool call only after it is answered; the waiting is its own status alone
    const open = [t("user", 1, { text: "書いて" })];
    expect(deriveSessionEvents(tailOf(open), "s", "p", [], new Map(), undefined, 60_000).map((e) => e.type)).toEqual(["started"]);
  });
  for (const [scene, events, liveWaiting, want] of scenes) {
    test(scene, () => {
      const state = liveWaiting ? "waiting" : deriveState(tailOf(events), 60_000, false);
      expect(state).toBe("waiting");
      expect(waitsOnWrapUpAsk(state, liveWaiting, events)).toBe(want);
      if (liveWaiting) return;
      const waiting = deriveSessionEvents(tailOf(events), "s", "p", [], new Map(), undefined, 60_000).find((e) => e.type === "waiting")!;
      expect(waiting.wrapUpAsk === true).toBe(want);
    });
  }
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

const asking = { status: "asking", at: 0 } as SessionView["ask"];

// Why a session stopped decides whether its parent takes it over (docs/design.md "Watching", "Sessions started by
// another session"; the user's decision): a done, or a reply that asks its parent (the turn verdict), is the parent's;
// a permission prompt or a question tool (the machine state) only the user can answer, so the concierge advises it and
// a question tool's needs reply is read. A permission prompt makes no event (Claude Code doesn't write it to the
// transcript; deriveSessionEvents), so nothing is read for it, for any session: its scenes have no event.
// Each scene runs the app's functions from the session to the readout, the concierge's facts, its drop check, and the
// Concierge tab's status, trigger, and count
describe("a session stopped, by why it stopped and whether a parent takes it over", () => {
  interface Want {
    readAloud: boolean;
    needsReply: boolean;
    source: "machine" | "verdict" | undefined;
    /** dropReason of a reply advice about it */
    replyDrop: string | undefined;
    status: string;
    trigger: string;
  }
  const scenes: [string, Partial<SessionView>, SessionEvent | undefined, Want][] = [
    [
      "a child on a permission prompt",
      { state: "waiting", waitingOn: "permission", parentTakesOver: true },
      undefined,
      { readAloud: false, needsReply: true, source: "machine", replyDrop: undefined, status: "reply", trigger: "reply" },
    ],
    [
      "a child on a question tool",
      { state: "waiting", waitingOn: "question", parentTakesOver: true },
      ev("waiting", "s"),
      { readAloud: true, needsReply: true, source: "machine", replyDrop: undefined, status: "reply", trigger: "reply" },
    ],
    [
      "a child on its wrap_up's ask (its report reaches the parent)",
      { state: "waiting", waitingOn: "question", wrapUpAsk: true, parentTakesOver: true },
      ev("waiting", "s", { wrapUpAsk: true }),
      { readAloud: false, needsReply: false, source: undefined, replyDrop: "parent_takes_over", status: "working", trigger: "working" },
    ],
    [
      "a child whose reply asks its parent",
      { state: "done", ask: asking, parentTakesOver: true },
      ev("done", "s", { ask: asking }),
      { readAloud: false, needsReply: false, source: undefined, replyDrop: "parent_takes_over", status: "done", trigger: "done" },
    ],
    [
      "a child that finished",
      { state: "done", parentTakesOver: true },
      ev("done", "s"),
      { readAloud: false, needsReply: false, source: undefined, replyDrop: "parent_takes_over", status: "done", trigger: "done" },
    ],
    [
      "a session the user started, on a permission prompt",
      { state: "waiting", waitingOn: "permission" },
      undefined,
      { readAloud: false, needsReply: true, source: "machine", replyDrop: undefined, status: "reply", trigger: "reply" },
    ],
    [
      "a session the user started, on its wrap_up's ask",
      { state: "waiting", waitingOn: "question", wrapUpAsk: true },
      ev("waiting", "s", { wrapUpAsk: true }),
      { readAloud: true, needsReply: true, source: "machine", replyDrop: undefined, status: "reply", trigger: "reply" },
    ],
    [
      "a session the user started, whose reply asks",
      { state: "done", ask: asking },
      ev("done", "s", { ask: asking }),
      { readAloud: true, needsReply: true, source: "verdict", replyDrop: undefined, status: "reply", trigger: "reply" },
    ],
    [
      "a session the user started, that finished",
      { state: "done" },
      ev("done", "s"),
      { readAloud: true, needsReply: false, source: undefined, replyDrop: "no_reply_needed", status: "done", trigger: "done" },
    ],
  ];
  for (const [scene, patch, event, want] of scenes) {
    test(scene, () => {
      const s = view("s", patch);
      const kept = event && silentForParent(event, s.parentTakesOver === true);
      const p = buildConciergePayload(
        [{ view: view("parent", { state: "working" }) }, { view: s, parentId: s.parentTakesOver ? "parent" : undefined }],
        [],
        [],
        0,
        "ja",
      );
      const fact = p.sessions.find((x) => x.id === "s")!;
      expect({
        readAloud: kept !== undefined && isReadAloudEvent(kept),
        needsReply: fact.needs_reply,
        source: fact.needs_reply_source,
        replyDrop: dropReason({ line: "sの許可を確認してください", targetId: "s" }, "reply", p.sessions),
        status: conciergeStatusOf(s),
        trigger: conciergeTriggerClasses([s]).get("s"),
      }).toEqual(want);
      if (kept) expect(new ConciergeReadout().event(kept)).toBe(want.readAloud ? "speak" : "skip");
      expect(waitsOnDeveloper(s)).toBe(want.needsReply);
      expect(conciergeStateOf(s)).toBe(want.needsReply ? "reply" : "stopped");
      expect(fact.parent_takes_over).toBe(s.parentTakesOver);
      // The "?" stays on its bird whenever it needs an answer
      expect(hasQuestion(s)).toBe(s.state === "waiting" || patch.ask !== undefined);
    });
  }

  test("a child's question tool is held in the Concierge tab like any other needs reply", () => {
    const readout = new ConciergeReadout();
    readout.opened([], false);
    expect(readout.event(silentForParent(ev("waiting", "child"), true))).toBe("held");
  });

  test("a child that asks its parent doesn't keep a finished session out of the advice", () => {
    const p = buildConciergePayload(
      [
        { view: view("parent") },
        { view: view("child", { ask: asking, parentTakesOver: true }), parentId: "parent" },
        { view: view("solo") },
      ],
      [],
      [],
      0,
      "ja",
    );
    expect(dropReason({ line: "soloが終わりました。結果を確認", targetId: "solo" }, "check_result", p.sessions)).toBeUndefined();
  });

  test("checking a child's result is dropped as watched", () => {
    const p = buildConciergePayload([{ view: view("parent") }, { view: view("child", { parentTakesOver: true }), parentId: "parent" }], [], [], 0, "ja");
    expect(dropReason({ line: "childが終わりました。結果を確認", targetId: "child" }, "check_result", p.sessions)).toBe("watched");
  });

  test("the Concierge tab counts the child on a permission prompt, not the ones its parent can answer", () => {
    const child = view("child", { state: "waiting", waitingOn: "permission", parentTakesOver: true });
    const childAsking = view("child2", { ask: asking, parentTakesOver: true });
    const childWrapUp = view("child3", { state: "waiting", waitingOn: "question", wrapUpAsk: true, parentTakesOver: true });
    const solo = view("solo", { state: "waiting", waitingOn: "permission" });
    expect(conciergeTabCounts([child, childAsking, childWrapUp, solo])).toEqual({ others: 4, waiting: 2 });
  });
});
