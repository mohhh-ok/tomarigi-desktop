// GitHub Copilot CLI transcript (~/.copilot/session-state/<sessionId>/events.jsonl) adapter. One event per line,
// `{type, data, id, timestamp, parentId}` (the event types are github/copilot-sdk's generated session-events.ts;
// ephemeral events such as user_input.requested are never written). Not a public spec; checked against the
// source and a published capture only (no Copilot CLI install was available)
import type { NativeFile } from "./native-fs";
import type { TailEvent, TailInfo } from "./transcript";
import {
  inputText,
  isRecord,
  latest,
  parseTime,
  readJsonlHead,
  readJsonlTail,
  replyText,
  str,
  tailFromEvents,
  userText,
  type JsonlLine,
} from "./agent-tail";

function cwdOf(event: Record<string, unknown>): string | undefined {
  if (event.type !== "session.start" && event.type !== "session.resume") return undefined;
  const data = isRecord(event.data) ? event.data : {};
  return isRecord(data.context) ? str(data.context.cwd) : undefined;
}

export function parseCopilotLines(lines: JsonlLine[], headCwd?: string): TailInfo {
  const events: TailEvent[] = [];
  let cwd = headCwd;
  const times: (number | undefined)[] = [];
  for (const { value: event } of lines) {
    const at = parseTime(event.timestamp);
    times.push(at);
    cwd = cwdOf(event) ?? cwd;
    // Events of subagents carry agentId; the bird follows the main agent only
    if (at === undefined || event.agentId !== undefined) continue;
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "user.message": {
        const text = str(data.content);
        if (text) events.push({ at, kind: "user", text: userText(text) });
        break;
      }
      case "assistant.message": {
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests.filter(isRecord) : [];
        const request = requests.at(-1);
        if (request) {
          events.push({ at, kind: "tool_use", toolName: str(request.name), text: inputText(request.arguments) });
        } else if (str(data.content)) {
          events.push({ at, kind: "assistant_text", text: replyText(str(data.content) ?? "") });
        }
        break;
      }
      case "tool.execution_start":
        events.push({ at, kind: "tool_use", toolName: str(data.toolName), text: inputText(data.arguments) });
        break;
      case "tool.execution_complete":
        events.push({ at, kind: "tool_result" });
        break;
      case "abort":
      case "session.shutdown":
        events.push({ at, kind: "closed" });
        break;
    }
  }
  return tailFromEvents(events, { cwd, lastEventAt: latest(times) });
}

/** The cwd the session started in (session.start, the first line) */
export async function readCopilotStartCwd(file: NativeFile): Promise<string | undefined> {
  for (const { value } of await readJsonlHead(file)) {
    const cwd = cwdOf(value);
    if (cwd) return cwd;
  }
  return undefined;
}

export async function readCopilotTail(file: NativeFile, headCwd?: string): Promise<TailInfo> {
  return parseCopilotLines(await readJsonlTail(file), headCwd);
}
