import { asBlocks, taskNotificationOf, type TranscriptEntry } from "./transcript-entry";
// What a session set up to wake itself later, from its transcript lines (TailInfo.wakes)

const finiteNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const nonEmptyString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Picks up what the session set up to wake itself and what cancelled or ended it (see TailInfo.wakes). Each result is
 * told by its own fields, as Claude Code writes them in toolUseResult; the cancelling calls by their tool_use input
 */
export function collectWakes(
  entry: TranscriptEntry,
  at: number,
  starts: Map<string, { at: number; until?: number }>,
  ends: Map<string, number>,
): void {
  if (entry.type === "queue-operation" || (entry.type === "user" && typeof entry.message?.content === "string")) {
    const n = taskNotificationOf(entry.type === "queue-operation" ? entry.content : entry.message?.content);
    if (n?.hasStatus) ends.set(`monitor:${n.taskId}`, at);
    return;
  }
  if (entry.type === "assistant") {
    for (const b of asBlocks(entry.message?.content)) {
      if (b.type !== "tool_use") continue;
      const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
      if (b.name === "CronDelete") {
        const id = nonEmptyString(input.id);
        if (id) ends.set(`cron:${id}`, at);
      } else if (b.name === "TaskStop") {
        const id = nonEmptyString(input.task_id) ?? nonEmptyString(input.shell_id);
        if (id) ends.set(`monitor:${id}`, at);
      }
    }
    return;
  }
  const r = entry.type === "user" ? entry.toolUseResult : undefined;
  if (!r || typeof r !== "object") return;
  const scheduledFor = finiteNumber(r.scheduledFor);
  if (scheduledFor !== undefined) {
    if (r.stopped === true || scheduledFor <= 0) ends.set("wakeup", at);
    else starts.set("wakeup", { at, until: scheduledFor });
    return;
  }
  const cronId = nonEmptyString(r.id);
  const nextFireAt = finiteNumber(r.nextFireAt);
  if (cronId && nextFireAt !== undefined) {
    starts.set(`cron:${cronId}`, r.recurring === true ? { at } : { at, until: nextFireAt });
    return;
  }
  const monitorId = nonEmptyString(r.taskId);
  const timeoutMs = finiteNumber(r.timeoutMs);
  if (monitorId && timeoutMs !== undefined) {
    starts.set(`monitor:${monitorId}`, r.persistent === true ? { at } : { at, until: at + timeoutMs });
  }
}
