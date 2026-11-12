// The watching grace period (docs/design.md "Watching"): a session stays watching for WATCH_GRACE_MS after its linked
// sessions last moved, unless it finished a turn after that (it took their result)
import { describe, expect, test } from "bun:test";
import type { BirdState, SessionView } from "../src/lib/session-types.ts";
import { peerLastActiveAt } from "../src/lib/session-store.ts";
import { rememberPeerStates, type WatchLinks } from "../src/lib/session-watch.ts";
import { sessionContinuing } from "../src/lib/turn-verdict.ts";
import { WATCH_GRACE_MS, watchingCount } from "../src/lib/watching.ts";

const SEC = 1000;
const MIN = 60 * SEC;

describe("watchingCount: the grace period and the session's own turn", () => {
  const now = 1_000 * MIN;
  const rows: [
    name: string,
    ownState: BirdState,
    peers: { active: boolean; lastActiveAt?: number }[],
    ownTurnEndedAt: number | undefined,
    want: number | undefined,
  ][] = [
    ["the child moves: watching, whenever the parent's turn ended", "done", [{ active: true, lastActiveAt: now }], now - 10 * SEC, 1],
    ["the child moves after the parent finished a later turn: still watching", "done", [{ active: true, lastActiveAt: now - MIN }], now, 1],
    ["the child stopped, the parent stopped before it (handed work over): grace period", "done", [{ active: false, lastActiveAt: now - MIN }], now - 2 * MIN, 0],
    ["the child stopped, the parent finished a turn after it: done", "done", [{ active: false, lastActiveAt: now - MIN }], now - 30 * SEC, undefined],
    ["the parent finished a turn after the child, then the child moved again: grace period again", "done", [{ active: false, lastActiveAt: now - 10 * SEC }], now - 30 * SEC, 0],
    ["dozing parent that finished after the child: done", "dozing", [{ active: false, lastActiveAt: now - 4 * MIN }], now - 3 * MIN, undefined],
    ["the grace period is over: not watching", "done", [{ active: false, lastActiveAt: now - WATCH_GRACE_MS - SEC }], now - 10 * MIN, undefined],
    ["the parent's turn end unknown: the grace period as before", "done", [{ active: false, lastActiveAt: now - MIN }], undefined, 0],
    ["two children, the parent finished after one but before the other: grace period", "done", [{ active: false, lastActiveAt: now - 3 * MIN }, { active: false, lastActiveAt: now - MIN }], now - 2 * MIN, 0],
    ["two children, the parent finished after both: done", "done", [{ active: false, lastActiveAt: now - 3 * MIN }, { active: false, lastActiveAt: now - MIN }], now - 30 * SEC, undefined],
    ["no time known for the child: not watching", "done", [{ active: false }], now - MIN, undefined],
    ["the parent is working: not watching", "working", [{ active: true, lastActiveAt: now }], now, undefined],
  ];
  for (const [name, ownState, peers, ownTurnEndedAt, want] of rows) {
    test(name, () => expect(watchingCount(ownState, peers, now, ownTurnEndedAt)).toBe(want));
  }
});

// The user's case (app-x, Claude desktop app): the child stopped at 20:12:37, the parent took its report and finished
// its turn at 20:13:07, and the parent stayed watching (a white dot in the concierge) until 20:17:37
test("app-x: the parent is done at 20:13:07, when it finished its turn after the child stopped", () => {
  const at = (hms: string) => Date.parse(`2026-11-11T${hms}+09:00`);
  const CHILD = "child-session";
  const childViewId = `claude/proj/${CHILD}.jsonl`;
  const childStoppedAt = at("20:12:37");
  const parentEndedAt = at("20:13:07");
  const watch = {
    liveBySessionId: new Map(),
    viewIdBySessionId: new Map([[CHILD, childViewId]]),
  } as unknown as WatchLinks;
  peerLastActiveAt.delete(CHILD);
  // Polls every 2 seconds, as the app does: the child's last time moved is recorded by the production code
  const verdicts: { time: number; watching: number | undefined }[] = [];
  for (let now = at("20:12:00"); now <= at("20:18:00"); now += 2 * SEC) {
    const childWorking = now < childStoppedAt + 6 * SEC; // a write in the last 6 seconds counts as working
    const childLastWrite = Math.min(now, childStoppedAt);
    const child = { id: childViewId, state: childWorking ? "working" : "done", sinceMs: now - childLastWrite } as SessionView;
    const lastActiveAt = peerLastActiveAt.get(CHILD);
    const parentDone = now >= parentEndedAt;
    const watching = watchingCount(
      parentDone ? "done" : "working",
      [{ active: childWorking, lastActiveAt }],
      now,
      parentDone ? parentEndedAt : undefined,
    );
    verdicts.push({ time: now, watching });
    rememberPeerStates([child], watch, now);
  }
  const doneFrom = verdicts.find((v) => v.time >= parentEndedAt);
  expect(doneFrom).toEqual({ time: parentEndedAt + SEC, watching: undefined });
  expect(verdicts.filter((v) => v.time >= parentEndedAt).every((v) => v.watching === undefined)).toBe(true);
  // So the parent isn't continuing (the concierge's working white dot) from then on
  expect(sessionContinuing(undefined, doneFrom?.watching, SEC).continuing).toBe(undefined);
  peerLastActiveAt.delete(CHILD);
});
