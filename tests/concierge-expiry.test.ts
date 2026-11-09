// When continuing from a reply's text expires (TEXT_CONTINUING_EXPIRES_MS), the concierge is asked like on a finished
// turn (docs/design.md "Turn verdicts", "Concierge"). The sessions go through the app's own path: deriveState for the
// machine state, withTurnVerdict for continuing, conciergeTriggerClasses and ConciergeScheduler for the requests
import { describe, expect, test } from "bun:test";
import { deriveState, DOZE_MS } from "../src/lib/bird-state.ts";
import {
  CONCIERGE_DEBOUNCE_MS,
  CONCIERGE_MIN_INTERVAL_MS,
  ConciergeScheduler,
  conciergeExpiredLogLines,
  conciergeTriggerClasses,
  conciergeTriggered,
} from "../src/lib/concierge.ts";
import { statusesAt, suggestionsOutdated } from "../src/lib/concierge-status.ts";
import type { SessionView } from "../src/lib/session-types.ts";
import type { TailInfo } from "../src/lib/transcript.ts";
import { TEXT_CONTINUING_EXPIRES_MS, withTurnVerdict } from "../src/lib/turn-verdict.ts";
import { fakeTimers } from "./helpers/fake-timers.ts";

const MIN = 60_000;
const textTail: TailInfo = {
  kind: "assistant_text",
  events: [],
  chickSignals: new Map(),
  backgroundTaskStarts: new Map(),
  peerNames: new Map(),
};

/** A session whose turn ended sinceMs ago with a reply, its turn verdict saying continuing (or not), as the app builds it */
function session(id: string, sinceMs: number, opts: { continuing?: boolean; watching?: number } = {}): SessionView {
  const base: SessionView = {
    id,
    project: id,
    slug: id,
    state: deriveState(textTail, sinceMs, false),
    sinceMs,
    reply: { at: 1, text: "the export runs in the background; I'll check the log later" },
    ...(opts.watching !== undefined && { watching: opts.watching }),
  };
  return withTurnVerdict(base, { ask: { status: "not_asking" }, line: "exporting", continuing: opts.continuing ?? true });
}

const classOf = (v: SessionView) => conciergeTriggerClasses([v]).get(v.id);

describe("the class of a session whose reply said continuing", () => {
  const scenes: [string, SessionView, { state: string; continuing: boolean | undefined; cls: string }][] = [
    ["just finished", session("a", 10_000), { state: "done", continuing: true, cls: "done" }],
    ["before it expires (dozing)", session("a", TEXT_CONTINUING_EXPIRES_MS - 1), { state: "dozing", continuing: true, cls: "dozing" }],
    ["right after it expires", session("a", TEXT_CONTINUING_EXPIRES_MS), { state: "dozing", continuing: false, cls: "expired" }],
    ["at the end of DOZE_MS after it", session("a", TEXT_CONTINUING_EXPIRES_MS + DOZE_MS - 1), { state: "dozing", continuing: false, cls: "expired" }],
    ["DOZE_MS after it", session("a", TEXT_CONTINUING_EXPIRES_MS + DOZE_MS), { state: "dozing", continuing: false, cls: "dozing" }],
    ["40 hours after it", session("a", 40 * 60 * MIN), { state: "dozing", continuing: false, cls: "dozing" }],
    ["watching: continuing doesn't expire", session("a", TEXT_CONTINUING_EXPIRES_MS + MIN, { watching: 1 }), { state: "dozing", continuing: true, cls: "dozing" }],
    ["the verdict said not continuing", session("a", TEXT_CONTINUING_EXPIRES_MS + MIN, { continuing: false }), { state: "dozing", continuing: false, cls: "dozing" }],
  ];
  for (const [name, v, want] of scenes) {
    test(name, () => {
      expect({ state: v.state, continuing: v.continuing, cls: classOf(v) }).toEqual(want);
    });
  }
});

describe("whether a change asks", () => {
  const at = (sinceMs: number, opts?: { continuing?: boolean; watching?: number }) =>
    conciergeTriggerClasses([session("a", sinceMs, opts)]);
  const scenes: [string, ReturnType<typeof at> | undefined, ReturnType<typeof at>, boolean][] = [
    ["dozing → expired", at(TEXT_CONTINUING_EXPIRES_MS - 1), at(TEXT_CONTINUING_EXPIRES_MS), true],
    ["expired → expired", at(TEXT_CONTINUING_EXPIRES_MS), at(TEXT_CONTINUING_EXPIRES_MS + MIN), false],
    ["expired → dozing", at(TEXT_CONTINUING_EXPIRES_MS + DOZE_MS - 1), at(TEXT_CONTINUING_EXPIRES_MS + DOZE_MS), false],
    ["first seen expired (launch)", undefined, at(TEXT_CONTINUING_EXPIRES_MS + MIN), true],
    ["first seen 40 hours after it (launch)", undefined, at(40 * 60 * MIN), false],
    [
      "watching, past 30 minutes",
      at(TEXT_CONTINUING_EXPIRES_MS - 1, { watching: 1 }),
      at(TEXT_CONTINUING_EXPIRES_MS + MIN, { watching: 1 }),
      false,
    ],
  ];
  for (const [name, prev, next, want] of scenes) {
    test(name, () => {
      expect(conciergeTriggered(prev, next)).toBe(want);
      // The app log tells an expiry apart, once
      expect(conciergeExpiredLogLines(prev, next)).toEqual(want ? ["[concierge] trigger kind=expired session=a"] : []);
    });
  }
});

describe("the scheduler over a session's 40 minutes after its turn (a scan every 10 seconds)", () => {
  // A turn reads as done only 6 seconds after its last write (WRITING_MS in lib/bird-state.ts), so the first scan that
  // sees it done is the one at 10 seconds
  const firstDone = 10_000;
  function run(views: (t: number) => SessionView[]) {
    const clock = fakeTimers();
    const requests: number[] = [];
    const clears: number[] = [];
    const scheduler = new ConciergeScheduler(
      () => requests.push(clock.now()),
      () => clears.push(clock.now()),
      clock.timers,
    );
    const scan = 10_000;
    for (let t = 0; t <= 40 * MIN; t += scan) {
      scheduler.update(conciergeTriggerClasses(views(t)), true);
      clock.advance(scan);
    }
    return { requests, clears };
  }

  test("text continuing: asked when it finishes and again when it expires; the advice goes at dozing both times", () => {
    const { requests, clears } = run((t) => [session("a", t)]);
    expect(requests).toEqual([firstDone + CONCIERGE_DEBOUNCE_MS, TEXT_CONTINUING_EXPIRES_MS + CONCIERGE_DEBOUNCE_MS]);
    // The first scan sees it still writing (working), so nothing is asked yet and the advice is cleared
    expect(clears).toEqual([0, DOZE_MS, TEXT_CONTINUING_EXPIRES_MS + DOZE_MS]);
  });

  test("watching: no request at 30 minutes", () => {
    const { requests } = run((t) => [session("a", t, { watching: 1 })]);
    expect(requests).toEqual([firstDone + CONCIERGE_DEBOUNCE_MS]);
  });

  test("an expiry right after another request waits for the 60 seconds, as a finished turn does", () => {
    // b finishes 20 seconds before a's continuing expires
    const bDone = TEXT_CONTINUING_EXPIRES_MS - 20_000;
    const { requests } = run((t) => [session("a", t), session("b", t - bDone, { continuing: false })].filter((v) => v.sinceMs >= 0));
    expect(requests).toEqual([
      firstDone + CONCIERGE_DEBOUNCE_MS,
      bDone + firstDone + CONCIERGE_DEBOUNCE_MS,
      bDone + firstDone + CONCIERGE_DEBOUNCE_MS + CONCIERGE_MIN_INTERVAL_MS,
    ]);
  });
});

describe("the Concierge tab", () => {
  test("suggestions from before it expired are out of date once it does", () => {
    const answeredAt = statusesAt([session("a", TEXT_CONTINUING_EXPIRES_MS - 1)]);
    expect(suggestionsOutdated(answeredAt, [session("a", TEXT_CONTINUING_EXPIRES_MS)])).toBe(true);
  });

  test("opening it asks while the expiry is new, not before it or once it dozes again", () => {
    const soonAt = (sinceMs: number) => {
      const scheduler = new ConciergeScheduler(() => {}, () => {}, fakeTimers().timers);
      scheduler.update(conciergeTriggerClasses([session("a", sinceMs)]), true);
      return scheduler.soon();
    };
    expect(soonAt(TEXT_CONTINUING_EXPIRES_MS - 1)).toBe(false);
    expect(soonAt(TEXT_CONTINUING_EXPIRES_MS + MIN)).toBe(true);
    expect(soonAt(TEXT_CONTINUING_EXPIRES_MS + DOZE_MS)).toBe(false);
  });
});
