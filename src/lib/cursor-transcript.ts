// Cursor CLI transcript (~/.cursor/projects/<cwd slug>/agent-transcripts/<id>/<id>.jsonl) adapter. Lines are
// `{role: "user" | "assistant", message: {content: [{type: "text" | "tool_use", ...}]}}` and
// `{type: "turn_ended", status}` (measured with cursor-agent 2025.09.18). There are no timestamps, no tool
// results, and no cwd, so a line's time is the file's mtime when this app first read it (the exception to "mtime
// is not used", only for this adapter), and the cwd comes from the matched process. Not a public spec
import type { NativeFile } from "./native-fs";
import type { TailEvent, TailInfo } from "./transcript";
import { inputText, isRecord, readJsonlTail, replyText, str, tailFromEvents, userText, type JsonlLine } from "./agent-tail";

// Per file: the (size, mtime) of each read. A line ending at byte e was written by the first read whose size >= e
const readsByPath = new Map<string, { size: number; at: number }[]>();
const MAX_READS = 64;

export function lineTimesOf(path: string, size: number, mtime: number): (end: number) => number {
  let reads = readsByPath.get(path) ?? [];
  const last = reads[reads.length - 1];
  // A file that shrank was rewritten: forget what was seen
  if (last && size < last.size) reads = [];
  if (!last || size !== last.size || reads.length === 0) reads = [...reads, { size, at: mtime }].slice(-MAX_READS);
  readsByPath.set(path, reads);
  return (end) => reads.find((r) => r.size >= end)?.at ?? mtime;
}

export function forgetCursorFile(path: string): void {
  readsByPath.delete(path);
}

export function parseCursorLines(lines: JsonlLine[], timeOf: (end: number) => number, cwd?: string): TailInfo {
  const events: TailEvent[] = [];
  for (const { value: line, end } of lines) {
    const at = timeOf(end);
    if (line.type === "turn_ended") {
      const status = str(line.status);
      if (status === "aborted" || status === "cancelled") {
        events.push({ at, kind: "closed" });
      } else if (events[events.length - 1]?.kind !== "assistant_text") {
        events.push({ at, kind: "assistant_text" });
      }
      continue;
    }
    const content = isRecord(line.message) && Array.isArray(line.message.content) ? line.message.content.filter(isRecord) : [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => str(c.text) ?? "")
      .join("\n");
    if (line.role === "user") {
      if (text) events.push({ at, kind: "user", text: userText(text) });
      continue;
    }
    if (line.role !== "assistant") continue;
    const tool = content.filter((c) => c.type === "tool_use").at(-1);
    if (tool) events.push({ at, kind: "tool_use", toolName: str(tool.name), text: inputText(tool.input) });
    else if (text) events.push({ at, kind: "assistant_text", text: replyText(text) });
  }
  const lastAt = lines.length > 0 ? timeOf(lines[lines.length - 1].end) : undefined;
  return tailFromEvents(events, { cwd, lastEventAt: lastAt });
}

export async function readCursorTail(file: NativeFile): Promise<TailInfo> {
  const timeOf = lineTimesOf(file.path, file.size, file.lastModified);
  return parseCursorLines(await readJsonlTail(file), timeOf);
}

/** The project folder name Cursor derives from a cwd: every character other than letters and digits becomes "-" */
export function cursorProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-").replace(/^-+/, "");
}
