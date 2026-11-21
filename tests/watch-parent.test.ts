// A child doesn't watch the session that started it (docs/design.md "Watching"): its parent's moves don't make it
// watching or continuing and don't hold its done, also after the user typed in it. The parent watches the child as
// before, and two sessions neither started stay as they were.
// Each scene reads the links as a scan does (takenOverWorld over a stand-in for resolveWatchLinks) and calls the
// functions buildViews in lib/sessions.ts calls: peersWatchedBy, watchingCount, sessionContinuing,
// peerHoldChicks and deriveSessionEvents
import { describe, expect, test } from "bun:test";
import { deriveSessionEvents } from "../src/lib/session-events.ts";
import type { LiveSession, PeerLink } from "../src/lib/session-types.ts";
import type { WatchLinks } from "../src/lib/session-watch.ts";
import type { TailEvent } from "../src/lib/transcript.ts";
import { sessionContinuing } from "../src/lib/turn-verdict.ts";
import {
  isChildSession,
  peerHoldChicks,
  startedBySession,
  startersOf,
  takenOverByParent,
  takenOverWorld,
  peersWatchedBy,
  watchingCount,
  type FirstPrompt,
} from "../src/lib/watching.ts";

const AT = "2026-01-01T00:00:00.000Z";
const DESKTOP_CHILD: FirstPrompt = { turnOrigin: "sdk", namedAtLaunch: false, at: AT };
const DESKTOP_USER: FirstPrompt = { turnOrigin: "human", namedAtLaunch: false, at: AT };

const NOW = 10_000_000;

interface Session {
  startedAt: number;
  first: FirstPrompt;
  typed?: boolean;
  active?: boolean;
}
type Scene = { sessions: Record<string, Session>; links: [string, string][] };

const viewId = (id: string) => `root/${id}.jsonl`;

function watchOf(
  scene: Scene,
): Pick<WatchLinks, "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf" | "childOf" | "latestTurnOf"> {
  const entries = Object.entries(scene.sessions);
  const byView = (v: string) => entries.find(([id]) => viewId(id) === v)?.[1];
  return {
    liveBySessionId: new Map(entries.map(([id, s], i) => [id, { pid: i + 1, sessionId: id, startedAt: s.startedAt } as LiveSession])),
    viewIdBySessionId: new Map(entries.map(([id]) => [id, viewId(id)])),
    peerLinksOf: (id) => peersOf(scene, id),
    startedBySessionOf: (v) => {
      const s = byView(v);
      return s !== undefined && startedBySession(s.first, s.typed ?? false);
    },
    childOf: (v) => {
      const s = byView(v);
      return s !== undefined && isChildSession(s.first);
    },
    latestTurnOf: (v) => (byView(v)?.typed ? { starter: { kind: "typed" }, peers: [] } : undefined),
  };
}

function peersOf(scene: Scene, id: string): PeerLink[] {
  return scene.links
    .flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []))
    .map((p) => {
      const active = scene.sessions[p].active ?? false;
      return { sessionId: p, name: p, startedAt: scene.sessions[p].startedAt, active, lastActiveAt: active ? NOW : undefined };
    });
}

/** What buildViews makes of a done / dozing session: its watching and its continuing for a reply verdict */
function watchOfSession(scene: Scene, id: string, verdict: boolean | undefined) {
  const world = takenOverWorld(watchOf(scene));
  const watched = peersWatchedBy(id, peersOf(scene, id), world);
  const watching = watchingCount("done", watched, NOW, NOW - 1_000);
  return { watching, continuing: sessionContinuing(verdict, watching, 1_000).continuing, takenOver: takenOverByParent(id, world) };
}

const P = { startedAt: 100, first: DESKTOP_USER };
const C = { startedAt: 200, first: DESKTOP_CHILD };

describe("a child and the session that started it", () => {
  test("the parent moves (runs other children): the child isn't watching, and continuing is its reply's", () => {
    const scene = { sessions: { P: { ...P, active: true }, C }, links: [["P", "C"]] as [string, string][] };
    expect(watchOfSession(scene, "C", false)).toEqual({ watching: undefined, continuing: false, takenOver: true });
  });

  test("the user typed in the child: still not watching its moving parent (no longer taken over)", () => {
    const scene = { sessions: { P: { ...P, active: true }, C: { ...C, typed: true } }, links: [["P", "C"]] as [string, string][] };
    expect(watchOfSession(scene, "C", undefined)).toEqual({ watching: undefined, continuing: undefined, takenOver: false });
  });

  test("the child moves: the parent watches it as before", () => {
    const scene = { sessions: { P, C: { ...C, active: true } }, links: [["P", "C"]] as [string, string][] };
    expect(watchOfSession(scene, "P", false)).toEqual({ watching: 1, continuing: true, takenOver: false });
  });

  test("a grandchild moves: the child watches it, not its own parent", () => {
    const G = { startedAt: 300, first: DESKTOP_CHILD, active: true };
    const scene = { sessions: { P: { ...P, active: true }, C, G }, links: [["P", "C"], ["C", "G"]] as [string, string][] };
    const world = takenOverWorld(watchOf(scene));
    expect([...startersOf("C", world)]).toEqual(["P"]);
    expect([...startersOf("G", world)]).toEqual(["C"]);
    expect(watchOfSession(scene, "C", false).watching).toBe(1);
  });

  test("two sessions neither started: each watches the other as before", () => {
    const A = { startedAt: 100, first: DESKTOP_USER, active: true };
    const B = { startedAt: 200, first: DESKTOP_USER };
    const scene = { sessions: { A, B }, links: [["A", "B"]] as [string, string][] };
    expect(watchOfSession(scene, "B", false).watching).toBe(1);
    expect(startersOf("B", takenOverWorld(watchOf(scene))).size).toBe(0);
  });
});

describe("the done hold and the session that started it", () => {
  const t = (kind: TailEvent["kind"], at: number, patch: Partial<TailEvent> = {}): TailEvent => ({ kind, at, ...patch });
  const events = [t("user", NOW - 3_000, { text: "直して" }), t("assistant_text", NOW - 2_000, { text: "済みました" })];
  const tail = {
    kind: "assistant_text" as const,
    events,
    chickSignals: new Map(),
    backgroundTaskStarts: new Map(),
    peerNames: new Map(),
  };
  const doneOf = (scene: Scene, id: string) => {
    const world = takenOverWorld(watchOf(scene));
    const chicks = peerHoldChicks(peersWatchedBy(id, peersOf(scene, id), world), () => undefined, NOW);
    return deriveSessionEvents(tail, viewId(id), id, chicks, new Map(), undefined, NOW).some((e) => e.type === "done");
  };

  test("the parent moves: the child's done isn't held", () => {
    expect(doneOf({ sessions: { P: { ...P, active: true }, C }, links: [["P", "C"]] }, "C")).toBe(true);
  });

  test("the parent moves and the user typed in the child: the child's done isn't held", () => {
    expect(doneOf({ sessions: { P: { ...P, active: true }, C: { ...C, typed: true } }, links: [["P", "C"]] }, "C")).toBe(true);
  });

  test("the child moves: the parent's done is held as before", () => {
    expect(doneOf({ sessions: { P, C: { ...C, active: true } }, links: [["P", "C"]] }, "P")).toBe(false);
  });

  test("two sessions neither started: a moving one holds the other's done as before", () => {
    const A = { startedAt: 100, first: DESKTOP_USER, active: true };
    const B = { startedAt: 200, first: DESKTOP_USER };
    expect(doneOf({ sessions: { A, B }, links: [["A", "B"]] }, "B")).toBe(false);
  });
});
