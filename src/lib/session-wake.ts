// Whether anything can start a Claude Code session's next turn without the user (docs/design.md "Turn verdicts"). After
// a turn ends, a session goes on only when something wakes it: a background command's or a chick's notification, a
// message from another session, or a wakeup it scheduled. continuing from the reply's text holds only while one of
// these is there
import type { TailInfo } from "./transcript";
import type { BackgroundTask, ChickView, Wake } from "./session-types";
import { unwakeableCache, wakeCache } from "./session-store";
import { isBackgroundTaskRunning, isChickRunning } from "./session-activity";

/**
 * How long after its start a session another session started from a terminal, still linked to no one, counts as one that
 * may report to a parent: such a child is linked only from its first message, so until then the app can't tell whose it
 * is (docs/design.md "Watching"). The same 30 minutes as TEXT_CONTINUING_EXPIRES_MS (Claude's own decision)
 */
export const FRESH_UNLINKED_CHILD_MS = 30 * 60_000;

/** Adds the wakes seen in the tail to wakeCache and returns that session's ledger */
export function updateWakes(sessionId: string, tail: TailInfo): Map<string, Wake> {
  let wakes = wakeCache.get(sessionId);
  if (!wakes) {
    wakes = new Map();
    wakeCache.set(sessionId, wakes);
  }
  for (const [key, start] of tail.wakes?.starts ?? []) {
    const known = wakes.get(key);
    // A later ScheduleWakeup replaces the pending one (the same key), and its end starts over
    if (!known || start.at > known.at) wakes.set(key, { ...start });
  }
  for (const [key, endedAt] of tail.wakes?.ends ?? []) {
    const known = wakes.get(key);
    if (known && endedAt >= known.at) known.endedAt = endedAt;
  }
  return wakes;
}

/** Whether a wake in the ledger can still fire: not cancelled, and its time hasn't passed */
export function pendingWakeOf(wakes: ReadonlyMap<string, Wake>, now: number): boolean {
  for (const w of wakes.values()) {
    if (w.endedAt !== undefined) continue;
    if (w.until === undefined || now < w.until) return true;
  }
  return false;
}

/** A session another session started, as freshUnlinkedChild sees it */
export interface ChildCandidate {
  rootId: string;
  sessionId: string;
  startedBySession: boolean;
  linked: boolean;
  startedAt?: number;
}

/**
 * The config roots where a session another session started is still linked to no one and started within
 * FRESH_UNLINKED_CHILD_MS: a parent there may be waiting on it although the app sees no link yet. Messages go only between
 * sessions of the same config dir, so it holds for that root only
 */
export function rootsWithFreshUnlinkedChild(candidates: ChildCandidate[], now: number): Set<string> {
  const roots = new Set<string>();
  for (const c of candidates) {
    if (!c.startedBySession || c.linked || c.startedAt === undefined) continue;
    if (now - c.startedAt <= FRESH_UNLINKED_CHILD_MS) roots.add(c.rootId);
  }
  return roots;
}

/**
 * Whether anything the app sees can start the session's next turn without the user: a running background command, a
 * running chick (not abandoned), a pending wakeup / cron / monitor, or, in its config root, a child started by another session that is
 * linked to no one yet. Watching is handled by sessionContinuing itself
 */
export function wakeSourceOf(input: {
  backgroundTasks: ReadonlyMap<string, BackgroundTask>;
  wakes: ReadonlyMap<string, Wake>;
  chicks: Pick<ChickView, "state" | "sinceMs">[];
  freshUnlinkedChild: boolean;
  now: number;
}): boolean {
  const { backgroundTasks, wakes, chicks, freshUnlinkedChild, now } = input;
  return (
    [...backgroundTasks.values()].some((t) => isBackgroundTaskRunning(t, now)) ||
    chicks.some(isChickRunning) ||
    pendingWakeOf(wakes, now) ||
    freshUnlinkedChild
  );
}

/**
 * How long nothing has been able to wake the session (SessionView.unwakeableForMs), remembered per write in
 * unwakeableCache: from its last write when nothing could wake it at the first scan after that write, otherwise from the
 * scan that first found nothing left. undefined while something can wake it
 */
export function unwakeableForMsOf(viewId: string, wakeable: boolean, writtenAt: number, now: number): number | undefined {
  const known = unwakeableCache.get(viewId);
  const sameWrite = known?.writtenAt === writtenAt;
  if (wakeable) {
    unwakeableCache.set(viewId, { writtenAt });
    return undefined;
  }
  const lostAt = sameWrite ? (known?.lostAt ?? now) : writtenAt;
  unwakeableCache.set(viewId, { writtenAt, lostAt });
  return Math.max(0, now - lostAt);
}
