// Watching detection (docs/design.md "Watching"). Keeps a grace period so a bird that handed work to another session and is waiting
// stays watching between the other session's turns. Doesn't depend on UI components or Tauri (can be checked by passing a time)
import type { BirdState } from "./sessions";
import type { ChickView, LiveSession, PeerLink, SessionEvent } from "./session-types";
import type { WatchLinks } from "./session-watch";
import { parentCanAnswer } from "./turn-verdict";
import { writtenByApp } from "./transcript";

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
 * latestTurnTyped: its latest turn after the first prompt was started by a prompt the user typed (rememberLatestTurnTyped),
 * so the user talks to it and no parent takes it over until a later turn is started by its parent or the app
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

/**
 * Records, after one read of a session's transcript, whether its latest turn was started by a prompt the user typed:
 * typedIds holds the sessions (view id) whose latest turn the user started. read is lastTurnTyped of scan_peer_names in
 * src-tauri (the last prompt that started a turn in the part read, null when there was none); a read with no new prompt
 * keeps the previous answer (docs/design.md "Watching", "Sessions started by another session")
 */
export function rememberLatestTurnTyped(typedIds: Set<string>, viewId: string, read: boolean | null | undefined): void {
  if (read === true) typedIds.add(viewId);
  else if (read === false) typedIds.delete(viewId);
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

/** Whether a linked session counts as the parent of a session started at ownStartedAt (parentTakesOver, startersOf) */
export function isParentOf(p: ParentCandidate, ownStartedAt: number | undefined): boolean {
  return startedBefore(p.startedAt, ownStartedAt) && (!p.startedBySession || p.linkedToOlder);
}

/** The session a message from another session came from, as its transcript line names it (PeerRef in src-tauri):
 * `origin.name`, `origin.verifiedPeerPid`, `origin.from` (`uds:/tmp/cc-socks/<pid>.sock` or a desktop app `local_…` id) */
export interface PeerRef {
  name?: string;
  pid?: number;
  from?: string;
}

/** Who started a turn (TurnStarter in src-tauri): a typed prompt, another session's message, or anything else (the
 * desktop app's own turns, whose send_message leaves no sender, task notifications, ...) */
export type TurnStarter = { kind: "typed" } | ({ kind: "peer" } & PeerRef) | { kind: "other" };

/** A session's latest turn after its first prompt: who started it (undefined while only the first prompt has come) and
 * the sessions whose messages arrived while it ran */
export interface LatestTurn {
  starter?: TurnStarter;
  peers: PeerRef[];
}

/**
 * Records, after one read of a session's transcript (scan_peer_names in src-tauri), its latest turn: a read from the
 * top replaces it; a later read with a new turn replaces it, and one without adds the senders that arrived meanwhile
 */
export function rememberLatestTurn(
  turns: Map<string, LatestTurn>,
  viewId: string,
  read: { lastTurnStarter?: TurnStarter | null; turnPeers?: PeerRef[] | null },
  fromTop: boolean,
): void {
  const peers = read.turnPeers ?? [];
  if (read.lastTurnStarter) turns.set(viewId, { starter: read.lastTurnStarter, peers });
  else if (fromTop) {
    if (peers.length > 0) turns.set(viewId, { peers });
    else turns.delete(viewId);
  } else if (peers.length > 0) {
    const turn = turns.get(viewId);
    turns.set(viewId, { starter: turn?.starter, peers: [...(turn?.peers ?? []), ...peers] });
  }
}

/** The pid in a Claude Code messaging socket path, `…/<pid>.sock` */
function pidOfSocket(from: string | undefined): number | undefined {
  const m = from?.match(/\/(\d+)\.sock$/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Whether a message came from the session own: by the sender's pid (`verifiedPeerPid`, else the pid in its socket
 * path) against own's pid in sessions/<pid>.json; without a pid, by its name or desktop app id (peerLookup). "unknown"
 * when neither tells (docs/design.md "Watching")
 */
export function turnStarterSession(
  ref: PeerRef,
  own: { sessionId: string; pid?: number },
  lookup: (trace: string) => LiveSession | undefined,
): "self" | "other" | "unknown" {
  const pid = ref.pid ?? pidOfSocket(ref.from);
  if (pid !== undefined && own.pid !== undefined) return pid === own.pid ? "self" : "other";
  const live = (ref.from !== undefined ? lookup(ref.from) : undefined) ?? (ref.name !== undefined ? lookup(ref.name) : undefined);
  if (!live) return "unknown";
  return live.sessionId === own.sessionId ? "self" : "other";
}

/** Who started a session's latest turn, as seen from own (latestTurnBy in LinkWorld) */
export type TurnBy = "self" | "typed" | "other" | "unknown";

/**
 * Who started peer's latest turn as seen from own: "self" when own's message started it or arrived during it, "typed"
 * for the user's input, "other" for a third session's message, "unknown" when it isn't known who; undefined while peer
 * has only its first prompt
 */
export function latestTurnBy(
  turn: LatestTurn | undefined,
  own: { sessionId: string; pid?: number },
  lookup: (trace: string) => LiveSession | undefined,
): TurnBy | undefined {
  if (!turn) return undefined;
  if (turn.peers.some((p) => turnStarterSession(p, own, lookup) === "self")) return "self";
  const starter = turn.starter;
  if (!starter) return undefined;
  if (starter.kind === "typed") return "typed";
  if (starter.kind === "other") return "unknown";
  return turnStarterSession(starter, own, lookup);
}

/** The linked sessions as takenOverByParent reads them, by sessionId */
export interface LinkWorld {
  startedAt: (sessionId: string) => number | undefined;
  /** Whether it was started by another session (startedBySession); false when it isn't known */
  startedBySession: (sessionId: string) => boolean;
  /** The sessions it is linked to now */
  peers: (sessionId: string) => readonly string[];
  /** Whether it is a child (isChildSession); false when it isn't known */
  isChild: (sessionId: string) => boolean;
  /** Who started peer's latest turn as seen from own (latestTurnBy); undefined when it isn't known */
  latestTurnBy: (peer: string, own: string) => TurnBy | undefined;
}

/**
 * The links of one scan as takenOverByParent reads them (resolveWatchLinks in lib/session-watch.ts). A linked session
 * not on screen (no view id) isn't known to be started by another session, so it counts as a parent
 */
export function takenOverWorld(
  watch: Pick<WatchLinks, "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf" | "childOf"> &
    Partial<Pick<WatchLinks, "latestTurnOf">>,
): LinkWorld {
  const viewIdOf = (sessionId: string) => watch.viewIdBySessionId.get(sessionId);
  const lookup = peerLookup([...watch.liveBySessionId.values()]);
  return {
    latestTurnBy: (peer, own) => {
      const viewId = viewIdOf(peer);
      if (viewId === undefined || !watch.latestTurnOf) return undefined;
      return latestTurnBy(watch.latestTurnOf(viewId), { sessionId: own, pid: watch.liveBySessionId.get(own)?.pid }, lookup);
    },
    startedAt: (sessionId) => watch.liveBySessionId.get(sessionId)?.startedAt,
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

/**
 * The linked sessions it watches (docs/design.md "Watching"). Feeds watchingCount (and so continuing) and the done hold
 * (peerHoldChicks); the links themselves (peers) stay
 */
export function peersWatchedBy<P extends Pick<PeerLink, "sessionId">>(sessionId: string, peers: readonly P[], world: LinkWorld): P[] {
  const starters = startersOf(sessionId, world);
  return peers.filter((p) => {
    // A child doesn't watch the session that started it
    if (starters.has(p.sessionId)) return false;
    // A parent watches its own child whatever started the child's turn (it may be woken by its own child's report)
    if (startersOf(p.sessionId, world).has(sessionId)) return true;
    // Neither started the other: only while the other works on what this one sent, or its starter isn't known
    const by = world.latestTurnBy(p.sessionId, sessionId);
    return by !== "typed" && by !== "other";
  });
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
  const silent = event.type === "done" || (event.type === "waiting" && parentCanAnswer("machine", event.wrapUpAsk));
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
