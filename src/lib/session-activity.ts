// Whether a session's background command or chick still counts as running. Both deriveDoneEvent (holding done back) and
// wakeSourceOf (whether anything can wake the session) ask this, so they share one answer
import type { BackgroundTask, ChickView } from "./session-types";

/** A chick stuck in working with no writes for longer than this is treated as abandoned (not running) */
export const CHICK_ABANDONED_MS = 10 * 60_000;
// Background tasks older than this with no completion notification are not treated as running.
// An escape hatch for when the notification line is missed (more than 64KB written between 3-second polls,
// timers throttled in a hidden tab, etc.) and suppression would never lift. A done released this way has an
// old at=T, so App.tsx's freshness guard keeps it silent (i.e. this value doesn't cause false fires)
export const BACKGROUND_TASK_STALE_MS = 30 * 60_000;

/** A background command with no completion notification yet, started less than BACKGROUND_TASK_STALE_MS ago */
export function isBackgroundTaskRunning(task: BackgroundTask, now: number): boolean {
  return task.endedAt === undefined && now - task.startedAt < BACKGROUND_TASK_STALE_MS;
}

/** A chick neither done nor dozing, written to within CHICK_ABANDONED_MS */
export function isChickRunning(chick: Pick<ChickView, "state" | "sinceMs">): boolean {
  return chick.state !== "done" && chick.state !== "dozing" && chick.sinceMs < CHICK_ABANDONED_MS;
}
