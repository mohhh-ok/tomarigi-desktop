// The watching grace period (docs/design.md "Watching"): a session stays watching for WATCH_GRACE_MS after its linked
// sessions last moved, unless it finished a turn after that (it took their result)
import { describe, expect, test } from "bun:test";
import { deriveState } from "../src/lib/bird-state.ts";
import type { NativeFile } from "../src/lib/native-fs.ts";
import type { BirdState, SessionView } from "../src/lib/session-types.ts";
import { peerLastActiveAt } from "../src/lib/session-store.ts";
import { rememberPeerStates, type WatchLinks } from "../src/lib/session-watch.ts";
import { readTail } from "../src/lib/transcript.ts";
import { sessionContinuing } from "../src/lib/turn-verdict.ts";
import { lastWrittenAt, WATCH_GRACE_MS, watchingCount } from "../src/lib/watching.ts";

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
// its turn at 20:13:07, and the parent stayed watching (a white dot in the concierge) until 20:17:37. The parent's turn
// end and state come from its transcript through the production functions (readTail, lastWrittenAt, deriveState)
const at = (hms: string) => Date.parse(`2026-11-11T${hms}+09:00`);
const line = (hms: string, type: "user" | "assistant", text: string) => ({
  type,
  timestamp: new Date(at(hms)).toISOString(),
  message: { content: [{ type: "text", text }] },
});
function fileOf(lines: object[], lastModified: number): NativeFile {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    path: "/tmp/parent.jsonl",
    name: "parent.jsonl",
    size: bytes.length,
    lastModified,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
}

test("app-x: the parent leaves watching once it finished its turn at 20:13:07, after the child stopped", async () => {
  const CHILD = "child-session";
  const childViewId = `claude/proj/${CHILD}.jsonl`;
  const childStoppedAt = at("20:12:37");
  // The parent handed the work over at 20:10:00, took the child's report at 20:13:00 and finished its turn at 20:13:07
  const handedOver = [line("20:09:50", "user", "子に任せて"), line("20:10:00", "assistant", "子に渡しました")];
  const tookReport = [...handedOver, line("20:13:00", "user", "子の報告"), line("20:13:07", "assistant", "受け取りました")];
  const watch = {
    liveBySessionId: new Map(),
    viewIdBySessionId: new Map([[CHILD, childViewId]]),
  } as unknown as WatchLinks;
  peerLastActiveAt.delete(CHILD);
  // Polls every 2 seconds, as the app does: the child's last time moved is recorded by the production code
  const polls: { time: number; state: BirdState; turnEndedAt: number; watching: number | undefined }[] = [];
  for (let now = at("20:12:00"); now <= at("20:18:00"); now += 2 * SEC) {
    const childWorking = now < childStoppedAt + 6 * SEC; // a write in the last 6 seconds counts as working
    const childLastWrite = Math.min(now, childStoppedAt);
    const child = { id: childViewId, state: childWorking ? "working" : "done", sinceMs: now - childLastWrite } as SessionView;
    const lines = now >= at("20:13:07") ? tookReport : now >= at("20:13:00") ? tookReport.slice(0, 3) : handedOver;
    const tail = await readTail(fileOf(lines, now));
    const turnEndedAt = lastWrittenAt(tail, now);
    const state = deriveState(tail, now - turnEndedAt, false);
    const watching = watchingCount(state, [{ active: childWorking, lastActiveAt: peerLastActiveAt.get(CHILD) }], now, turnEndedAt);
    polls.push({ time: now, state, turnEndedAt, watching });
    rememberPeerStates([child], watch, now);
  }
  // Before it took the report, it was watching its child (moving, then in the grace period)
  expect(polls.filter((p) => p.time < at("20:13:00")).every((p) => p.watching !== undefined)).toBe(true);
  // A write in the last 6 seconds counts as working, so its first done is 20:13:14; from then on it isn't watching,
  // with its turn's end read as 20:13:07
  const firstDone = polls.find((p) => p.time >= at("20:13:07") && p.state === "done");
  expect(firstDone).toEqual({ time: at("20:13:14"), state: "done", turnEndedAt: at("20:13:07"), watching: undefined });
  expect(polls.filter((p) => p.time >= at("20:13:14")).every((p) => p.watching === undefined)).toBe(true);
  // So the parent isn't continuing (the concierge's working white dot) from then on
  expect(sessionContinuing(undefined, firstDone?.watching, SEC).continuing).toBe(undefined);
  peerLastActiveAt.delete(CHILD);
});
