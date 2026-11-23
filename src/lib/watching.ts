// Watching detection (docs/design.md "Watching"). Keeps a grace period so a bird that handed work to another session and is waiting
// stays watching between the other session's turns. Doesn't depend on UI components or Tauri (can be checked by passing a time)
import type { BirdState } from "./sessions";
import type { ChickView, LiveSession, PeerLink, SessionEvent } from "./session-types";
import type { WatchLinks } from "./session-watch";
import { parentCanAnswer } from "./turn-verdict";
import { writtenByApp } from "./transcript";
import { latestTurnBy, type TurnBy } from "./watching-turns";

/** For this long after the linked session last moved, it stays watching */
export const WATCH_GRACE_MS = 5 * 60_000;

/**
 * Whether the linked session is moving. status in sessions/<pid>.json is anything but idle (busy, shell, etc.), or the linked session's
 * machine state is working / waiting. status "shell" and the like also count as moving
 */
export function isPeerActive(status: string | undefined, lastState: BirdState | undefined): boolean {
  return (status !== undefined && status !== "idle") || lastState === "working" || lastState === "waiting";
}

/**
 * If watching, the number of linked sessions moving now (0 or more). undefined if not watching.
 * Watching when its own machine state is done / dozing and some linked session is moving now, or one moved within WATCH_GRACE_MS
 * of now. 0 means "within the grace period, with no linked session moving now".
 * ownTurnEndedAt: when its own turn ended (its last transcript line). With no linked session moving now, the grace period ends
 * early when it is after every linked session's last transcript write (lastWriteAt): the session took the other session's
 * result and finished its turn. Not compared with lastActiveAt, which is the poll time while the linked session counts as
 * working and so lags its last write by seconds. A linked session whose last write isn't known keeps the grace period
 * (docs/design.md "Watching")
 */
export function watchingCount(
  ownState: BirdState,
  peers: { active: boolean; lastActiveAt?: number; lastWriteAt?: number }[],
  now: number,
  ownTurnEndedAt?: number,
): number | undefined {
  if (ownState !== "done" && ownState !== "dozing") return undefined;
  const moving = peers.filter((p) => p.active).length;
  if (moving > 0) return moving;
  const lastMoved = Math.max(...peers.map((p) => p.lastActiveAt ?? -Infinity));
  if (!(now - lastMoved <= WATCH_GRACE_MS)) return undefined;
  if (ownTurnEndedAt !== undefined && peers.every((p) => p.lastWriteAt !== undefined && ownTurnEndedAt > p.lastWriteAt)) {
    return undefined;
  }
  return 0;
}

/** The transcript's first prompt as scan_peer_names (src-tauri) reads it */
export interface FirstPrompt {
  /** turnOrigin of the first prompt ("human", "sdk", "host_synthetic", ...), when written */
  turnOrigin?: string | null;
  /** An agent-name line came before it (the session was given a name when it was launched) */
  namedAtLaunch: boolean;
  /** Timestamp of the SessionStart hook's line before it, when there is one */
  sessionStartAt?: string | null;
  /** Timestamp of the first prompt */
  at: string;
}

/** A first prompt at most this long after the SessionStart hook's line was given at launch (`claude "<prompt>"`), not
 * typed: in the transcripts on this machine, prompts given at launch came within 0.1 seconds, typed ones mostly after
 * several (docs/design.md "Watching", "Sessions started by another session") */
export const PROMPT_AT_LAUNCH_MS = 2_000;

/**
 * Whether the session was started by another session, not by the user, and the user hasn't talked to it since
 * (docs/design.md "Watching", "Sessions started by another session").
 * - The Claude desktop app writes the first prompt of a session started by start_session with a turnOrigin other than
 *   "human" ("sdk", "host_synthetic"); one the user started is "human"
 * - A session started in a terminal writes "human" either way. It counts as started by another session when it was
 *   given a name and a prompt at launch (`claude --name <name> "<prompt>"`): an agent-name line before the first prompt,
 *   and the first prompt within PROMPT_AT_LAUNCH_MS of the SessionStart hook's line
 * latestTurnTyped: its latest turn after the first prompt was started by a prompt the user typed (the starter of its
 * LatestTurn), so the user talks to it and no parent takes it over until a later turn is started by its parent or the app
 */
export function startedBySession(first: FirstPrompt | undefined, latestTurnTyped = false): boolean {
  if (!first || latestTurnTyped) return false;
  if (writtenByApp(first.turnOrigin)) return true;
  if (!first.namedAtLaunch || !first.sessionStartAt) return false;
  const gap = Date.parse(first.at) - Date.parse(first.sessionStartAt);
  return Number.isFinite(gap) && gap >= 0 && gap <= PROMPT_AT_LAUNCH_MS;
}

/**
 * Whether the session is a child, for the ◎ on its state line in the Concierge tab (docs/design.md "Concierge", a child's
 * dot): started by another session, read from its own first prompt only (startedBySession without the typed flag). So it
 * stays a child after the user types in it and after its parent closes, unlike parentTakesOver
 */
export function isChildSession(first: FirstPrompt | undefined): boolean {
  return startedBySession(first, false);
}

/** A linked session as parentTakesOver sees it */
export interface ParentCandidate {
  startedAt?: number;
  /** It was started by another session itself (startedBySession) */
  startedBySession: boolean;
  /** It is linked now to a session that started before it */
  linkedToOlder: boolean;
}

/** Whether a started before b. When a start time is unknown, it counts (any link counts, as before) */
export function startedBefore(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || a < b;
}

/**
 * Whether a parent takes this session's results and questions (docs/design.md "Watching", "Sessions started by another
 * session"): it was started by another session and is linked to a parent. A parent is a linked session that started
 * before it and either was not started by another session, or was and is linked now to one older than itself. So the
 * successor of a rebirth (started later, with a name and a prompt) isn't the child of the child its predecessor
 * started: that child has lost its own parent. Known error: a grandchild whose grandparent closed or was reborn is read
 * aloud, since its parent lost its own
 */
export function parentTakesOver(
  started: boolean,
  ownStartedAt: number | undefined,
  peers: readonly ParentCandidate[],
): boolean {
  if (!started) return false;
  return peers.some((p) => isParentOf(p, ownStartedAt));
}

export function isParentOf(p: ParentCandidate, ownStartedAt: number | undefined): boolean {
  return startedBefore(p.startedAt, ownStartedAt) && (!p.startedBySession || p.linkedToOlder);
}

/** The linked sessions as takenOverByParent reads them, by sessionId */
export interface LinkWorld {
  startedAt: (sessionId: string) => number | undefined;
  /** Whether it was started by another session (startedBySession); false when it isn't known */
  startedBySession: (sessionId: string) => boolean;
  /** The sessions it is linked to now */
  peers: (sessionId: string) => readonly string[];
  /** False when it isn't known */
  isChild: (sessionId: string) => boolean;
  latestTurnBy: (peer: string, own: string) => TurnBy | undefined;
  /** The running session a trace (a name or a desktop app id, as a message names it) names; undefined when none does */
  sessionOf: (trace: string) => string | undefined;
}

/**
 * The links of one scan as takenOverByParent reads them (resolveWatchLinks in lib/session-watch.ts). A linked session
 * not on screen (no view id) isn't known to be started by another session, so it counts as a parent
 */
export function takenOverWorld(
  watch: Pick<WatchLinks, "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf" | "childOf" | "latestTurnOf">,
): LinkWorld {
  const viewIdOf = (sessionId: string) => watch.viewIdBySessionId.get(sessionId);
  const lookup = peerLookup([...watch.liveBySessionId.values()]);
  return {
    latestTurnBy: (peer, own) => {
      const viewId = viewIdOf(peer);
      if (viewId === undefined) return undefined;
      return latestTurnBy(watch.latestTurnOf(viewId), { sessionId: own, pid: watch.liveBySessionId.get(own)?.pid }, lookup);
    },
    startedAt: (sessionId) => watch.liveBySessionId.get(sessionId)?.startedAt,
    sessionOf: (trace) => lookup(trace)?.sessionId,
    startedBySession: (sessionId) => {
      const viewId = watch.viewIdBySessionId.get(sessionId);
      return viewId !== undefined && watch.startedBySessionOf(viewId);
    },
    peers: (sessionId) => watch.peerLinksOf(sessionId).map((p) => p.sessionId),
    isChild: (sessionId) => {
      const viewId = viewIdOf(sessionId);
      return viewId !== undefined && watch.childOf(viewId);
    },
  };
}

/** parentTakesOver for one session, with each linked session's own facts read from the links */
export function takenOverByParent(sessionId: string, world: LinkWorld): boolean {
  return parentTakesOver(
    world.startedBySession(sessionId),
    world.startedAt(sessionId),
    world.peers(sessionId).map((p) => candidateOf(p, sessionId, world)),
  );
}

/**
 * Whether a message the session's latest turn sent (TailInfo.lastTurnSentTo) went to a linked session that counts as
 * its parent (isParentOf): then the question its reply asks reached the parent, which takes it over (parentCanAnswer
 * in lib/turn-verdict.ts; docs/design.md "Sessions started by another session"). A message to another session (its own
 * child, a sibling) doesn't count
 */
export function askSentToParent(sessionId: string, sentTo: readonly string[] | undefined, world: LinkWorld): boolean {
  if (!sentTo || sentTo.length === 0) return false;
  const peers = world.peers(sessionId);
  const own = world.startedAt(sessionId);
  return sentTo.some((trace) => {
    const peer = world.sessionOf(trace);
    return (
      peer !== undefined &&
      peer !== sessionId &&
      peers.includes(peer) &&
      isParentOf(candidateOf(peer, sessionId, world), own)
    );
  });
}

function candidateOf(peer: string, sessionId: string, world: LinkWorld): ParentCandidate {
  return {
    startedAt: world.startedAt(peer),
    startedBySession: world.startedBySession(peer),
    linkedToOlder: world.peers(peer).some((q) => q !== sessionId && startedBefore(world.startedAt(q), world.startedAt(peer))),
  };
}

/**
 * The linked sessions that started this one, which it doesn't watch (docs/design.md "Watching"): for a child
 * (isChildSession, so also after the user typed in it, unlike takenOverByParent), the linked sessions that count as its
 * parent (isParentOf). Empty for a session no other session started
 */
export function startersOf(sessionId: string, world: LinkWorld): Set<string> {
  if (!world.isChild(sessionId)) return new Set();
  const own = world.startedAt(sessionId);
  return new Set(world.peers(sessionId).filter((p) => isParentOf(candidateOf(p, sessionId, world), own)));
}

export type LinkRelation = "starter" | "child" | "unrelated";

export type WatchTurnBy = TurnBy | "firstOnly";

/**
 * Whether a session watches a linked session, by how the linked one stands to it and who started the linked one's
 * latest turn (docs/design.md "Watching"). A parent watches its own child whatever started the child's turn (it may be
 * woken by its own child's report). Between unrelated sessions, "unknown" and "firstOnly" are on the safe side
 */
export const WATCHES: Readonly<Record<LinkRelation, Readonly<Record<WatchTurnBy, boolean>>>> = {
  starter: { self: false, typed: false, other: false, unknown: false, firstOnly: false },
  child: { self: true, typed: true, other: true, unknown: true, firstOnly: true },
  unrelated: { self: true, typed: false, other: false, unknown: true, firstOnly: true },
};

/**
 * The linked sessions it watches (docs/design.md "Watching"), by WATCHES. Feeds watchingCount (and so continuing) and
 * the done hold (peerHoldChicks); the links themselves (peers) stay
 */
export function peersWatchedBy<P extends Pick<PeerLink, "sessionId">>(sessionId: string, peers: readonly P[], world: LinkWorld): P[] {
  const starters = startersOf(sessionId, world);
  const relationOf = (peer: string): LinkRelation =>
    starters.has(peer) ? "starter" : startersOf(peer, world).has(sessionId) ? "child" : "unrelated";
  return peers.filter((p) => WATCHES[relationOf(p.sessionId)][world.latestTurnBy(p.sessionId, sessionId) ?? "firstOnly"]);
}

/**
 * The watched linked sessions as chicks for the done hold (deriveDoneEvent in lib/session-events.ts): a moving one as a
 * running chick, a stopped one with its last write as of the previous scan (lastStateOf), one not seen yet left out
 */
export function peerHoldChicks(
  peers: readonly Pick<PeerLink, "sessionId" | "name" | "active">[],
  lastStateOf: (sessionId: string) => { state: BirdState; lastWriteAt: number } | undefined,
  now: number,
): ChickView[] {
  return peers.flatMap((p) => {
    const lastState = lastStateOf(p.sessionId);
    if (p.active) return [{ id: `peer:${p.sessionId}`, name: p.name, state: "working" as const, sinceMs: 0 }];
    if (!lastState) return [];
    return [{ id: `peer:${p.sessionId}`, name: p.name, state: lastState.state, sinceMs: now - lastState.lastWriteAt }];
  });
}

/**
 * A session event as it is kept: for a session whose parent takes it over, its done (including one whose reply asks
 * its parent) and a needs reply its parent can answer (a wrap_up's ask; parentCanAnswer in lib/turn-verdict.ts) are
 * silent, so they chirp and stay in the log and feed but aren't read aloud. A needs reply on a question tool is read
 * aloud, since only the user can answer it. A permission prompt makes no event (deriveSessionEvents makes a needs reply
 * only from a tool call in the transcript), so nothing is read for it; the concierge still counts it (docs/design.md
 * "Watching")
 */
export function silentForParent<E extends Pick<SessionEvent, "type" | "silent" | "wrapUpAsk">>(event: E, takenOver: boolean): E {
  const silent = event.type === "done" || (event.type === "waiting" && parentCanAnswer("machine", event.wrapUpAsk, undefined));
  return takenOver && silent ? { ...event, silent: true } : event;
}

/**
 * Looks up the running session a peer trace names (docs/design.md "Watching", "How links are found"). A trace is a
 * name (matched against `name` in sessions/<pid>.json) or a Claude desktop app id `local_…` (matched against
 * `hostSessionId`). Returns a lookup over the given running sessions
 */
export function peerLookup(liveSessions: readonly LiveSession[]): (trace: string) => LiveSession | undefined {
  const byName = new Map<string, LiveSession>();
  const byHostId = new Map<string, LiveSession>();
  for (const live of liveSessions) {
    if (live.name) byName.set(live.name, live);
    if (live.hostSessionId) byHostId.set(live.hostSessionId, live);
  }
  return (trace) => byHostId.get(trace) ?? byName.get(trace);
}
