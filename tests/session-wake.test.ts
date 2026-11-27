// continuing from the reply's text holds only while something the app sees can wake the Claude Code session (docs/design/turn-verdicts.md
// "Turn verdicts"): readTail's wakes, the ledger (updateWakes), wakeSourceOf and sessionContinuing. Lines shaped like the
// records Claude Code writes for ScheduleWakeup, CronCreate, Monitor and their cancellation; ids, names and texts made up
import { beforeEach, describe, expect, test } from "bun:test";
import type { NativeFile } from "../src/lib/native-fs.ts";
import { readTail } from "../src/lib/transcript.ts";
import { updateBackgroundTasks } from "../src/lib/session-events.ts";
import { backgroundTaskCache, unwakeableCache, wakeCache } from "../src/lib/session-store.ts";
import {
  FRESH_UNLINKED_CHILD_MS,
  pendingWakeOf,
  rootsWithFreshUnlinkedChild,
  unwakeableForMsOf,
  updateWakes,
  wakeSourceOf,
} from "../src/lib/session-wake.ts";
import { sessionContinuing, withTurnVerdict } from "../src/lib/turn-verdict.ts";
import { conciergeTriggerClasses } from "../src/lib/concierge.ts";
import type { SessionView } from "../src/lib/session-types.ts";

const OWN = "5e5e5e5e-0000-4000-8000-000000000001";
const MIN = 60_000;
const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function fileOf(lines: object[]): NativeFile {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  return {
    path: `/tmp/${OWN}.jsonl`,
    name: `${OWN}.jsonl`,
    size: bytes.length,
    lastModified: 0,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
}

const base = { sessionId: OWN, isSidechain: false };
const prompt = (ms: number, text: string) => ({ ...base, type: "user", timestamp: iso(ms), turnOrigin: "human", origin: { kind: "human" }, message: { content: text } });
const toolUse = (ms: number, id: string, name: string, input: object) => ({
  ...base,
  type: "assistant",
  timestamp: iso(ms),
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (ms: number, id: string, text: string, toolUseResult: object) => ({
  ...base,
  type: "user",
  timestamp: iso(ms),
  toolUseResult,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});
const reply = (ms: number, text: string) => ({ ...base, type: "assistant", timestamp: iso(ms), message: { content: [{ type: "text", text }] } });
const turnEnd = (ms: number) => ({ ...base, type: "system", subtype: "turn_duration", timestamp: iso(ms) });
const notice = (ms: number, body: string) => ({ ...base, type: "queue-operation", operation: "enqueue", timestamp: iso(ms), content: body });

// The shape of the case: a report that ends by saying what it will do next, and nothing left running
const saysNextStep = [
  prompt(0, "look into the plan options"),
  reply(60_000, "The options are listed in the notes. Next, I'll write the draft of the reply based on this."),
  turnEnd(60_100),
];

async function ledgersOf(lines: object[]) {
  const tail = await readTail(fileOf(lines), { ownSessionId: OWN });
  return { backgroundTasks: updateBackgroundTasks(OWN, tail), wakes: updateWakes(OWN, tail) };
}

beforeEach(() => {
  backgroundTaskCache.clear();
  wakeCache.clear();
  unwakeableCache.clear();
});

describe("continuing from the reply's text and what can wake the session", () => {
  const NOW = T0 + 5 * MIN;
  const stopped = { chicks: [], freshUnlinkedChild: false, now: NOW };

  test("it says it will do the next step and nothing runs: continuing ends at once", async () => {
    const wakeable = wakeSourceOf({ ...(await ledgersOf(saysNextStep)), ...stopped });
    expect(wakeable).toBe(false);
    const unwakeableForMs = unwakeableForMsOf("v", wakeable, T0 + 60_100, NOW);
    expect(sessionContinuing(true, undefined, 4 * MIN, unwakeableForMs)).toEqual({ continuing: false, expired: true, expiredForMs: NOW - (T0 + 60_100) });
  });

  test("a background command still runs: continuing holds", async () => {
    const lines = [
      saysNextStep[0],
      toolUse(10_000, "tu1", "Bash", { command: "long-job", run_in_background: true }),
      toolResult(11_000, "tu1", "Command running in background", { backgroundTaskId: "bgjob1" }),
      ...saysNextStep.slice(1),
    ];
    const wakeable = wakeSourceOf({ ...(await ledgersOf(lines)), ...stopped });
    expect(wakeable).toBe(true);
    expect(unwakeableForMsOf("v", wakeable, T0 + 60_100, NOW)).toBeUndefined();
    expect(sessionContinuing(true, undefined, 4 * MIN, undefined)).toEqual({ continuing: true, expired: false });
  });

  test("a background command that finished doesn't hold it", async () => {
    const lines = [
      saysNextStep[0],
      toolResult(11_000, "tu1", "Command running in background", { backgroundTaskId: "bgjob1" }),
      notice(30_000, "<task-notification>\n<task-id>bgjob1</task-id>\n<status>completed</status>\n</task-notification>"),
      ...saysNextStep.slice(1),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(lines)), ...stopped })).toBe(false);
  });

  test("a chick still works: continuing holds", async () => {
    const wakeable = wakeSourceOf({ ...(await ledgersOf(saysNextStep)), ...stopped, chicks: [{ state: "working" }] });
    expect(wakeable).toBe(true);
    expect(wakeSourceOf({ ...(await ledgersOf(saysNextStep)), ...stopped, chicks: [{ state: "done" }] })).toBe(false);
  });

  test("an abandoned chick (deriveState shows it dozing) doesn't hold it: continuing ends", async () => {
    const abandoned = { state: "dozing" as const };
    const wakeable = wakeSourceOf({ ...(await ledgersOf(saysNextStep)), ...stopped, chicks: [abandoned] });
    expect(wakeable).toBe(false);
    const unwakeableForMs = unwakeableForMsOf("v", wakeable, T0 + 60_100, NOW);
    expect(sessionContinuing(true, undefined, 4 * MIN, unwakeableForMs)).toEqual({ continuing: false, expired: true, expiredForMs: NOW - (T0 + 60_100) });
  });

  test("a scheduled wakeup that hasn't fired holds it; one that fired or was stopped doesn't", async () => {
    const scheduled = [
      ...saysNextStep.slice(0, 2),
      toolUse(61_000, "tu2", "ScheduleWakeup", { delaySeconds: 1200, prompt: "check the results", reason: "a fallback check" }),
      toolResult(61_500, "tu2", "Next wakeup scheduled", { scheduledFor: T0 + 21 * MIN, clampedDelaySeconds: 1200, wasClamped: false }),
      turnEnd(62_000),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(scheduled)), ...stopped })).toBe(true);
    // Its time passed: it fired, and that turn is the session's own
    expect(wakeSourceOf({ ...(await ledgersOf(scheduled)), ...stopped, now: T0 + 22 * MIN })).toBe(false);
    backgroundTaskCache.clear();
    wakeCache.clear();
    const cancelled = [
      ...scheduled.slice(0, -1),
      toolUse(63_000, "tu3", "ScheduleWakeup", { stop: true }),
      toolResult(63_500, "tu3", "Loop stopped", { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 }),
      turnEnd(64_000),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(cancelled)), ...stopped })).toBe(false);
  });

  test("a one-shot cron holds it until it fires; a recurring one until it is deleted", async () => {
    const oneShot = [
      saysNextStep[0],
      toolResult(10_000, "tu4", "Scheduled one-shot task", { id: "c0ffee01", humanSchedule: "0 11 * * *", recurring: false, durable: false, nextFireAt: T0 + 60 * MIN }),
      ...saysNextStep.slice(1),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(oneShot)), ...stopped })).toBe(true);
    expect(wakeSourceOf({ ...(await ledgersOf(oneShot)), ...stopped, now: T0 + 61 * MIN })).toBe(false);
    wakeCache.clear();
    const recurring = [
      saysNextStep[0],
      toolResult(10_000, "tu5", "Scheduled recurring task", { id: "c0ffee02", recurring: true, durable: false, nextFireAt: T0 + 2 * MIN }),
      ...saysNextStep.slice(1),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(recurring)), ...stopped, now: T0 + 90 * MIN })).toBe(true);
    wakeCache.clear();
    const deleted = [...recurring.slice(0, 2), toolUse(20_000, "tu6", "CronDelete", { id: "c0ffee02" }), ...saysNextStep.slice(1)];
    expect(wakeSourceOf({ ...(await ledgersOf(deleted)), ...stopped })).toBe(false);
  });

  test("a monitor holds it through its events until its stream ends, it is stopped, or it times out", async () => {
    const started = [
      saysNextStep[0],
      toolUse(10_000, "tu7", "Monitor", { command: "watch-log", description: "the job's log", timeout_ms: 1_800_000 }),
      toolResult(10_500, "tu7", "Monitor started", { taskId: "mon0001", timeoutMs: 1_800_000, persistent: false }),
      notice(20_000, "<task-notification>\n<task-id>mon0001</task-id>\n<summary>Monitor event: \"the job's log\"</summary>\n<event>line</event>\n</task-notification>"),
      ...saysNextStep.slice(1),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(started)), ...stopped })).toBe(true);
    expect(wakeSourceOf({ ...(await ledgersOf(started)), ...stopped, now: T0 + 31 * MIN })).toBe(false);
    wakeCache.clear();
    const ended = [
      ...started.slice(0, 4),
      notice(30_000, "<task-notification>\n<task-id>mon0001</task-id>\n<status>completed</status>\n<summary>Monitor stream ended</summary>\n</task-notification>"),
      ...saysNextStep.slice(1),
    ];
    expect(wakeSourceOf({ ...(await ledgersOf(ended)), ...stopped })).toBe(false);
    wakeCache.clear();
    const taskStopped = [...started.slice(0, 4), toolUse(30_000, "tu8", "TaskStop", { task_id: "mon0001" }), ...saysNextStep.slice(1)];
    expect(wakeSourceOf({ ...(await ledgersOf(taskStopped)), ...stopped })).toBe(false);
  });

  test("the ledger keeps a wake after its line left the tail window", async () => {
    const first = [
      saysNextStep[0],
      toolResult(10_000, "tu2", "Next wakeup scheduled", { scheduledFor: T0 + 21 * MIN, clampedDelaySeconds: 1200, wasClamped: false }),
    ];
    await ledgersOf(first);
    const later = await ledgersOf(saysNextStep.slice(1));
    expect(pendingWakeOf(later.wakes, NOW)).toBe(true);
  });

  test("a child started from a terminal that hasn't linked to anyone yet holds every parent of its config root", async () => {
    const child = (over: object) => ({ rootId: "root-a", sessionId: "c1", startedBySession: true, linked: false, startedAt: NOW - 3 * MIN, ...over });
    expect([...rootsWithFreshUnlinkedChild([child({})], NOW)]).toEqual(["root-a"]);
    expect([...rootsWithFreshUnlinkedChild([child({ linked: true })], NOW)]).toEqual([]);
    expect([...rootsWithFreshUnlinkedChild([child({ startedBySession: false })], NOW)]).toEqual([]);
    expect([...rootsWithFreshUnlinkedChild([child({ startedAt: NOW - FRESH_UNLINKED_CHILD_MS - 1 })], NOW)]).toEqual([]);
    const wakeable = wakeSourceOf({ ...(await ledgersOf(saysNextStep)), ...stopped, freshUnlinkedChild: true });
    expect(wakeable).toBe(true);
  });

  test("where the app can't tell (Codex, SDK sessions), the 30 minutes are the only end", () => {
    expect(sessionContinuing(true, undefined, 4 * MIN, undefined)).toEqual({ continuing: true, expired: false });
    expect(sessionContinuing(true, undefined, 30 * MIN, undefined)).toEqual({ continuing: false, expired: true, expiredForMs: 0 });
  });

  test("watching and a verdict of no are not changed by it", () => {
    expect(sessionContinuing(true, 1, 4 * MIN, 4 * MIN)).toEqual({ continuing: true, expired: false });
    expect(sessionContinuing(false, undefined, 4 * MIN, 4 * MIN)).toEqual({ continuing: false, expired: false });
    expect(sessionContinuing(undefined, undefined, 4 * MIN, 4 * MIN)).toEqual({ continuing: undefined, expired: false });
  });
});

describe("when continuing ended, for the concierge", () => {
  const WRITE = T0;
  test("nothing could wake it from its last write: the time counts from the write", () => {
    expect(unwakeableForMsOf("v1", false, WRITE, WRITE + 2 * MIN)).toBe(2 * MIN);
    expect(unwakeableForMsOf("v1", false, WRITE, WRITE + 7 * MIN)).toBe(7 * MIN);
  });

  test("the last thing that could wake it went later: the time counts from the scan that found it gone", () => {
    expect(unwakeableForMsOf("v2", true, WRITE, WRITE + 2 * MIN)).toBeUndefined();
    expect(unwakeableForMsOf("v2", false, WRITE, WRITE + 10 * MIN)).toBe(0);
    expect(unwakeableForMsOf("v2", false, WRITE, WRITE + 12 * MIN)).toBe(2 * MIN);
    // A new write starts over
    expect(unwakeableForMsOf("v2", false, WRITE + 20 * MIN, WRITE + 21 * MIN)).toBe(MIN);
  });

  const view = (over: Partial<SessionView>): SessionView =>
    ({ id: "v", project: "p", slug: "p", state: "dozing", sinceMs: 6 * MIN, reply: { at: WRITE, text: "Next, I'll write it." }, ...over }) as SessionView;
  const classOf = (v: SessionView) => conciergeTriggerClasses([withTurnVerdict(v, { continuing: true })]).get("v");

  test("ended at its turn's end: asked as done, and dozing doesn't ask again", () => {
    expect(classOf(view({ state: "done", sinceMs: 2 * MIN, unwakeableForMs: 2 * MIN }))).toBe("done");
    expect(classOf(view({ sinceMs: 6 * MIN, unwakeableForMs: 6 * MIN }))).toBe("dozing");
  });

  test("ended while dozing (the last wake went): asked as an expiry for 5 minutes after it", () => {
    expect(classOf(view({ sinceMs: 12 * MIN, unwakeableForMs: MIN }))).toBe("expired");
    expect(classOf(view({ sinceMs: 18 * MIN, unwakeableForMs: 6 * MIN }))).toBe("dozing");
  });

  test("the 30 minutes still give an expiry for 5 minutes after them", () => {
    expect(classOf(view({ sinceMs: 31 * MIN }))).toBe("expired");
    expect(classOf(view({ sinceMs: 36 * MIN }))).toBe("dozing");
  });
});
