// Gemini CLI transcript (~/.gemini/tmp/<project slug>/chats/session-*.jsonl) adapter
// (packages/core/src/services/chatRecordingService.ts and chatRecordingTypes.ts in google-gemini/gemini-cli).
// Lines: a metadata line, message records ({id, timestamp, type: user | gemini | info | error | warning, content,
// toolCalls}), and control lines. A message is appended again with the same id whenever its tool calls get
// results, and the later copy replaces the earlier one; `$rewindTo` drops a message and everything after it;
// `$patch` edits existing messages; `$set` updates the metadata. No line carries the cwd: the project folder is
// found from `<slug>/.project_root` or `~/.gemini/projects.json`. Not a public spec; checked against the source
// only (no Gemini CLI install was available)
import type { NativeDirectoryHandle, NativeFile } from "./native-fs";
import type { TailEvent, TailInfo } from "./transcript";
import {
  inputText,
  isRecord,
  latest,
  parseTime,
  readJsonlTail,
  replyText,
  str,
  tailFromEvents,
  userText,
  type JsonlLine,
} from "./agent-tail";

const FINISHED_TOOL = new Set(["success", "error", "cancelled"]);

/** Text of a PartListUnion (a string, a part, or a list of parts) */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((p) => (typeof p === "string" ? p : isRecord(p) && p.thought !== true ? (str(p.text) ?? "") : ""))
    .join("");
}

function applyPatch(messages: Map<string, Record<string, unknown>>, patch: Record<string, unknown>): void {
  const updates = [
    ...(str(patch.id) ? [patch] : []),
    ...(Array.isArray(patch.updates) ? patch.updates.filter(isRecord) : []),
  ];
  for (const update of updates) {
    const id = str(update.id);
    const message = id ? messages.get(id) : undefined;
    if (!id || !message) continue;
    const next = { ...message };
    if ("content" in update) next.content = update.content;
    if (Array.isArray(update.toolCalls) && Array.isArray(message.toolCalls)) {
      const results = new Map(update.toolCalls.filter(isRecord).map((c) => [str(c.id), c.result]));
      next.toolCalls = message.toolCalls
        .filter(isRecord)
        .map((c) => (results.has(str(c.id)) ? { ...c, result: results.get(str(c.id)) } : c));
    }
    messages.set(id, next);
  }
  if (Array.isArray(patch.removeIds)) for (const id of patch.removeIds) if (typeof id === "string") messages.delete(id);
  if (Array.isArray(patch.orderIds)) {
    for (const id of patch.orderIds) {
      const message = typeof id === "string" ? messages.get(id) : undefined;
      if (message && typeof id === "string") {
        messages.delete(id);
        messages.set(id, message);
      }
    }
  }
}

export function parseGeminiLines(lines: JsonlLine[], cwd?: string): TailInfo {
  // Insertion order is the message order; a re-appended id keeps its first position
  const messages = new Map<string, Record<string, unknown>>();
  const times: (number | undefined)[] = [];
  for (const { value: line } of lines) {
    if (typeof line.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const from = ids.indexOf(line.$rewindTo);
      // The loader clears everything when the id isn't found; in a tail window that only means it is older
      for (const id of from === -1 ? [] : ids.slice(from)) messages.delete(id);
      continue;
    }
    if (isRecord(line.$patch)) {
      applyPatch(messages, line.$patch);
      continue;
    }
    if (isRecord(line.$set)) {
      times.push(parseTime(line.$set.lastUpdated));
      continue;
    }
    const id = str(line.id);
    if (!id) continue;
    times.push(parseTime(line.timestamp));
    messages.set(id, line);
  }

  const events: TailEvent[] = [];
  for (const message of messages.values()) {
    const at = parseTime(message.timestamp);
    if (at === undefined) continue;
    const text = partsText(message.content);
    if (message.type === "user") {
      if (text) events.push({ at, kind: "user", text: userText(text) });
      continue;
    }
    if (message.type !== "gemini") continue;
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls.filter(isRecord) : [];
    if (calls.length === 0) {
      if (text) events.push({ at, kind: "assistant_text", text: replyText(text) });
      continue;
    }
    for (const call of calls) {
      const callAt = parseTime(call.timestamp) ?? at;
      events.push({ at: callAt, kind: "tool_use", toolName: str(call.name), text: inputText(call.args) });
      if (FINISHED_TOOL.has(str(call.status) ?? "")) events.push({ at: callAt, kind: "tool_result" });
    }
  }
  events.sort((a, b) => a.at - b.at);
  return tailFromEvents(events, { cwd, lastEventAt: latest([...times, ...events.map((e) => e.at)]) });
}

export async function readGeminiTail(file: NativeFile, cwd?: string): Promise<TailInfo> {
  return parseGeminiLines(await readJsonlTail(file), cwd);
}

/**
 * The project folder of `~/.gemini/tmp/<slug>`: the `.project_root` file Gemini CLI writes there, or the entry of
 * `~/.gemini/projects.json` (`{"projects": {"<path>": "<slug>"}}`) that names the slug
 */
export async function geminiProjectRoot(
  slugDir: NativeDirectoryHandle,
  projectsJson: string | undefined,
): Promise<string | undefined> {
  try {
    const text = (await (await slugDir.getFileHandle(".project_root")).getFile()).text();
    const root = (await text).trim();
    if (root) return root;
  } catch {
    // Older versions don't write it
  }
  if (!projectsJson) return undefined;
  try {
    const value = JSON.parse(projectsJson) as unknown;
    if (!isRecord(value) || !isRecord(value.projects)) return undefined;
    return Object.entries(value.projects).find(([, slug]) => slug === slugDir.name)?.[0];
  } catch {
    return undefined;
  }
}
