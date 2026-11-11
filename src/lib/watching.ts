// Watching detection (docs/design.md "Watching"). Keeps a grace period so a bird that handed work to another session and is waiting
// stays watching between the other session's turns. Doesn't depend on UI components or Tauri (can be checked by passing a time)
import type { BirdState } from "./sessions";
import type { LiveSession, SessionEvent } from "./session-types";
import type { WatchLinks } from "./session-watch";

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
 * of now. 0 means "within the grace period, with no linked session moving now"
 */
export function watchingCount(
  ownState: BirdState,
  peers: { active: boolean; lastActiveAt?: number }[],
  now: number,
): number | undefined {
  if (ownState !== "done" && ownState !== "dozing") return undefined;
  const moving = peers.filter((p) => p.active).length;
  if (moving > 0) return moving;
  const recent = peers.some((p) => p.lastActiveAt !== undefined && now - p.lastActiveAt <= WATCH_GRACE_MS);
  return recent ? 0 : undefined;
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
 * typedAfterFirst: the user typed a prompt in it after the first one (scan_peer_names in src-tauri), so the user talks
 * to it and no parent takes it over any more
 */
export function startedBySession(first: FirstPrompt | undefined, typedAfterFirst = false): boolean {
  if (!first || typedAfterFirst) return false;
  if (typeof first.turnOrigin === "string" && first.turnOrigin !== "human") return true;
  if (!first.namedAtLaunch || !first.sessionStartAt) return false;
  const gap = Date.parse(first.at) - Date.parse(first.sessionStartAt);
  return Number.isFinite(gap) && gap >= 0 && gap <= PROMPT_AT_LAUNCH_MS;
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
  return peers.some((p) => startedBefore(p.startedAt, ownStartedAt) && (!p.startedBySession || p.linkedToOlder));
}

/** The linked sessions as takenOverByParent reads them, by sessionId */
export interface LinkWorld {
  startedAt: (sessionId: string) => number | undefined;
  /** Whether it was started by another session (startedBySession); false when it isn't known */
  startedBySession: (sessionId: string) => boolean;
  /** The sessions it is linked to now */
  peers: (sessionId: string) => readonly string[];
}

/**
 * The links of one scan as takenOverByParent reads them (resolveWatchLinks in lib/session-watch.ts). A linked session
 * not on screen (no view id) isn't known to be started by another session, so it counts as a parent
 */
export function takenOverWorld(
  watch: Pick<WatchLinks, "liveBySessionId" | "viewIdBySessionId" | "peerLinksOf" | "startedBySessionOf">,
): LinkWorld {
  return {
    startedAt: (sessionId) => watch.liveBySessionId.get(sessionId)?.startedAt,
    startedBySession: (sessionId) => {
      const viewId = watch.viewIdBySessionId.get(sessionId);
      return viewId !== undefined && watch.startedBySessionOf(viewId);
    },
    peers: (sessionId) => watch.peerLinksOf(sessionId).map((p) => p.sessionId),
  };
}

/** parentTakesOver for one session, with each linked session's own facts read from the links */
export function takenOverByParent(sessionId: string, world: LinkWorld): boolean {
  return parentTakesOver(
    world.startedBySession(sessionId),
    world.startedAt(sessionId),
    world.peers(sessionId).map((p) => ({
      startedAt: world.startedAt(p),
      startedBySession: world.startedBySession(p),
      linkedToOlder: world.peers(p).some((q) => q !== sessionId && startedBefore(world.startedAt(q), world.startedAt(p))),
    })),
  );
}

/**
 * A session event as it is kept: the done and needs reply (waiting) of a session whose parent takes it over are silent,
 * so they chirp and stay in the log and feed but aren't read aloud (docs/design.md "Watching")
 */
export function silentForParent<E extends Pick<SessionEvent, "type" | "silent">>(event: E, takenOver: boolean): E {
  return takenOver && (event.type === "done" || event.type === "waiting") ? { ...event, silent: true } : event;
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
