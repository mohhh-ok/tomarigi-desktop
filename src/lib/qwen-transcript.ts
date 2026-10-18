// Qwen Code transcript (~/.qwen/projects/<sanitized cwd>/chats/<sessionId>.jsonl) adapter. One ChatRecord per
// line (packages/core/src/services/chatRecordingService.ts in QwenLM/qwen-code): type user / assistant /
// tool_result / system, an ISO timestamp and cwd on every line, and the message in Gemini's Content shape
// (parts with text / functionCall / functionResponse). Not a public spec; checked against the source only
// (no Qwen Code install was available)
import type { NativeFile } from "./native-fs";
import type { TailEvent, TailInfo } from "./transcript";
import { inputText, isRecord, latest, parseTime, readJsonlTail, replyText, str, tailFromEvents, userText, type JsonlLine } from "./agent-tail";

// user-typed records that aren't a new prompt from the person (cron prompts, background notifications)
const MACHINE_USER_SUBTYPES = new Set(["cron", "notification", "background_task_completed"]);

export function parseQwenLines(lines: JsonlLine[]): TailInfo {
  const events: TailEvent[] = [];
  let cwd: string | undefined;
  const times: (number | undefined)[] = [];
  for (const { value: record } of lines) {
    const at = parseTime(record.timestamp);
    times.push(at);
    cwd = str(record.cwd) ?? cwd;
    if (at === undefined || record.isSidechain === true) continue;
    const parts = isRecord(record.message) && Array.isArray(record.message.parts) ? record.message.parts.filter(isRecord) : [];
    const subtype = str(record.subtype);
    if (record.type === "user") {
      const text = parts.map((p) => str(p.text)).filter(Boolean).join("\n");
      if (!text) continue;
      const machine = subtype !== undefined && MACHINE_USER_SUBTYPES.has(subtype);
      events.push({ at, kind: "user", text: userText(text), ...(machine ? { machine: true } : {}) });
    } else if (record.type === "assistant") {
      const call = parts.map((p) => p.functionCall).filter(isRecord).at(-1);
      if (call) {
        events.push({ at, kind: "tool_use", toolName: str(call.name), text: inputText(call.args) });
        continue;
      }
      const text = parts
        .filter((p) => p.thought !== true)
        .map((p) => str(p.text))
        .filter(Boolean)
        .join("");
      if (text) events.push({ at, kind: "assistant_text", text: replyText(text) });
    } else if (record.type === "tool_result") {
      events.push({ at, kind: "tool_result" });
    } else if (record.type === "system" && subtype === "turn_result" && isRecord(record.systemPayload)) {
      if (record.systemPayload.state === "cancelled") events.push({ at, kind: "closed" });
    }
  }
  return tailFromEvents(events, { cwd, lastEventAt: latest(times) });
}

export async function readQwenTail(file: NativeFile): Promise<TailInfo> {
  return parseQwenLines(await readJsonlTail(file));
}

/** `<sessionId>.runtime.json` (packages/core/src/utils/runtimeStatus.ts): written for outside tools, kept after exit */
export function parseQwenRuntime(text: string): { pid: number; sessionId: string; workDir?: string } | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || typeof value.pid !== "number" || typeof value.session_id !== "string") return undefined;
    return { pid: value.pid, sessionId: value.session_id, workDir: str(value.work_dir) };
  } catch {
    return undefined;
  }
}
