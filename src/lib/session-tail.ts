// Tail reads that reuse the cache (tailCache in lib/session-store.ts) while size and mtime are unchanged
import type { NativeFile } from "./native-fs";
import { readCodexTail, type CodexTailInfo } from "./codex-transcript";
import { readEventsInRange, readTail, TAIL_BYTES, type TailInfo } from "./transcript";
import { tailCache, userMessageCache } from "./session-store";
import { lastUserMessage } from "./session-snippet";

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
  // Bytes appended since the last read that are already outside the tail window may hold a user message
  // (anger mark input). Scan only that gap. Main transcripts only (chicks have no user messages)
  if (cached && !opts?.includeSidechain && file.size - cached.size > TAIL_BYTES) {
    // Read on to the end of the file (overlapping the window) so a line cut at the window's start isn't lost
    const end = file.size - TAIL_BYTES;
    const events = await readEventsInRange(file, Math.max(cached.size, end - MAX_GAP_BYTES), file.size);
    rememberUserMessage(id, lastUserMessage(events));
  }
  tailCache.set(id, { size: file.size, lastModified: file.lastModified, tail });
  return tail;
}

export function rememberUserMessage(id: string, message: { at: number; text: string } | undefined): void {
  if (message && message.at >= (userMessageCache.get(id)?.at ?? -1)) userMessageCache.set(id, message);
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
