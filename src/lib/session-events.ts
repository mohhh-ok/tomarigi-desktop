// Transition events (started / waiting / done / closed) derived from a session's tail
import type { TailInfo } from "./transcript";
import type { BackgroundTask, ChickView, SessionEvent } from "./session-types";
import { backgroundTaskCache } from "./session-store";
import { isWaitingTool } from "./bird-state";
import { formatSnippet } from "./session-snippet";

const CHICK_ABANDONED_MS = 10 * 60_000; // a chick stuck in working with no writes for longer than this is treated as abandoned and not used to suppress done (threshold for abandoned chicks)
// Grace period, after a done suppressed while waiting on chicks is released, to wait for the parent to
// restart (cancel). The harness auto-restart after a background chick finishes was measured at about 3
// seconds after completion, so 30 seconds covers the normal case. If a known harness notification-delay bug
// delays the restart past 30 seconds, the timeout fires first and may chirp twice together with the done of
// the later restarted turn, but we accept that as a better degradation than staying silent (a recurrence of
// the actual problem)
const DONE_GRACE_MS = 30_000;
// Background tasks older than this with no completion notification are not used to suppress done.
// An escape hatch for when the notification line is missed (more than 64KB written between 3-second polls,
// timers throttled in a hidden tab, etc.) and suppression would never lift. A done released this way has an
// old at=T, so App.tsx's freshness guard keeps it silent (i.e. this value doesn't cause false fires)
const BACKGROUND_TASK_STALE_MS = 30 * 60_000;

/**
 * Derives a session's transition events (started, waiting for reply, done, closed) from the tail's event list.
 * To avoid false detection of progress text in the middle of a turn, done counts only when the next classified
 * event is not tool_use/tool_result. In addition, if a chick (subagent) is still running it is too early as a
 * "come back" signal, so it is suppressed (deriveDoneEvent).
 * waiting treats a call to AskUserQuestion/ExitPlanMode as a definite wait for the user's answer, and ones
 * already answered are also emitted as history as-is (no timeout estimation).
 */
export function deriveSessionEvents(
  tail: TailInfo,
  sessionId: string,
  project: string,
  chicks: ChickView[],
  backgroundTasks: Map<string, BackgroundTask>,
  snippet: string | undefined,
  now: number,
): SessionEvent[] {
  const result: SessionEvent[] = [];
  const events = tail.events;
  // Walk the event list tracking "the previous user message", and attach each event's own turn prompt.
  // Attaching the session's latest message (snippet) to everything would pin unrelated messages to past
  // events via the first-write-wins cache.
  // snippet is only used as a substitute when there is no message in the window
  let lastPrompt: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.kind === "user") {
      // A started event carries "the prompt itself". What was asked is the main info of this event, so it
      // isn't omitted even for short instructions or a single session
      const prompt = event.text ? formatSnippet(event.text) : undefined;
      if (prompt) lastPrompt = prompt;
      result.push(mkSessionEvent(sessionId, project, "started", event.at, prompt ?? snippet));
    } else if (event.kind === "closed") {
      result.push(mkSessionEvent(sessionId, project, "closed", event.at, lastPrompt ?? snippet));
    } else if (event.kind === "assistant_text") {
      const next = events[i + 1];
      if (!next || (next.kind !== "tool_use" && next.kind !== "tool_result")) {
        // The existence of next (= some event after T) is a definitive signal that the parent has already
        // restarted/continued (used for the cancel check in deriveDoneEvent)
        const parentAdvanced = next !== undefined;
        const done = deriveDoneEvent(
          sessionId,
          project,
          event.at,
          chicks,
          backgroundTasks,
          lastPrompt ?? snippet,
          now,
          parentAdvanced,
          event.text,
        );
        if (done) result.push(done);
      }
    } else if (event.kind === "tool_use" && isWaitingTool(event.toolName)) {
      result.push(mkSessionEvent(sessionId, project, "waiting", event.at, lastPrompt ?? snippet));
    }
  }
  return result;
}

/** Adds the starts and completions seen in the parent tail to backgroundTaskCache and returns that session's ledger */
export function updateBackgroundTasks(sessionId: string, tail: TailInfo): Map<string, BackgroundTask> {
  let tasks = backgroundTaskCache.get(sessionId);
  if (!tasks) {
    tasks = new Map();
    backgroundTaskCache.set(sessionId, tasks);
  }
  for (const [taskId, startedAt] of tail.backgroundTaskStarts) {
    if (!tasks.has(taskId)) tasks.set(taskId, { startedAt });
  }
  for (const [taskId, task] of tasks) {
    const endedAt = tail.chickSignals.get(taskId);
    if (endedAt !== undefined && endedAt >= task.startedAt) task.endedAt = endedAt;
  }
  return tasks;
}

/**
 * Even if the main session stops at T, if even one chick (subagent) was alive past T, that T's done is
 * suppressed for now (the suppression lifts on the scan where all are done/dozing or treated as abandoned).
 * Whether a chick is really running or stopped can't be decided from its ordering relative to T alone
 * (chicks commonly go tens of seconds without writing, e.g. while running Bash, so a running chick that just
 * happens to have no write at the moment of T would be misjudged as "stopped"). Instead, decide by the
 * freshness of the time since its last write (sinceMs) itself: if sinceMs is under CHICK_ABANDONED_MS it is
 * still alive (suppressed even when stuck in working); otherwise it is treated as abandoned and ignored.
 * T is an immutable past event in the tail, so while suppressed this function keeps being re-evaluated every
 * scan, and the suppression lifts naturally once the chicks are all finished.
 *
 * The check order always does "suppression by running chicks" first. A running chick is alive at the current
 * scan (now > T), so "alive past T" is certain without even looking at its write time, and whether to suppress
 * is decided here first. Without this order, on the first scan right after the parent's turn end T, there is a
 * moment where even a running chick's last write is still before T, and just at that moment
 * wasAnyChickAliveAfterT becomes false and it wrongly falls through to the normal immediate-fire path
 * (actual problem: with T=16:58:17 and the previous write at 16:58:1x, done was not suppressed, fired
 * immediately, and chirped).
 * Only after leaving the loop with no running chick confirmed do we check whether all chicks had finished at
 * time T (no chicks, or every chick's last write before T). A stopped chick's last write time no longer moves,
 * so the comparison at this point is reliable.
 * The finished case is the normal immediate-fire path that needs no suppression at all, and is outside the
 * cancel/grace/timeout below (behavior unchanged from the old implementation). Only the case "some chick was
 * alive past T" goes through suppression → release → cancel/grace/timeout.
 *
 * Firing after release is a deterministic timeout+cancel rather than relying on freshness (the old
 * implementation kept at=T fixed and relied on App.tsx's freshness guard (EVENT_FRESHNESS_MS=30 seconds), so
 * whether the release fell within freshness was effectively luck. Actual problem: the chick finished 17 seconds
 * after the parent's turn end → the release fired within the 30-second freshness and chirped, then 3 seconds
 * later the harness auto-restarted the parent and it continued → the final turn's done chirped again, a double
 * chirp).
 * - **Cancel**: at release, the parent's tail already has an event (of any kind) after T = the parent has
 *   already restarted/continued. The done is then meaningless as that event, so it is returned with muted
 *   (kept in the log and EventFeed but no chirp).
 * - **Grace**: if not cancelled yet and DONE_GRACE_MS hasn't passed since the chick's last write, wait a bit
 *   longer for the parent to restart. Return null and re-evaluate on the next scan.
 * - **Timeout fire**: if the parent hasn't restarted after DONE_GRACE_MS, fire it as a done that may chirp.
 *   at stays t, the key basis (reason below), so firedAt=now is attached instead for App.tsx's freshness guard
 *   to check.
 *
 * Why at stays fixed to t (= T, the parent's own turn end):
 * - When a background agent finished, chirping done at the chick's write time W made the harness auto-restart
 *   the parent right after, write a completion report, and emit done again at that turn's end (T2), chirping
 *   twice in a row (actual problem). The first one at W is always redundant — the parent is always restarted
 *   and emits the T2 done.
 * - The key (`sessionId:t:done`) comes from t and never changes, so no matter how many times it is
 *   re-evaluated during suppression or grace it is the same key, fitting cleanly with both sessionEventCache's
 *   first-write-wins (cacheEvent) and deduplication (no "key changes on every fire" wobble like the old
 *   implementation with a variable at).
 *
 * For the basis of DONE_GRACE_MS (30 seconds), see the comment on the constant.
 *
 * Background tasks (run_in_background Bash etc.; backgroundTaskCache) are suppressed for the same reason as
 * chicks: even if the parent writes "running it in the background" and stops at T, the task's
 * <task-notification> always resumes the parent, which emits done at the report turn's end T2. The T done is
 * redundant, and chirping it makes one request speak twice (actual problem: the waiting announcement while
 * running five `claude -p` in the background was read out). Unlike chicks there is no dedicated transcript and
 * liveness can't be seen, so the check uses only the start and completion notification times:
 * - A task started at or before T with no completion notification yet → suppress (null)
 * - Started at or before T, with a completion notification after T → same as chick release (muted if the
 *   parent has resumed; otherwise timeout fire after the DONE_GRACE_MS grace)
 * Completion notifications come for both completed and failed (confirmed in real data). The escape hatch for
 * a missed notification line is BACKGROUND_TASK_STALE_MS.
 * As with chicks, the done of a turn that ended after talking with the user while a task was running is also
 * suppressed.
 */
export function deriveDoneEvent(
  sessionId: string,
  project: string,
  t: number,
  chicks: ChickView[],
  backgroundTasks: Map<string, BackgroundTask>,
  snippet: string | undefined,
  now: number,
  parentAdvanced: boolean,
  // This turn's final assistant reply text (assistant_text.text). A temporary value only used as input to the
  // done readout summary (lib/summarize.ts), so it is put as-is on the generated SessionEvent
  // (excluding it from persistence is appendToEventLog's responsibility)
  assistantText: string | undefined,
): SessionEvent | null {
  // Background tasks: only those started at or before T matter for T's done
  let lastTaskEndAfterT: number | undefined;
  for (const task of backgroundTasks.values()) {
    if (task.startedAt > t) continue;
    if (task.endedAt === undefined) {
      if (now - task.startedAt < BACKGROUND_TASK_STALE_MS) return null; // running → suppress
      continue; // the notification may have been missed (see BACKGROUND_TASK_STALE_MS)
    }
    if (task.endedAt > t) lastTaskEndAfterT = Math.max(lastTaskEndAfterT ?? 0, task.endedAt);
  }

  // Check suppression by running chicks first. A running chick is alive at the current scan (now > T), so
  // "alive past T" is certain without even looking at its write time.
  // If this came after the wasAnyChickAliveAfterT check, on the first scan right after the parent's turn end
  // there is a moment where even a running chick's last write is still before T, and just at that moment
  // wasAnyChickAliveAfterT would be misjudged as false and fall through to the normal immediate-fire path
  for (const chick of chicks) {
    if (chick.state === "done" || chick.state === "dozing") continue; // finished chicks don't matter
    if (chick.sinceMs < CHICK_ABANDONED_MS) return null; // suppress if even one chick looks like it is running
    // sinceMs >= CHICK_ABANDONED_MS: stuck in working with no writes for a long time = treated as abandoned and ignored
  }

  // A background task finished after T. As with chick release: muted if the parent has resumed; while waiting
  // for it to resume, grace up to DONE_GRACE_MS; if it still hasn't resumed, timeout fire
  if (lastTaskEndAfterT !== undefined) {
    if (parentAdvanced) {
      return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), muted: true };
    }
    if (now - lastTaskEndAfterT < DONE_GRACE_MS) return null;
    return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), firedAt: now };
  }

  // Reaching here means no chick is running. A stopped chick's last write time no longer moves, so the
  // comparison at this point (was any chick alive past T) is reliable
  const wasAnyChickAliveAfterT = chicks.some((chick) => now - chick.sinceMs > t);
  if (!wasAnyChickAliveAfterT) {
    // All chicks had finished at time T (including no chicks) = no suppression needed, normal immediate-fire path
    return mkSessionEvent(sessionId, project, "done", t, snippet, assistantText);
  }

  // Release: if the parent already has an event after T (restarted/continued), this done no longer means
  // anything, so return it muted (kept in the log and feed)
  if (parentAdvanced) {
    return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), muted: true };
  }

  // Grace: GRACE hasn't passed since the chick's last write. Wait a bit longer for the parent to restart
  const lastChickWriteAt = Math.max(...chicks.map((chick) => now - chick.sinceMs));
  if (now - lastChickWriteAt < DONE_GRACE_MS) return null;

  // Timeout fire: the parent hasn't restarted after GRACE. Return it as a done that may chirp
  return { ...mkSessionEvent(sessionId, project, "done", t, snippet, assistantText), firedAt: now };
}

function mkSessionEvent(
  sessionId: string,
  project: string,
  type: SessionEvent["type"],
  at: number,
  snippet?: string,
  assistantText?: string,
): SessionEvent {
  return { key: `${sessionId}:${at}:${type}`, sessionId, project, snippet, type, at, assistantText };
}
