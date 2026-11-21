// Between two sessions neither started, a session watches the other only while the other's latest turn was started
// by a message from it, or a message from it arrived during that turn (docs/design.md "Watching"). A turn started by
// the user's input or by a third session's message doesn't make it watching, hold its done, or make it continuing. A
// first prompt and a turn whose starter isn't known count as before; a parent watches its own child whatever started
// the child's turn; the links stay.
// Each scene reads the links as a scan does (takenOverWorld over a stand-in for resolveWatchLinks, with the latest
// turns rememberLatestTurn keeps from scan_peer_names' reads) and calls what buildViews in lib/sessions.ts calls:
// peersWatchedBy, watchingCount, sessionContinuing, peerHoldChicks and deriveSessionEvents
import { describe, expect, test } from "bun:test";
import { deriveSessionEvents } from "../src/lib/session-events.ts";
import type { LiveSession, PeerLink } from "../src/lib/session-types.ts";
import type { WatchLinks } from "../src/lib/session-watch.ts";
import type { TailEvent } from "../src/lib/transcript.ts";
import { sessionContinuing } from "../src/lib/turn-verdict.ts";
import {
  isChildSession,
  peerHoldChicks,
  peerLookup,
  peersWatchedBy,
  startedBySession,
  takenOverWorld,
  watchingCount,
  type FirstPrompt,
} from "../src/lib/watching.ts";
import {
  latestTurnBy,
  rememberLatestTurn,
  turnStarterSession,
  type LatestTurn,
  type PeerRef,
  type TurnStarter,
} from "../src/lib/watching-turns.ts";

const AT = "2026-01-01T00:00:00.400Z";
/** A session the user started in a terminal: no name at launch, its first prompt typed */
const TERMINAL_USER: FirstPrompt = { turnOrigin: "human", namedAtLaunch: false, sessionStartAt: "2026-01-01T00:00:00.000Z", at: AT };
/** A session another session started in a terminal (`claude --name <name> "<prompt>"`) */
const TERMINAL_CHILD: FirstPrompt = { turnOrigin: "human", namedAtLaunch: true, sessionStartAt: "2026-01-01T00:00:00.000Z", at: AT };

const NOW = 10_000_000;

interface Session {
  pid: number;
  name: string;
  startedAt: number;
  first: FirstPrompt;
  /** Its latest turn as scan_peer_names' reads leave it (rememberLatestTurn) */
  turn?: LatestTurn;
  active?: boolean;
}
type Scene = { sessions: Record<string, Session>; links: [string, string][] };

const viewId = (id: string) => `root/${id}.jsonl`;
/** A message from a session, as its transcript line names the sender (origin.name, verifiedPeerPid, from) */
const from = (s: Session): PeerRef => ({ name: s.name, pid: s.pid, from: `uds:/tmp/cc-socks/${s.pid}.sock` });
const byPeer = (s: Session): TurnStarter => ({ kind: "peer", ...from(s) });
const TYPED: TurnStarter = { kind: "typed" };

function watchOf(scene: Scene): Pick<WatchLinks, "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf" | "childOf" | "latestTurnOf"> {
  const entries = Object.entries(scene.sessions);
  const byView = (v: string) => entries.find(([id]) => viewId(id) === v)?.[1];
  return {
    liveBySessionId: new Map(entries.map(([id, s]) => [id, { pid: s.pid, sessionId: id, name: s.name, startedAt: s.startedAt } as LiveSession])),
    viewIdBySessionId: new Map(entries.map(([id]) => [id, viewId(id)])),
    peerLinksOf: (id) => peersOf(scene, id),
    startedBySessionOf: (v) => {
      const s = byView(v);
      return s !== undefined && startedBySession(s.first, s.turn?.starter?.kind === "typed");
    },
    childOf: (v) => {
      const s = byView(v);
      return s !== undefined && isChildSession(s.first);
    },
    latestTurnOf: (v) => byView(v)?.turn,
  };
}

function peersOf(scene: Scene, id: string): PeerLink[] {
  return scene.links
    .flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []))
    .map((p) => {
      const active = scene.sessions[p].active ?? false;
      return { sessionId: p, name: scene.sessions[p].name, startedAt: scene.sessions[p].startedAt, active, lastActiveAt: active ? NOW : undefined };
    });
}

const t = (kind: TailEvent["kind"], at: number, patch: Partial<TailEvent> = {}): TailEvent => ({ kind, at, ...patch });
const tail = {
  kind: "assistant_text" as const,
  events: [t("user", NOW - 3_000, { text: "push して" }), t("assistant_text", NOW - 2_000, { text: "push しました" })],
  chickSignals: new Map(),
  backgroundTaskStarts: new Map(),
  peerNames: new Map(),
};

/** What buildViews makes of a done session: its watching, its continuing for a reply that doesn't continue, whether
 * its done is emitted (not held), and its links */
function viewOf(scene: Scene, id: string) {
  const world = takenOverWorld(watchOf(scene));
  const peers = peersOf(scene, id);
  const watched = peersWatchedBy(id, peers, world);
  const watching = watchingCount("done", watched, NOW, NOW - 1_000);
  const chicks = peerHoldChicks(watched, () => undefined, NOW);
  const done = deriveSessionEvents(tail, viewId(id), id, chicks, new Map(), undefined, NOW).some((e) => e.type === "done");
  return { watching, continuing: sessionContinuing(false, watching, 1_000).continuing, done, links: peers.map((p) => p.sessionId) };
}

// Two sessions the user started in terminals in one repository, which lined up their pushes by messages
const A: Session = { pid: 111, name: "repo-a1", startedAt: 100, first: TERMINAL_USER };
const B: Session = { pid: 222, name: "repo-b2", startedAt: 50, first: TERMINAL_USER };
const C: Session = { pid: 333, name: "child-c", startedAt: 300, first: TERMINAL_CHILD };

describe("two sessions neither started", () => {
  test("A told B it is done; B goes on with the user's request: A isn't watching or continuing, its done isn't held", () => {
    const scene: Scene = { sessions: { A, B: { ...B, active: true, turn: { starter: TYPED, peers: [] } } }, links: [["A", "B"]] };
    expect(viewOf(scene, "A")).toEqual({ watching: undefined, continuing: false, done: true, links: ["B"] });
  });

  test("B goes on with a third session's report: A isn't watching or continuing, its done isn't held", () => {
    const scene: Scene = {
      sessions: { A, B: { ...B, active: true, turn: { starter: byPeer(C), peers: [] } }, C },
      links: [["A", "B"], ["B", "C"]],
    };
    expect(viewOf(scene, "A")).toEqual({ watching: undefined, continuing: false, done: true, links: ["B"] });
  });

  test("B works on A's message: A watches it", () => {
    const scene: Scene = { sessions: { A, B: { ...B, active: true, turn: { starter: byPeer(A), peers: [] } } }, links: [["A", "B"]] };
    expect(viewOf(scene, "A")).toEqual({ watching: 1, continuing: true, done: false, links: ["B"] });
  });

  test("B's turn started by the user's input, and A's message arrived during it: A watches it", () => {
    const scene: Scene = { sessions: { A, B: { ...B, active: true, turn: { starter: TYPED, peers: [from(A)] } } }, links: [["A", "B"]] };
    expect(viewOf(scene, "A")).toEqual({ watching: 1, continuing: true, done: false, links: ["B"] });
  });

  test("B has only its first prompt, or a turn whose starter isn't known: A watches it as before", () => {
    for (const turn of [undefined, { starter: { kind: "other" } as TurnStarter, peers: [] }, { starter: { kind: "peer", name: "gone" } as TurnStarter, peers: [] }]) {
      const scene: Scene = { sessions: { A, B: { ...B, active: true, turn } }, links: [["A", "B"]] };
      expect(viewOf(scene, "A").watching).toBe(1);
    }
  });
});

describe("a session and its own child", () => {
  test("the child's turn was started by its own child's report: the parent still watches it", () => {
    const G: Session = { pid: 444, name: "grandchild", startedAt: 400, first: TERMINAL_CHILD };
    const scene: Scene = {
      sessions: { A, C: { ...C, active: true, turn: { starter: byPeer(G), peers: [] } }, G },
      links: [["A", "C"], ["C", "G"]],
    };
    expect(viewOf(scene, "A")).toEqual({ watching: 1, continuing: true, done: false, links: ["C"] });
  });

  test("the child doesn't watch its moving parent, whatever started the parent's turn", () => {
    const scene: Scene = { sessions: { A: { ...A, active: true, turn: { starter: byPeer(C), peers: [] } }, C }, links: [["A", "C"]] };
    expect(viewOf(scene, "C").watching).toBeUndefined();
  });
});

describe("who started a turn", () => {
  const live = [A, B].map((s, i) => ({ pid: s.pid, sessionId: ["A", "B"][i], name: s.name }) as LiveSession);
  const lookup = peerLookup(live);
  const own = { sessionId: "A", pid: 111 };

  test("by the sender's pid, else the pid in its socket path, else its name or desktop app id", () => {
    expect(turnStarterSession({ pid: 111, name: "renamed" }, own, lookup)).toBe("self");
    expect(turnStarterSession({ pid: 999 }, own, lookup)).toBe("other");
    expect(turnStarterSession({ from: "uds:/tmp/cc-socks/111.sock" }, own, lookup)).toBe("self");
    expect(turnStarterSession({ name: "repo-a1" }, own, lookup)).toBe("self");
    expect(turnStarterSession({ name: "repo-b2" }, own, lookup)).toBe("other");
    expect(turnStarterSession({ name: "gone" }, own, lookup)).toBe("unknown");
    expect(turnStarterSession({}, own, lookup)).toBe("unknown");
  });

  test("a message own sent before it was resumed under another pid: matched by its name or desktop app id", () => {
    const resumed = [{ pid: 555, sessionId: "A", name: "repo-a1", hostSessionId: "local_0000-a" }, { pid: 222, sessionId: "B", name: "repo-b2" }] as LiveSession[];
    const after = { sessionId: "A", pid: 555 };
    expect(turnStarterSession({ pid: 111, name: "repo-a1" }, after, peerLookup(resumed))).toBe("self");
    expect(turnStarterSession({ pid: 111, from: "local_0000-a" }, after, peerLookup(resumed))).toBe("self");
    expect(turnStarterSession({ pid: 111, name: "repo-b2" }, after, peerLookup(resumed))).toBe("other");
    expect(turnStarterSession({ pid: 111, name: "gone" }, after, peerLookup(resumed))).toBe("other");
    expect(turnStarterSession({ pid: 111 }, after, peerLookup(resumed))).toBe("other");
  });

  test("a message from own during the turn counts as own's turn; the desktop app's own turn isn't known", () => {
    expect(latestTurnBy({ starter: TYPED, peers: [{ pid: 111 }] }, own, lookup)).toBe("self");
    expect(latestTurnBy({ starter: TYPED, peers: [{ pid: 333 }] }, own, lookup)).toBe("typed");
    expect(latestTurnBy({ starter: { kind: "other" }, peers: [] }, own, lookup)).toBe("unknown");
    expect(latestTurnBy({ peers: [] }, own, lookup)).toBeUndefined();
    expect(latestTurnBy(undefined, own, lookup)).toBeUndefined();
  });

  test("reads replace the turn when one starts, and add the senders that arrive meanwhile", () => {
    const turns = new Map<string, LatestTurn>();
    rememberLatestTurn(turns, "v", { lastTurnStarter: TYPED, turnPeers: [] }, true);
    rememberLatestTurn(turns, "v", { lastTurnStarter: null, turnPeers: [{ pid: 111 }] }, false);
    expect(turns.get("v")).toEqual({ starter: TYPED, peers: [{ pid: 111 }] });
    rememberLatestTurn(turns, "v", { lastTurnStarter: null, turnPeers: [] }, false);
    expect(turns.get("v")).toEqual({ starter: TYPED, peers: [{ pid: 111 }] });
    rememberLatestTurn(turns, "v", { lastTurnStarter: { kind: "peer", pid: 333 }, turnPeers: [], turnStarted: true }, false);
    expect(turns.get("v")).toEqual({ starter: { kind: "peer", pid: 333 }, peers: [] });
    // A read from the top again (only while the first prompt hasn't come) replaces, so senders aren't counted twice
    rememberLatestTurn(turns, "v", { lastTurnStarter: null, turnPeers: [{ pid: 111 }] }, true);
    rememberLatestTurn(turns, "v", { lastTurnStarter: null, turnPeers: [{ pid: 111 }] }, true);
    expect(turns.get("v")).toEqual({ peers: [{ pid: 111 }] });
  });

  test("the user types into it while it works: the senders that arrived earlier in the turn stay", () => {
    const turns = new Map<string, LatestTurn>();
    rememberLatestTurn(turns, "v", { lastTurnStarter: TYPED, turnPeers: [{ pid: 111 }] }, true);
    rememberLatestTurn(turns, "v", { lastTurnStarter: TYPED, turnPeers: [] }, false);
    expect(latestTurnBy(turns.get("v"), own, lookup)).toBe("self");
  });

  test("a sender that sends several messages during the turn is kept once", () => {
    const turns = new Map<string, LatestTurn>();
    rememberLatestTurn(turns, "v", { lastTurnStarter: TYPED, turnPeers: [{ pid: 111 }, { pid: 111 }] }, true);
    rememberLatestTurn(turns, "v", { lastTurnStarter: null, turnPeers: [{ pid: 111 }, { pid: 333 }] }, false);
    expect(turns.get("v")).toEqual({ starter: TYPED, peers: [{ pid: 111 }, { pid: 333 }] });
  });
});
