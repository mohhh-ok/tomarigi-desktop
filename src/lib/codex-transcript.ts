import type { NativeFile } from "./native-fs";
// Codex transcript (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) adapter.
// The rollout format is an implementation detail and may change, so Codex-specific
// parsing stays here and the rest of the app consumes the shared TailInfo shape.

import type { TailEvent, TailInfo, TailKind } from "./transcript";

interface CodexEntry {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface MessageContent {
  type?: string;
  text?: string;
}

const TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TEXT_FIELD_LIMIT = 500;
const ASSISTANT_TEXT_LIMIT = 2000;

/** Codex metadata needed by the date-based session scanner. */
export interface CodexTailInfo extends TailInfo {
  sessionId?: string;
  threadSource?: string;
  parentThreadId?: string;
  agentName?: string;
}

export async function readCodexTail(file: NativeFile): Promise<CodexTailInfo> {
  const head = await file.slice(0, Math.min(HEAD_BYTES, file.size)).text();
  const metadata = readMetadata(head);

  const cap = Math.min(MAX_TAIL_BYTES, file.size);
  let windowBytes = TAIL_BYTES;
  let result = await readWindow(file, windowBytes);
  while (result.lastEventAt === undefined && windowBytes < cap) {
    windowBytes = Math.min(windowBytes * 2, cap);
    result = await readWindow(file, windowBytes);
  }

  return { ...result, ...metadata, cwd: result.cwd ?? metadata.cwd };
}

function readMetadata(text: string): Partial<CodexTailInfo> {
  for (const line of text.split("\n")) {
    const entry = parseLine(line);
    if (entry?.type !== "session_meta") continue;
    const payload = entry.payload ?? {};
    const source = payload.source;
    const subagent = isRecord(source) && isRecord(source.subagent) ? source.subagent : undefined;
    const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
    return {
      cwd: stringValue(payload.cwd),
      sessionId: stringValue(payload.id),
      threadSource: stringValue(payload.thread_source),
      parentThreadId: stringValue(spawn?.parent_thread_id),
      agentName: stringValue(spawn?.agent_nickname) ?? lastPathPart(stringValue(spawn?.agent_path)),
    };
  }
  return {};
}

async function readWindow(file: NativeFile, windowBytes: number): Promise<TailInfo> {
  const truncated = file.size > windowBytes;
  const text = await file.slice(Math.max(0, file.size - windowBytes)).text();
  const lines = text.split("\n");
  if (truncated) lines.shift();

  let kind: TailKind = "unknown";
  let toolName: string | undefined;
  let cwd: string | undefined;
  let lastEventAt: number | undefined;
  const events: TailEvent[] = [];

  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;
    const at = parseTimestamp(entry.timestamp);
    if (at !== null) lastEventAt = lastEventAt === undefined ? at : Math.max(lastEventAt, at);

    if (entry.type === "turn_context") {
      cwd = stringValue(entry.payload?.cwd) ?? cwd;
    }

    const next = classify(entry);
    if (!next) continue;
    kind = next.kind;
    toolName = next.toolName;
    if (at !== null) events.push({ at, ...next });
  }

  // Codex has no cross-session messaging, so watching links (peerNames) are always empty
  return {
    kind,
    toolName,
    events,
    cwd,
    lastEventAt,
    chickSignals: new Map(),
    backgroundTaskStarts: new Map(),
    peerNames: new Map(),
  };
}

function classify(entry: CodexEntry): Omit<TailEvent, "at"> | null {
  const payload = entry.payload ?? {};
  if (entry.type === "response_item") {
    const type = stringValue(payload.type);
    if (type === "message" && payload.role === "user") {
      const text = extractMessageText(payload.content, TEXT_FIELD_LIMIT, false);
      if (!text || isMachineContext(text)) return null;
      return { kind: "user", text };
    }
    if (type === "custom_tool_call" || type === "function_call") {
      // The start of arguments (a JSON string) is used to extract the question text of request_user_input (extractQuestion in lib/session-snippet.ts)
      return {
        kind: "tool_use",
        toolName: stringValue(payload.name),
        text: stringValue(payload.arguments)?.slice(0, TEXT_FIELD_LIMIT),
      };
    }
    if (type === "custom_tool_call_output" || type === "function_call_output") {
      return { kind: "tool_result" };
    }
    return null;
  }

  if (entry.type !== "event_msg") return null;
  const type = stringValue(payload.type);
  if (type === "task_complete") {
    const text = stringValue(payload.last_agent_message)?.slice(-ASSISTANT_TEXT_LIMIT);
    return { kind: "assistant_text", text };
  }
  if (type === "turn_aborted") return { kind: "closed" };
  return null;
}

function extractMessageText(content: unknown, limit: number, fromEnd: boolean): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = (content as MessageContent[])
    .filter((item) => item.type === "input_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (!text) return undefined;
  return fromEnd ? text.slice(-limit) : text.slice(0, limit);
}

function isMachineContext(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context>") || trimmed.startsWith("<turn_aborted>");
}

function parseLine(line: string): CodexEntry | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? (value as CodexEntry) : null;
  } catch {
    return null;
  }
}

function parseTimestamp(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const at = Date.parse(timestamp);
  return Number.isNaN(at) ? null : at;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function lastPathPart(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split("/").filter(Boolean).at(-1);
}
