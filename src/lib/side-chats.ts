// Side chats of the Claude desktop app (`btw`, docs/design.md "Side chats and forked sessions of the Claude desktop
// app"): a side chat runs as a session of its own, with its own process, sessions/<pid>.json and transcript, but it
// appears nowhere. It is told by the desktop app's record of the session (`spawnedFrom.btw`, desktop_side_chats in
// src-tauri), and dropped where Claude Code sessions are listed (claude in lib/agents.ts)
import { invoke } from "@tauri-apps/api/core";
import type { LiveSession } from "./session-types";
import { sessionEventCache, sideChatByHostId } from "./session-store";

/** The `local_…` id a side chat's record is named by when its process isn't seen yet: a side chat's id is its
    transcript's (both side chats on this machine) */
export const hostIdOfTranscript = (sessionId: string): string => `local_${sessionId}`;

/** The live sessions' desktop ids not answered yet (a record's answer never changes, so each id is asked once) */
export function hostIdsToAsk(live: readonly LiveSession[], answers: ReadonlyMap<string, boolean>): string[] {
  const ids = new Set<string>();
  for (const l of live) if (l.hostSessionId && !answers.has(l.hostSessionId)) ids.add(l.hostSessionId);
  return [...ids];
}

/**
 * Whether a transcript (its session id) is a side chat's: its live session's desktop id, or without a live session its
 * own `local_<id>`, was answered as a side chat. Not answered (no record yet, unreadable): not one, so it is shown as
 * usual until the record is read
 */
export function isSideChat(
  sessionId: string,
  liveBySessionId: ReadonlyMap<string, LiveSession>,
  answers: ReadonlyMap<string, boolean>,
): boolean {
  const host = liveBySessionId.get(sessionId)?.hostSessionId ?? hostIdOfTranscript(sessionId);
  return answers.get(host) === true;
}

/** Asks the desktop app's records about the ids and keeps the answers (sideChatByHostId). An id whose record wasn't
    read isn't kept, so it is asked again on the next load */
export async function askSideChats(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const scan = await invoke<{ answers: [string, boolean][]; reliable: boolean }>("desktop_side_chats", {
    ids,
  }).catch(() => ({ answers: [] as [string, boolean][], reliable: false }));
  for (const [id, sideChat] of scan.answers) sideChatByHostId.set(id, sideChat);
}

/** Removes what side chats already left in Recent activity (a bird shown before its record was read). Like the
    rows of a session whose process ended (settleLiveness), only the in-memory Recent activity; leaving makes no event */
export function forgetSideChats(viewIds: ReadonlySet<string>): void {
  if (viewIds.size === 0) return;
  for (const [key, event] of sessionEventCache) if (viewIds.has(event.sessionId)) sessionEventCache.delete(key);
}
