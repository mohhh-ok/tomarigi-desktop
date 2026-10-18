// Shared pieces of the transcript adapters added for docs/design.md "Agents" (Qwen Code, Copilot CLI, Gemini CLI,
// OpenCode, Cursor CLI). Each adapter turns its own format into TailEvents and builds the shared TailInfo with
// tailFromEvents; deriveState and everything after it don't know which agent a session is
import type { NativeFile } from "./native-fs";
import type { TailEvent, TailInfo } from "./transcript";

export const USER_TEXT_LIMIT = 500;
export const ASSISTANT_TEXT_LIMIT = 2000;
const TAIL_BYTES = 64 * 1024;
// Same as transcript.ts: widen the window while it holds no complete line (a huge line near the end)
const MAX_TAIL_BYTES = 2 * 1024 * 1024;

export function tailFromEvents(events: TailEvent[], fields: { cwd?: string; lastEventAt?: number } = {}): TailInfo {
  const last = events[events.length - 1];
  return {
    kind: last?.kind ?? "unknown",
    toolName: last?.kind === "tool_use" ? last.toolName : undefined,
    events,
    cwd: fields.cwd,
    lastEventAt: fields.lastEventAt,
    // Subagents, background tasks, and cross-session links are Claude Code only
    chickSignals: new Map(),
    backgroundTaskStarts: new Map(),
    peerNames: new Map(),
  };
}

export interface JsonlLine {
  value: Record<string, unknown>;
  end: number; // byte offset just after the line, in the file
}

/** Parses the complete lines of text, which starts at byte offset start of the file */
export function parseJsonl(text: string, start = 0, dropFirst = false): JsonlLine[] {
  const out: JsonlLine[] = [];
  const encoder = new TextEncoder();
  let offset = start;
  const lines = text.split("\n");
  // The last piece has no newline after it: a line still being written
  const complete = lines.slice(0, -1);
  complete.forEach((line, i) => {
    offset += encoder.encode(line).length + 1;
    if (dropFirst && i === 0) return;
    const value = parseObject(line);
    if (value) out.push({ value, end: offset });
  });
  return out;
}

/** The complete JSON lines in the last 64KB of a JSONL file (widened up to 2MB while none parse) */
export async function readJsonlTail(file: NativeFile): Promise<JsonlLine[]> {
  let windowBytes = TAIL_BYTES;
  for (;;) {
    const start = Math.max(0, file.size - windowBytes);
    const text = await file.slice(start).text();
    const lines = parseJsonl(text, start, start > 0);
    if (lines.length > 0 || windowBytes >= Math.min(MAX_TAIL_BYTES, file.size)) return lines;
    windowBytes = Math.min(windowBytes * 2, MAX_TAIL_BYTES);
  }
}

/** The complete JSON lines in the first bytes of a file (for a header line such as the session's cwd) */
export async function readJsonlHead(file: NativeFile, bytes = 16 * 1024): Promise<JsonlLine[]> {
  const text = await file.slice(0, Math.min(bytes, file.size)).text();
  return parseJsonl(file.size <= bytes ? `${text}\n` : text);
}

export function parseObject(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseTime(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

/** Tool input as the head of its JSON (extractQuestion in lib/session-snippet.ts reads "question" from it) */
export function inputText(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text?.slice(0, USER_TEXT_LIMIT);
}

export const userText = (text: string) => text.slice(0, USER_TEXT_LIMIT);
export const replyText = (text: string) => text.slice(-ASSISTANT_TEXT_LIMIT);

/** The latest time over the events and any other timed lines */
export function latest(times: (number | undefined)[]): number | undefined {
  const known = times.filter((t): t is number => t !== undefined);
  return known.length === 0 ? undefined : Math.max(...known);
}
