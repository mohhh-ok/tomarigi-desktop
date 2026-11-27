import type { NativeFile } from "./native-fs";
import type { TailKind, TranscriptReadOptions } from "./transcript";
import { asBlocks, isForeignLine, parseTimestamp, taskNotificationOf, TASK_NOTIFICATION_TAG, type TranscriptEntry } from "./transcript-entry";
// What a parent's and a chick's transcript lines say about a chick's end (TailInfo.chickSignals, toolOpen, handedBack;
// docs/design/finished-chicks.md "Chicks that have finished")

const CHICK_SIGNAL_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Collects chick completion signals (the same collectChickSignals as TailInfo.chickSignals) from the whole
 * transcript from start, not just the tail window. A long-lived parent's completion records scroll out of the
 * tail window, and a chick is shown until its completion is recorded (docs/design/removing-ended-birds.md "Removing birds of ended
 * sessions"), so scanChicks (lib/session-chicks.ts) keeps the result across scans and reads only what was appended. end is the
 * position read up to; a last line cut off midway is left for the next read
 */
export async function scanChickSignals(
  file: NativeFile,
  start: number,
  opts?: TranscriptReadOptions,
): Promise<{ signals: Map<string, number>; end: number }> {
  const signals = new Map<string, number>();
  let pos = start;
  while (pos < file.size) {
    const text = await file.slice(pos, Math.min(file.size, pos + CHICK_SIGNAL_CHUNK_BYTES)).text();
    const cut = text.lastIndexOf("\n");
    if (cut < 0) {
      // A single line longer than the chunk: read it whole
      if (pos + CHICK_SIGNAL_CHUNK_BYTES < file.size) {
        const whole = await file.slice(pos).text();
        const lineEnd = whole.indexOf("\n");
        if (lineEnd < 0) break;
        collectLine(whole.slice(0, lineEnd), signals);
        pos += new TextEncoder().encode(whole.slice(0, lineEnd + 1)).length;
        continue;
      }
      break;
    }
    const complete = text.slice(0, cut + 1);
    for (const line of complete.split("\n")) collectLine(line, signals);
    pos += new TextEncoder().encode(complete).length;
  }
  return { signals, end: pos };

  function collectLine(line: string, out: Map<string, number>): void {
    if (!mayCarryChickSignal(line)) return;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (isForeignLine(entry, opts?.ownSessionId)) return;
    const at = parseTimestamp(entry.timestamp);
    if (at !== null) collectChickSignals(entry, at, out);
  }
}


/** The tool a chick calls to hand its report back to its caller and stop (Claude Code, docs/design/finished-chicks.md "Chicks that
    have finished") */
const HAND_BACK_TOOL = "SubagentHandback";
// The parent's record of a chick's hand-back: a queue-operation whose content starts with
// `<agent-message from="<the chick's id>">` and this
export const HAND_BACK_MARKER = "[Subagent hand-back]";
const HAND_BACK_MESSAGE = new RegExp(`^<agent-message from="([^"]+)">\\s*${HAND_BACK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

// What a line has to contain for collectChickSignals to find a signal in it, so the whole-transcript scan skips JSON.parse
// for the rest. Kept next to collectChickSignals: a signal it learns has to be added here too, or the scan misses it
// once the line leaves the tail window
const CHICK_SIGNAL_MARKERS = [TASK_NOTIFICATION_TAG, "tool_result", HAND_BACK_MARKER];

function mayCarryChickSignal(line: string): boolean {
  return CHICK_SIGNAL_MARKERS.some((m) => line.includes(m));
}

/**
 * Picks up definitive signals that a chick (subagent) has stopped from queue-operation lines and
 * user (tool_result) lines, and adds them to out (key = chick identifier, value = its timestamp).
 * Uses the at (= entry.timestamp) computed by the caller (readTail) as is.
 */
export function collectChickSignals(entry: TranscriptEntry, at: number, out: Map<string, number>): void {
  if (entry.type === "queue-operation") {
    // Signal that a background chick finished. <task-notification> fires every time an agent stops
    // (after a resume it can fire multiple times with the same task-id), so always overwrite with the
    // latest at. The status value is not checked (anything other than completed is also treated as a
    // "that chick stopped" signal. See the TailInfo.chickSignals comment for details).
    // content can be present on any of the enqueue/remove/dequeue operations (dequeue is often empty,
    // but if absent nothing happens, so no harm).
    // Completion notices of background commands such as Bash (task-notification itself is not specific
    // to Task/Agent) also pass through here. scanChicks ignores them because there is no chick file, and
    // backgroundTaskCache in lib/session-store.ts uses them as background task completion
    const n = taskNotificationOf(entry.content);
    if (n) out.set(n.taskId, at);
    const handBack = typeof entry.content === "string" ? entry.content.match(HAND_BACK_MESSAGE)?.[1] : undefined;
    if (handBack) out.set(handBack, at);
    return;
  }
  if (entry.type === "user") {
    // Signal that a synchronous call (a blocking Task/Agent call) finished. The time a tool_result arrives
    // whose tool_use_id matches toolUseId in the chick's meta.json is the completion time as is.
    // However, the Agent tool's async launch confirmation (toolUseResult.isAsync===true) returns right
    // after launch with the same tool_use_id but is not a completion, so it is excluded (see the
    // TranscriptEntry.toolUseResult comment)
    if (entry.toolUseResult?.isAsync) return;
    const blocks = asBlocks(entry.message?.content);
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") out.set(b.tool_use_id, at);
    }
  }
}

export function trackTools(entry: TranscriptEntry, open: Set<string>): void {
  for (const b of asBlocks(entry.message?.content)) {
    if (entry.type === "assistant" && b.type === "tool_use" && b.id) open.add(b.id);
    else if (entry.type === "user" && b.type === "tool_result" && b.tool_use_id) open.delete(b.tool_use_id);
  }
}

/** The id of the hand-back the conversation ends on after this line, or undefined */
export function handBackOf(entry: TranscriptEntry, kind: TailKind, current: string | undefined): string | undefined {
  const blocks = asBlocks(entry.message?.content);
  if (kind === "tool_use") {
    const call = blocks.findLast((b) => b.type === "tool_use");
    return call?.name === HAND_BACK_TOOL ? (call.id ?? "") : undefined;
  }
  // Only the hand-back's own result keeps it; a result of another call means the chick went on
  if (kind === "tool_result" && current !== undefined && blocks.every((b) => b.type !== "tool_result" || b.tool_use_id === current)) return current;
  return undefined;
}
