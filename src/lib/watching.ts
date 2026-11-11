// Watching detection (docs/design.md "Watching"). Keeps a grace period so a bird that handed work to another session and is waiting
// stays watching between the other session's turns. Doesn't depend on UI components or Tauri (can be checked by passing a time)
import type { BirdState } from "./sessions";
import type { LiveSession, PeerLink } from "./session-types";

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

/**
 * Whether the session was started by another session, not by the user (docs/design.md "Watching", "Sessions started
 * by another session"). The Claude desktop app writes the first prompt of a session started by start_session with a
 * turnOrigin other than "human" ("sdk", "host_synthetic"); one the user started is "human". A session started in a
 * terminal writes "human" either way, so it isn't told apart here
 */
export function startedBySession(first: FirstPrompt | undefined): boolean {
  return typeof first?.turnOrigin === "string" && first.turnOrigin !== "human";
}

/**
 * Whether a parent takes this session's results and questions (docs/design.md "Watching"): it was started by another
 * session and is linked to a session that started before it. When a start time is unknown, any link counts
 */
export function parentTakesOver(
  started: boolean,
  ownStartedAt: number | undefined,
  peers: readonly Pick<PeerLink, "startedAt">[],
): boolean {
  if (!started) return false;
  return peers.some((p) => ownStartedAt === undefined || p.startedAt === undefined || p.startedAt < ownStartedAt);
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
