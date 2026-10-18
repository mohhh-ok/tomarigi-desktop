// OpenCode adapter. OpenCode keeps sessions in SQLite (~/.local/share/opencode/opencode.db); the Rust side
// (src-tauri/src/opencode.rs) opens it read-only and returns each session's last messages with their parts cut
// down. Measured with opencode 1.19.0: message.data has role, time {created, completed}, finish ("stop" ends the
// reply, "tool-calls" goes on with tools) and error (MessageAbortedError on interrupt); parts are text / tool
// (state.status pending / running / completed / error) / step-start / step-finish / patch. The "question" tool is
// OpenCode asking the user. Not a public spec
import type { TailEvent, TailInfo } from "./transcript";
import { isRecord, replyText, str, tailFromEvents, userText } from "./agent-tail";

export interface OpenCodeMessage {
  id: string;
  timeCreated: number;
  timeUpdated: number;
  data: { role?: string; finish?: string | null; time?: { created?: number; completed?: number } | null; error?: string | null };
  parts: OpenCodePart[];
}

export interface OpenCodePart {
  type?: string | null;
  synthetic?: boolean | null;
  text?: { head: string; tail: string } | null;
  tool?: string | null;
  status?: string | null;
  input?: string | null;
  time?: { start?: number; end?: number } | null;
}

export interface OpenCodeSession {
  id: string;
  directory: string;
  parentId?: string | null;
  timeCreated: number;
  lastWriteAt: number;
}

const FINISHED_TOOL = new Set(["completed", "error"]);

export function parseOpenCodeMessages(messages: OpenCodeMessage[], session: OpenCodeSession): TailInfo {
  const events: TailEvent[] = [];
  for (const message of messages) {
    const created = message.data.time?.created ?? message.timeCreated;
    const texts = message.parts.filter((p) => p.type === "text" && p.synthetic !== true && p.text);
    if (message.data.role === "user") {
      const text = texts.map((p) => p.text?.head ?? "").join("\n");
      if (text) events.push({ at: created, kind: "user", text: userText(text) });
      continue;
    }
    if (message.data.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const start = isRecord(part.time) && typeof part.time.start === "number" ? part.time.start : created;
      events.push({ at: start, kind: "tool_use", toolName: part.tool ?? undefined, text: part.input ?? undefined });
      if (FINISHED_TOOL.has(part.status ?? "")) {
        const end = isRecord(part.time) && typeof part.time.end === "number" ? part.time.end : start;
        events.push({ at: end, kind: "tool_result" });
      }
    }
    const completed = message.data.time?.completed;
    if (completed === undefined) continue;
    if (message.data.error) {
      events.push({ at: completed, kind: "closed" });
    } else if (message.data.finish === "stop") {
      const text = texts.map((p) => p.text?.tail ?? "").join("\n");
      events.push({ at: completed, kind: "assistant_text", text: text ? replyText(text) : undefined });
    }
  }
  events.sort((a, b) => a.at - b.at);
  return tailFromEvents(events, { cwd: str(session.directory), lastEventAt: session.lastWriteAt });
}
