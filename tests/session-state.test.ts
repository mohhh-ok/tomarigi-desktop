// Pins the current behavior of the machine-state and done-event rules in lib/sessions.ts (the expected values are
// what the code does today, not a spec). Pure functions only; the liveness rules run through scanSessions in
// liveness.test.ts.
import { describe, expect, test } from "bun:test";
import type { TailEvent, TailInfo, TailKind } from "../src/lib/transcript.ts";
import type { BirdState, ChickView } from "../src/lib/sessions.ts";
import {
  deriveDoneEvent,
  deriveSdkChickState,
  deriveState,
  escalateWithChicks,
  extractQuestion,
  formatSnippet,
  resolveChickDoneSignalAt,
} from "../src/lib/sessions.ts";

const SEC = 1_000;
const MIN = 60_000;
// The thresholds as they are today (WRITING_MS, CHICK_TEXT_DONE_MS, DOZE_MS, CHICK_ABANDONED_MS, DONE_GRACE_MS,
// BACKGROUND_TASK_STALE_MS, CHICK_SIGNAL_EPSILON_MS). Written out here so a change to any of them shows up
const WRITING_MS = 6 * SEC;
const CHICK_TEXT_DONE_MS = 2 * MIN;
const DOZE_MS = 5 * MIN;
const CHICK_ABANDONED_MS = 10 * MIN;
const DONE_GRACE_MS = 30 * SEC;
const BACKGROUND_TASK_STALE_MS = 30 * MIN;
const CHICK_SIGNAL_EPSILON_MS = 5 * SEC;

const tailOf = (kind: TailKind, toolName?: string, events: TailEvent[] = []): TailInfo => ({
  kind,
  toolName,
  events,
  chickSignals: new Map(),
  backgroundTaskStarts: new Map(),
  peerNames: new Map(),
});
const chick = (state: BirdState, sinceMs: number, id = "c"): ChickView => ({ id, name: id, state, sinceMs });

describe("deriveState (parent)", () => {
  const parent = (kind: TailKind, sinceMs: number, toolName?: string) =>
    deriveState(tailOf(kind, toolName), sinceMs, false);

  test("closed is dozing even right after a write", () => {
    expect(parent("closed", 0)).toBe("dozing");
  });

  test("stopped on a question tool is waiting regardless of recent writes", () => {
    for (const tool of ["AskUserQuestion", "ExitPlanMode", "request_user_input"]) {
      expect(parent("tool_use", 0, tool)).toBe("waiting");
      expect(parent("tool_use", 60 * MIN, tool)).toBe("waiting");
    }
  });

  test("a write within WRITING_MS is working", () => {
    for (const kind of ["assistant_text", "user", "tool_result", "unknown"] as const) {
      expect(parent(kind, WRITING_MS - 1)).toBe("working");
    }
  });

  test("a running tool is working however long it is idle", () => {
    expect(parent("tool_use", 3 * 60 * MIN, "Bash")).toBe("working");
  });

  test("assistant_text is done from WRITING_MS and dozing from DOZE_MS", () => {
    expect(parent("assistant_text", WRITING_MS)).toBe("done");
    expect(parent("assistant_text", DOZE_MS - 1)).toBe("done");
    expect(parent("assistant_text", DOZE_MS)).toBe("dozing");
  });

  test("user / tool_result stay working however long they wait", () => {
    expect(parent("user", 3 * 60 * MIN)).toBe("working");
    expect(parent("tool_result", 3 * 60 * MIN)).toBe("working");
  });

  test("unknown never goes through done: working, then dozing from DOZE_MS", () => {
    expect(parent("unknown", DOZE_MS - 1)).toBe("working");
    expect(parent("unknown", DOZE_MS)).toBe("dozing");
  });
});

describe("deriveState (chick)", () => {
  const chickState = (kind: TailKind, sinceMs: number, signalAt?: number, toolName?: string) =>
    deriveState(tailOf(kind, toolName), sinceMs, true, signalAt);

  test("a question tool does not make a chick waiting", () => {
    expect(chickState("tool_use", 0, undefined, "AskUserQuestion")).toBe("working");
    expect(chickState("tool_use", 60 * MIN, undefined, "AskUserQuestion")).toBe("working");
  });

  test("with a completion signal it is done even right after a write, dozing from DOZE_MS", () => {
    expect(chickState("tool_use", 0, 1, "Bash")).toBe("done");
    expect(chickState("assistant_text", DOZE_MS - 1, 1)).toBe("done");
    expect(chickState("assistant_text", DOZE_MS, 1)).toBe("dozing");
  });

  test("closed beats the signal", () => {
    expect(chickState("closed", 0, 1)).toBe("dozing");
  });

  test("without a signal, assistant_text is working until CHICK_TEXT_DONE_MS", () => {
    expect(chickState("assistant_text", WRITING_MS)).toBe("working");
    expect(chickState("assistant_text", CHICK_TEXT_DONE_MS - 1)).toBe("working");
    expect(chickState("assistant_text", CHICK_TEXT_DONE_MS)).toBe("done");
    expect(chickState("assistant_text", DOZE_MS)).toBe("dozing");
  });

  test("without a signal, user / tool_result stay working", () => {
    expect(chickState("user", 60 * MIN)).toBe("working");
    expect(chickState("tool_result", 60 * MIN)).toBe("working");
  });
});

describe("deriveSdkChickState", () => {
  const sdk = (kind: TailKind, sinceMs: number) => deriveSdkChickState(tailOf(kind, "Bash"), sinceMs);

  test("closed is dozing; a write within WRITING_MS is working", () => {
    expect(sdk("closed", 0)).toBe("dozing");
    expect(sdk("tool_result", WRITING_MS - 1)).toBe("working");
  });

  test("a running tool is working however long it is idle", () => {
    expect(sdk("tool_use", 3 * 60 * MIN)).toBe("working");
  });

  test("assistant_text / user / tool_result: working, done from CHICK_TEXT_DONE_MS, dozing from DOZE_MS", () => {
    for (const kind of ["assistant_text", "user", "tool_result"] as const) {
      expect(sdk(kind, CHICK_TEXT_DONE_MS - 1)).toBe("working");
      expect(sdk(kind, CHICK_TEXT_DONE_MS)).toBe("done");
      expect(sdk(kind, DOZE_MS)).toBe("dozing");
    }
  });

  test("unknown never goes through done", () => {
    expect(sdk("unknown", DOZE_MS - 1)).toBe("working");
    expect(sdk("unknown", DOZE_MS)).toBe("dozing");
  });
});

describe("escalateWithChicks", () => {
  test("the parent takes the most urgent state of its non-dozing chicks", () => {
    expect(escalateWithChicks("dozing", [chick("working", 0)])).toBe("working");
    expect(escalateWithChicks("dozing", [chick("done", 0)])).toBe("done");
    expect(escalateWithChicks("done", [chick("working", 0), chick("waiting", 0)])).toBe("waiting");
    expect(escalateWithChicks("working", [chick("done", 0)])).toBe("working");
  });

  test("dozing chicks are ignored", () => {
    expect(escalateWithChicks("dozing", [chick("dozing", 0)])).toBe("dozing");
    expect(escalateWithChicks("dozing", [])).toBe("dozing");
  });
});

describe("resolveChickDoneSignalAt", () => {
  const signals = new Map([
    ["task-a", 1_000],
    ["toolu_b", 2_000],
  ]);

  test("looks up the task-id and the toolUseId, and takes the newer", () => {
    expect(resolveChickDoneSignalAt(signals, "task-a", undefined, 500)).toBe(1_000);
    expect(resolveChickDoneSignalAt(signals, "task-x", "toolu_b", 500)).toBe(2_000);
    expect(resolveChickDoneSignalAt(signals, "task-a", "toolu_b", 500)).toBe(2_000);
    expect(resolveChickDoneSignalAt(signals, "task-x", "toolu_x", 500)).toBeUndefined();
  });

  test("a chick that wrote more than CHICK_SIGNAL_EPSILON_MS after the signal has resumed", () => {
    expect(resolveChickDoneSignalAt(signals, "task-a", undefined, 1_000 + CHICK_SIGNAL_EPSILON_MS)).toBe(1_000);
    expect(resolveChickDoneSignalAt(signals, "task-a", undefined, 1_000 + CHICK_SIGNAL_EPSILON_MS + 1)).toBeUndefined();
  });

  test("an unknown last conversation time keeps the signal", () => {
    expect(resolveChickDoneSignalAt(signals, "task-a", undefined, undefined)).toBe(1_000);
  });
});

describe("deriveDoneEvent", () => {
  const now = 10_000_000;
  const t = now - 60 * SEC; // the parent's turn end
  type Task = { startedAt: number; endedAt?: number };
  const done = (opts: { chicks?: ChickView[]; tasks?: Task[]; parentAdvanced?: boolean }) =>
    deriveDoneEvent(
      "sid",
      "proj",
      t,
      opts.chicks ?? [],
      new Map((opts.tasks ?? []).map((task, i) => [`task-${i}`, task])),
      "snip",
      now,
      opts.parentAdvanced ?? false,
      "reply",
    );

  test("no chicks and no tasks fires right away with the turn end as at", () => {
    expect(done({})).toEqual({
      key: `sid:${t}:done`,
      sessionId: "sid",
      project: "proj",
      snippet: "snip",
      type: "done",
      at: t,
      assistantText: "reply",
    });
  });

  test("chicks that had all stopped by the turn end don't hold it back", () => {
    expect(done({ chicks: [chick("done", now - t + 1)] })?.firedAt).toBeUndefined();
    expect(done({ chicks: [chick("done", now - t + 1)] })?.muted).toBeUndefined();
  });

  test("a running chick suppresses it until it is abandoned (CHICK_ABANDONED_MS)", () => {
    expect(done({ chicks: [chick("working", 0)] })).toBeNull();
    expect(done({ chicks: [chick("waiting", CHICK_ABANDONED_MS - 1)] })).toBeNull();
    // abandoned, and its last write was before the turn end: the normal path
    const abandoned = done({ chicks: [chick("working", CHICK_ABANDONED_MS)] });
    expect(abandoned?.type).toBe("done");
    expect(abandoned?.firedAt).toBeUndefined();
  });

  test("a chick that stopped after the turn end: muted once the parent moved on", () => {
    const released = done({ chicks: [chick("done", 10 * SEC)], parentAdvanced: true });
    expect(released?.muted).toBe(true);
    expect(released?.at).toBe(t);
  });

  test("a chick that stopped after the turn end: waits DONE_GRACE_MS, then fires with firedAt", () => {
    expect(done({ chicks: [chick("done", DONE_GRACE_MS - 1)] })).toBeNull();
    const fired = done({ chicks: [chick("done", DONE_GRACE_MS)] });
    expect(fired?.firedAt).toBe(now);
    expect(fired?.at).toBe(t);
    expect(fired?.muted).toBeUndefined();
  });

  test("a background task started before the turn end and not finished suppresses it", () => {
    expect(done({ tasks: [{ startedAt: t - SEC }] })).toBeNull();
    expect(done({ tasks: [{ startedAt: t }] })).toBeNull();
  });

  test("an unfinished task older than BACKGROUND_TASK_STALE_MS is ignored", () => {
    const stale = done({ tasks: [{ startedAt: now - BACKGROUND_TASK_STALE_MS }] });
    expect(stale?.type).toBe("done");
    expect(stale?.firedAt).toBeUndefined();
  });

  test("a task started after the turn end is ignored", () => {
    expect(done({ tasks: [{ startedAt: t + 1 }] })?.firedAt).toBeUndefined();
  });

  test("a task that ended after the turn end: muted, grace, then timeout fire", () => {
    expect(done({ tasks: [{ startedAt: t - SEC, endedAt: now - SEC }], parentAdvanced: true })?.muted).toBe(true);
    expect(done({ tasks: [{ startedAt: t - SEC, endedAt: now - DONE_GRACE_MS + 1 }] })).toBeNull();
    expect(done({ tasks: [{ startedAt: t - SEC, endedAt: now - DONE_GRACE_MS }] })?.firedAt).toBe(now);
  });

  test("a task that ended before the turn end doesn't hold it back", () => {
    expect(done({ tasks: [{ startedAt: t - 2 * SEC, endedAt: t - SEC }] })?.firedAt).toBeUndefined();
  });

  test("a running chick suppresses even when a finished task would release", () => {
    expect(done({ chicks: [chick("working", 0)], tasks: [{ startedAt: t - SEC, endedAt: now - MIN }] })).toBeNull();
  });
});

describe("formatSnippet", () => {
  test("normalizes whitespace and strips leading image marks", () => {
    expect(formatSnippet("  push\n\n it  ")).toBe("push it");
    expect(formatSnippet("[Image #1] [Image #2] look")).toBe("look");
  });

  test("rejects machine text", () => {
    expect(formatSnippet("<command-name>/clear</command-name>")).toBeUndefined();
    expect(formatSnippet("[SYSTEM notice]")).toBeUndefined();
    expect(formatSnippet("[Request interrupted by user]")).toBeUndefined();
    expect(formatSnippet("   ")).toBeUndefined();
    expect(formatSnippet("[Image #1]")).toBeUndefined();
  });

  test("cuts at 24 half-width units, full-width counting as 2", () => {
    expect(formatSnippet("a".repeat(24))).toBe("a".repeat(24));
    expect(formatSnippet("a".repeat(25))).toBe(`${"a".repeat(24)}…`);
    expect(formatSnippet("あ".repeat(12))).toBe("あ".repeat(12));
    expect(formatSnippet("あ".repeat(13))).toBe(`${"あ".repeat(12)}…`);
    expect(formatSnippet("ｱ".repeat(24))).toBe("ｱ".repeat(24));
  });
});

describe("extractQuestion", () => {
  test("takes the first questions[].question", () => {
    expect(extractQuestion(JSON.stringify({ questions: [{ question: "Which one?\nA or B" }, { question: "x" }] }))).toBe(
      "Which one? A or B",
    );
  });

  test("uses what is there when cut off mid-string", () => {
    expect(extractQuestion('{"questions":[{"question":"Cut here \\')).toBe("Cut here");
  });

  test("no question text gives undefined", () => {
    expect(extractQuestion(undefined)).toBeUndefined();
    expect(extractQuestion(JSON.stringify({ plan: "p" }))).toBeUndefined();
    expect(extractQuestion(JSON.stringify({ questions: [{ question: "  " }] }))).toBeUndefined();
  });
});
