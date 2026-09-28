// Watching detection (docs/design.md "Watching"). Keeps a grace period so a bird that handed work to another session and is waiting
// isn't put into the nest between the other session's turns. Doesn't depend on UI components or Tauri (can be checked by passing a time)
import type { BirdState } from "./sessions";

/** For this long after the linked session last moved, it stays watching (not put into the nest) */
export const WATCH_GRACE_MS = 5 * 60_000;

/**
 * Whether the linked session is moving. status in sessions/<pid>.json is anything but idle (busy, shell, etc.), or the linked session's
 * machine state is working / waiting. status "shell" and the like also count as moving
 */
export function isPeerActive(status: string | undefined, lastState: BirdState | undefined): boolean {
  return (status !== undefined && status !== "idle") || lastState === "working" || lastState === "waiting";
}

/**
 * If watching, the number of linked sessions moving now (0 or more). undefined if not watching.
 * Watching when its own machine state is done / dozing and some linked session is moving now, or one moved within WATCH_GRACE_MS
 * of now. 0 means "within the grace period, with no linked session moving now"
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
