// 見守り中の判定(docs/design.md の見守り中)。別のセッションに作業を任せて待っている鳥を、相手のターンの合間に
// 巣箱へしまわないための猶予を持つ。画面の部品や Tauri に依存しない(時刻を渡して確かめられる)
import type { BirdState } from "./sessions";

/** 相手が最後に動いてから、この間は見守り中のまま(巣箱にしまわない)。ユーザーが選んだ案(A) */
export const WATCH_GRACE_MS = 5 * 60_000;

/**
 * 相手が動いているか。sessions/<pid>.json の status が idle 以外(busy・shell など)、または相手の画面の
 * 機械判定が working / waiting。status "shell" なども動いているに数える(ユーザーが選んだ案(C))
 */
export function isPeerActive(status: string | undefined, lastState: BirdState | undefined): boolean {
  return (status !== undefined && status !== "idle") || lastState === "working" || lastState === "waiting";
}

/**
 * 見守り中なら、今動いている相手の数(0 以上)。見守り中でなければ undefined。
 * 自分の機械判定が done / dozing で、相手のうち今動いているものがいるか、最後に動いてから WATCH_GRACE_MS 以内の
 * ものがいれば見守り中。0 は「猶予の間で、今動いている相手はいない」
 */
export function watchingCount(
  ownState: BirdState,
  peers: { active: boolean; lastActiveAt?: number }[],
  now: number,
): number | undefined {
  if (ownState !== "done" && ownState !== "dozing") return undefined;
  const moving = peers.filter((p) => p.active).length;
  if (moving > 0) return moving;
  const recent = peers.some((p) => p.lastActiveAt !== undefined && now - p.lastActiveAt <= WATCH_GRACE_MS);
  return recent ? 0 : undefined;
}
