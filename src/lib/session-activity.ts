// Whether a session's background command or chick still counts as running. Both deriveDoneEvent (holding done back) and
// wakeSourceOf (whether anything can wake the session) ask this, so they share one answer
import type { BackgroundTask, ChickView } from "./session-types";

/** A chick with no write for this long and no tool open has stopped (abandoned): it shows dozing (deriveState) */
export const CHICK_ABANDONED_MS = 10 * 60_000;
/** The same for a chick with a tool still open. Above the longest silent tool run seen in local chick transcripts (66.8
    minutes), so a long Bash or browser run isn't cut, while a chick that died in a tool stops holding its parent
    (docs/design/finished-chicks.md "Chicks that have finished") */
export const CHICK_TOOL_ABANDONED_MS = 2 * 60 * 60_000;
// Background tasks older than this with no completion notification are not treated as running.
// An escape hatch for when the notification line is missed (more than 64KB written between 3-second polls,
// timers throttled in a hidden tab, etc.) and suppression would never lift. A done released this way has an
// old at=T, so App.tsx's freshness guard keeps it silent (i.e. this value doesn't cause false fires)
export const BACKGROUND_TASK_STALE_MS = 30 * 60_000;

/** A background command with no completion notification yet, started less than BACKGROUND_TASK_STALE_MS ago */
export function isBackgroundTaskRunning(task: BackgroundTask, now: number): boolean {
  return task.endedAt === undefined && now - task.startedAt < BACKGROUND_TASK_STALE_MS;
}

/** A chick that is running. Abandonment is already in its state (deriveState), so every reader (holding done back, what
    can wake the session, the parent's displayed state, the concierge's chicks_working) gets the same answer */
export function isChickRunning(chick: Pick<ChickView, "state">): boolean {
  return chick.state !== "done" && chick.state !== "dozing";
}
