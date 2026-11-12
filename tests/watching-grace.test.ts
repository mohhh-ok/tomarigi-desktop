// The watching grace period (docs/design.md "Watching"): a session stays watching for WATCH_GRACE_MS after its linked
// sessions last moved, unless no linked session moves now and it finished a turn after their last writes (it took their result)
import { describe, expect, test } from "bun:test";
import { deriveState } from "../src/lib/bird-state.ts";
import type { NativeFile } from "../src/lib/native-fs.ts";
import type { BirdState, SessionView } from "../src/lib/session-types.ts";
import { lastPeerStates, peerLastActiveAt } from "../src/lib/session-store.ts";
import { peerMotion, rememberPeerStates, type WatchLinks } from "../src/lib/session-watch.ts";
import { lastWrittenAt, readTail } from "../src/lib/transcript.ts";
import { sessionContinuing } from "../src/lib/turn-verdict.ts";
import { WATCH_GRACE_MS, watchingCount } from "../src/lib/watching.ts";

const SEC = 1000;
const MIN = 60 * SEC;

describe("watchingCount: the grace period and the session's own turn", () => {
  const now = 1_000 * MIN;
  type Peer = { active: boolean; lastActiveAt?: number; lastWriteAt?: number };
  // A stopped child: it counts as working for 6 seconds after its last write, so the app last saw it moving then
  const stopped = (lastWriteAt: number): Peer => ({ active: false, lastActiveAt: lastWriteAt + 6 * SEC, lastWriteAt });
  const rows: [name: string, ownState: BirdState, peers: Peer[], ownTurnEndedAt: number | undefined, want: number | undefined][] = [
    ["the child moves: watching, whenever the parent's turn ended", "done", [{ active: true, lastActiveAt: now, lastWriteAt: now }], now - 10 * SEC, 1],
    ["the child moves after the parent finished a later turn: still watching", "done", [{ active: true, lastActiveAt: now - MIN, lastWriteAt: now - MIN }], now, 1],
    ["the child stopped, the parent stopped before it (handed work over): grace period", "done", [stopped(now - MIN)], now - 2 * MIN, 0],
    ["the child stopped, the parent finished a turn after it: done", "done", [stopped(now - MIN)], now - 30 * SEC, undefined],
    ["the child stopped writing, the parent finished within 6 seconds (before the app last saw the child moving): done", "done", [stopped(now - 10 * SEC)], now - 5 * SEC, undefined],
    ["the parent finished a turn after the child, then the child moved again: grace period again", "done", [stopped(now - 16 * SEC)], now - 30 * SEC, 0],
    ["dozing parent that finished after the child: done", "dozing", [stopped(now - 4 * MIN)], now - 3 * MIN, undefined],
    ["the grace period is over: not watching", "done", [stopped(now - WATCH_GRACE_MS - 7 * SEC)], now - 10 * MIN, undefined],
    ["the parent's turn end unknown: the grace period as before", "done", [stopped(now - MIN)], undefined, 0],
    ["the child's last write unknown: the grace period as before", "done", [{ active: false, lastActiveAt: now - MIN }], now - 30 * SEC, 0],
    ["two children, the parent finished after one but before the other: grace period", "done", [stopped(now - 3 * MIN), stopped(now - MIN)], now - 2 * MIN, 0],
    ["two children, the parent finished after both: done", "done", [stopped(now - 3 * MIN), stopped(now - MIN)], now - 30 * SEC, undefined],
    ["two children, one's last write unknown: grace period", "done", [stopped(now - 3 * MIN), { active: false, lastActiveAt: now - MIN }], now - 30 * SEC, 0],
    ["no time known for the child: not watching", "done", [{ active: false }], now - MIN, undefined],
    ["the parent is working: not watching", "working", [{ active: true, lastActiveAt: now, lastWriteAt: now }], now, undefined],
  ];
  for (const [name, ownState, peers, ownTurnEndedAt, want] of rows) {
    test(name, () => expect(watchingCount(ownState, peers, now, ownTurnEndedAt)).toBe(want));
  }
});

// The user's cases (app-x, Claude desktop app). The parent's and the child's turn ends and states come from their
// transcripts through the production functions (readTail, lastWrittenAt, deriveState), the child's facts are remembered
// and read back as the app does (rememberPeerStates, peerMotion), polling every 2 seconds
const line = (day: string, hms: string, type: "user" | "assistant", text: string) => ({
  type,
  timestamp: new Date(Date.parse(`${day}T${hms}+09:00`)).toISOString(),
  message: { content: [{ type: "text", text }] },
});
function fileOf(name: string, lines: object[], lastModified: number): NativeFile {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return {
    path: `/tmp/${name}.jsonl`,
    name: `${name}.jsonl`,
    size: bytes.length,
    lastModified,
    slice: (start = 0, end = bytes.length) => ({
      text: async () => new TextDecoder().decode(bytes.slice(start < 0 ? bytes.length + start : start, end)),
    }),
  } as unknown as NativeFile;
}
type Line = ReturnType<typeof line>;
const writtenBy = (lines: Line[], now: number) => lines.filter((l) => Date.parse(l.timestamp) <= now);
/** A child that writes every 2 seconds from `from` and last writes at `to` (each a "HH:MM:SS") */
function childLines(day: string, from: string, to: string): Line[] {
  const lines = [line(day, from, "user", "親からの仕事")];
  for (let t = Date.parse(`${day}T${from}+09:00`) + 2 * SEC; t < Date.parse(`${day}T${to}+09:00`); t += 2 * SEC) {
    lines.push({ ...line(day, from, "assistant", "作業中"), timestamp: new Date(t).toISOString() });
  }
  lines.push(line(day, to, "assistant", "親に報告しました"));
  return lines;
}
async function stateOf(name: string, lines: Line[], now: number) {
  const tail = await readTail(fileOf(name, lines, now));
  const turnEndedAt = lastWrittenAt(tail, now);
  return { turnEndedAt, state: deriveState(tail, now - turnEndedAt, false) };
}
async function poll(parent: Line[], child: Line[], from: number, to: number) {
  const CHILD = "child-session";
  const childViewId = `claude/proj/${CHILD}.jsonl`;
  const watch = { liveBySessionId: new Map(), viewIdBySessionId: new Map([[CHILD, childViewId]]) } as unknown as WatchLinks;
  peerLastActiveAt.delete(CHILD);
  lastPeerStates.delete(CHILD);
  const polls: { time: number; state: BirdState; turnEndedAt: number; watching: number | undefined }[] = [];
  for (let now = from; now <= to; now += 2 * SEC) {
    const { state, turnEndedAt } = await stateOf("parent", writtenBy(parent, now), now);
    // The child's facts as the previous scan remembered them, as peerLinksOf reads them
    const watching = watchingCount(state, [peerMotion(CHILD, undefined)], now, turnEndedAt);
    polls.push({ time: now, state, turnEndedAt, watching });
    const childNow = await stateOf("child", writtenBy(child, now), now);
    rememberPeerStates([{ id: childViewId, state: childNow.state, sinceMs: now - childNow.turnEndedAt } as SessionView], watch, now);
  }
  peerLastActiveAt.delete(CHILD);
  lastPeerStates.delete(CHILD);
  return polls;
}

test("app-x 11-11: the parent leaves watching once it finished its turn at 20:13:07, after the child stopped", async () => {
  const day = "2026-11-11";
  const at = (hms: string) => Date.parse(`${day}T${hms}+09:00`);
  // The parent handed the work over at 20:10:00, took the child's report at 20:13:00 and finished its turn at 20:13:07
  const parent = [
    line(day, "20:09:50", "user", "子に任せて"),
    line(day, "20:10:00", "assistant", "子に渡しました"),
    line(day, "20:13:00", "user", "子の報告"),
    line(day, "20:13:07", "assistant", "受け取りました"),
  ];
  const polls = await poll(parent, childLines(day, "20:10:00", "20:12:37"), at("20:12:00"), at("20:18:00"));
  // Before it took the report, it was watching its child (moving, then in the grace period); the first poll has no previous
  // scan to read the child from, as right after the app starts
  expect(polls.filter((p) => p.time > at("20:12:00") && p.time < at("20:13:00")).every((p) => p.watching !== undefined)).toBe(true);
  // A write in the last 6 seconds counts as working, so its first done is 20:13:14; from then on it isn't watching,
  // with its turn's end read as 20:13:07
  const firstDone = polls.find((p) => p.time >= at("20:13:07") && p.state === "done");
  expect(firstDone).toEqual({ time: at("20:13:14"), state: "done", turnEndedAt: at("20:13:07"), watching: undefined });
  expect(polls.filter((p) => p.time >= at("20:13:14")).every((p) => p.watching === undefined)).toBe(true);
  // So the parent isn't continuing (the concierge's working white dot) from then on
  expect(sessionContinuing(undefined, firstDone?.watching, SEC).continuing).toBe(undefined);
});

test("app-x 11-12: the parent that finished its turn at 21:02:26, 5 seconds after the child's last write, leaves watching", async () => {
  const day = "2026-11-12";
  const at = (hms: string) => Date.parse(`${day}T${hms}+09:00`);
  // The child last wrote at 21:02:21; the parent took its report at 21:02:23 and finished its turn at 21:02:26, while the
  // app still saw the child working (its last write was less than 6 seconds before)
  const parent = [
    line(day, "20:58:00", "user", "子に任せて"),
    line(day, "20:58:10", "assistant", "子に渡しました"),
    line(day, "21:02:23", "user", "子の報告"),
    line(day, "21:02:26", "assistant", "受け取りました"),
  ];
  const polls = await poll(parent, childLines(day, "20:58:10", "21:02:21"), at("21:02:00"), at("21:04:00"));
  expect(polls.filter((p) => p.time > at("21:02:00") && p.time < at("21:02:23")).every((p) => p.watching !== undefined)).toBe(true);
  // Its first done is 21:02:32 (6 seconds after its last write); from that poll on it isn't watching
  const firstDone = polls.find((p) => p.time >= at("21:02:26") && p.state === "done");
  expect(firstDone).toEqual({ time: at("21:02:32"), state: "done", turnEndedAt: at("21:02:26"), watching: undefined });
  expect(polls.filter((p) => p.time >= at("21:02:32")).every((p) => p.watching === undefined)).toBe(true);
  // At 21:03:33 in the app log it was still continuing; now it isn't
  const at0333 = polls.find((p) => p.time >= at("21:03:32"));
  expect(sessionContinuing(undefined, at0333?.watching, SEC).continuing).toBe(undefined);
});
