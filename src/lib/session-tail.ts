// Tail reads that reuse the cache (tailCache in lib/session-store.ts) while size and mtime are unchanged
import type { NativeFile } from "./native-fs";
import { readCodexTail, type CodexTailInfo } from "./codex-transcript";
import { readEventsInRange, readTail, TAIL_BYTES, type TailEvent, type TailInfo } from "./transcript";
import { tailCache, turnMessageCache } from "./session-store";
import { isPersonMessage } from "./session-snippet";

// Upper limit of the bytes appended between two polls that are scanned outside the tail window for user messages
const MAX_GAP_BYTES = 2 * 1024 * 1024;

/**
 * Tail read that reuses the cache when size and mtime are unchanged. Shared logic used by both
 * scanSessions (parents) and scanChicks (chicks) (the same pattern used to be duplicated in two places and
 * was merged). The parent side must call this before scanChicks — the chick completion check (the isChick
 * branch of deriveState) needs chickSignals from the parent tail
 * (see the comment in scanSessions for details).
 */
export async function readTailCached(
  id: string,
  file: NativeFile,
  opts?: { includeSidechain?: boolean },
): Promise<TailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.tail;
  }
  const tail = await readTail(file, opts);
  // Bytes appended since the last read that are already outside the tail window may hold user messages
  // (anger mark input). Scan only that gap. Main transcripts only (chicks have no user messages)
  if (cached && !opts?.includeSidechain && file.size - cached.size > TAIL_BYTES) {
    // Read on to the end of the file (overlapping the window) so a line cut at the window's start isn't lost
    const end = file.size - TAIL_BYTES;
    const events = await readEventsInRange(file, Math.max(cached.size, end - MAX_GAP_BYTES), file.size);
    feedTurnMessages(id, events);
  }
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

/** Most messages of one turn kept per session (the latest ones) */
const MAX_KEPT_USER_MESSAGES = 20;
/** Most messages sent with one turn verdict (the latest ones of the turn), each already cut at 500 characters by the
 * transcript readers (Claude's own decision: a turn with more messages than this is rare, and it bounds the request) */
export const MAX_TURN_USER_MESSAGES = 10;

/**
 * Reads transcript events in order and keeps the messages a person typed in the current turn (docs/design.md "Turn
 * verdicts", "Anger mark for abuse toward the AI"). A turn ends at an assistant text line after which the first line
 * that counts is a person's message or a command line the person started (a slash command or skill such as /push, a
 * ! command); user lines that aren't a person's (tool_result, a non-human origin, machine text) and interruptions are
 * skipped (isMeta lines never reach here). A tool_use line, and a text line followed by a tool_use, don't end a turn,
 * so a message sent while the agent works joins the same turn. The turn's messages are the person's messages after the
 * last turn end; a turn begun with a command line has none of the previous turn's (Claude's own decision). Decided
 * from the transcript order alone, so a text line seen as done in the middle of a turn and the real end of the turn
 * get the same messages. Events already read (the window is re-read on every poll) are skipped
 */
export function feedTurnMessages(id: string, events: TailEvent[]): void {
  let state = turnMessageCache.get(id);
  if (!state) {
    state = { messages: [], afterText: false, lastAt: Number.NEGATIVE_INFINITY, lastKeys: new Set() };
    turnMessageCache.set(id, state);
  }
  for (const e of events) {
    if (e.at < state.lastAt) continue;
    const key = `${e.kind}:${e.toolName ?? ""}:${e.text ?? ""}`;
    if (e.at === state.lastAt) {
      if (state.lastKeys.has(key)) continue;
      state.lastKeys.add(key);
    } else {
      state.lastAt = e.at;
      state.lastKeys = new Set([key]);
    }
    if (e.kind === "assistant_text") {
      state.afterText = true;
    } else if (e.kind === "tool_use") {
      state.afterText = false;
    } else if (isPersonMessage(e)) {
      const message = { at: e.at, text: e.text };
      state.messages = state.afterText ? [message] : [...state.messages, message].slice(-MAX_KEPT_USER_MESSAGES);
      state.afterText = false;
    } else if (e.kind === "user" && !e.machine && state.afterText) {
      state.messages = [];
      state.afterText = false;
    }
  }
}

/** The messages a person typed in the turn that ended with the reply at replyAt: the latest MAX_TURN_USER_MESSAGES,
 * oldest first. undefined when there are none */
export function turnUserMessages(id: string, replyAt: number): { at: number; text: string }[] | undefined {
  const messages = (turnMessageCache.get(id)?.messages ?? [])
    .filter((m) => m.at <= replyAt)
    .slice(-MAX_TURN_USER_MESSAGES);
  return messages.length > 0 ? messages : undefined;
}

/** Tail read of the other agents' adapters (lib/agents.ts), cached the same way */
export async function readTailCachedWith(
  id: string,
  file: NativeFile,
  read: (file: NativeFile) => Promise<TailInfo>,
): Promise<TailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) return cached.tail;
  const tail = await read(file);
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

export async function readCodexTailCached(id: string, file: NativeFile): Promise<CodexTailInfo> {
  const cached = tailCache.get(id);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) {
    return cached.tail as CodexTailInfo;
  }
  const tail = await readCodexTail(file);
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}
