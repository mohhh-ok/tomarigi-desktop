import { asBlocks, messageText, toolResultText, type TranscriptEntry } from "./transcript-entry";
// The sessions a session exchanged messages with, and where its turns start, from its transcript lines (TailInfo.peerNames,
// turnSends; docs/design/watching.md "Watching")

const CROSS_SESSION_FROM_NAME = /<cross-session-message\b[^>]*\bfrom-name="([^"]+)"/g;
// The Claude desktop app's session id, the address of its sessions (docs/design/watching.md "Watching")
const HOST_SESSION_ID = /^local_[0-9a-fA-F-]+$/;
// The text of the desktop app's start_session result: `Started session "…" (session_id: local_…, …)`
const STARTED_SESSION_ID = /^Started session [\s\S]*?\(session_id: (local_[0-9a-fA-F-]+)[,)]/;
// The shared notes folder the desktop app names in the first prompt of a session another session started:
// `…/side-session-notes/local_…`, the starter's id
const NOTES_FOLDER_ID = /side-session-notes\/(local_[0-9a-fA-F-]+)/;

function hostSessionIdOf(value: unknown): string | undefined {
  return typeof value === "string" && HOST_SESSION_ID.test(value) ? value : undefined;
}


/**
 * Whether a prompt's turnOrigin says the app wrote it, not the user: anything but "human" (the desktop app's "sdk" /
 * "host_synthetic", another session's "peer", ...). Same rule as written_by_app in src-tauri
 */
export function writtenByApp(turnOrigin: unknown): boolean {
  return typeof turnOrigin === "string" && turnOrigin !== "human";
}

/**
 * The starter's id the desktop app names in the first prompt of a session another session started: its shared notes
 * folder, `…/side-session-notes/local_…` (docs/design/watching.md "Watching"). Only for the transcript's first prompt (a user
 * line that isn't meta or a subagent's), and only when the app wrote it: a later notice may quote another folder
 */
export function firstPromptStarterOf(entry: TranscriptEntry): string | undefined {
  if (!writtenByApp(entry.turnOrigin)) return undefined;
  return messageText(entry.message?.content).match(NOTES_FOLDER_ID)?.[1];
}

/** Whether a line is the kind the first prompt is: a user line, not meta, not a subagent's (as scan_peer_names) */
export function isFirstPromptCandidate(entry: TranscriptEntry): boolean {
  return entry.type === "user" && entry.isMeta !== true && entry.isSidechain !== true && typeof entry.timestamp === "string";
}

/** Drops the display " [ref]" from a SendMessage recipient name (the ListAgents format; SendMessage in the docs) */
function peerNameOf(to: string): string | undefined {
  const name = to.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  // "main" (the parent conversation) and agent ids (a...-...) are not cross-session links
  if (!name || name === "main") return undefined;
  return name;
}

/**
 * Gets, from one line, the names of peers exchanged with via cross-session messages (TailInfo.peerNames).
 * Sent: input.to of the assistant's SendMessage tool_use. Received: origin.name on the isMeta user line
 * (when kind is "peer"), otherwise <cross-session-message from-name="…"> in the body. Messages that arrived
 * mid-work: origin.name of the attachment (queued_command). The Claude desktop app's sessions also give their
 * local_… id: origin.from of a received message, session_id of the app's send_message, and the id in the text of
 * its start_session result; they are matched against hostSessionId. Same rules as scan_peer_names in src-tauri
 */
export function collectPeerNames(entry: TranscriptEntry): string[] {
  const names: string[] = [];
  if (entry.type === "assistant") {
    names.push(...sentPeerNamesOf(entry));
  } else if (entry.type === "attachment") {
    const origin = entry.attachment?.origin;
    if (origin?.kind === "peer" && typeof origin.name === "string" && origin.name) names.push(origin.name);
    const from = origin?.kind === "peer" ? hostSessionIdOf(origin.from) : undefined;
    if (from) names.push(from);
  } else if (entry.type === "user" && entry.isMeta) {
    if (entry.origin?.kind === "peer" && typeof entry.origin.name === "string" && entry.origin.name) {
      names.push(entry.origin.name);
      const from = hostSessionIdOf(entry.origin.from);
      if (from) names.push(from);
    } else {
      for (const m of messageText(entry.message?.content).matchAll(CROSS_SESSION_FROM_NAME)) names.push(m[1]);
    }
  } else if (entry.type === "user") {
    // The tool result that started a desktop app session carries its id in the text
    for (const block of asBlocks(entry.message?.content)) {
      if (block.type !== "tool_result") continue;
      const id = toolResultText(block).match(STARTED_SESSION_ID)?.[1];
      if (id) names.push(id);
    }
  }
  return names;
}

/** The sessions an assistant line sends a message to: input.to of SendMessage, session_id of the desktop app's
 * send_message (collectPeerNames, TailInfo.turnSends) */
export function sentPeerNamesOf(entry: TranscriptEntry): string[] {
  if (entry.type !== "assistant") return [];
  const names: string[] = [];
  for (const block of asBlocks(entry.message?.content)) {
    if (block.type !== "tool_use") continue;
    const input = block.input as { to?: unknown; session_id?: unknown } | undefined;
    const name =
      block.name === "SendMessage"
        ? typeof input?.to === "string"
          ? peerNameOf(input.to)
          : undefined
        : block.name?.endsWith("__send_message")
          ? hostSessionIdOf(input?.session_id)
          : undefined;
    if (name) names.push(name);
  }
  return names;
}

/**
 * Whether a line is a prompt that starts a turn, as turn_starter in src-tauri reads it: a user line, not a subagent's
 * or a tool result, and not meta unless it is a message from another session; a line that says nothing of where it came
 * from (no turnOrigin, no origin.kind) isn't counted. What arrives while it works is an attachment and doesn't start one
 */
export function startsTurn(entry: TranscriptEntry): boolean {
  if (entry.type !== "user" || entry.isSidechain) return false;
  const turnOrigin = typeof entry.turnOrigin === "string" ? entry.turnOrigin : undefined;
  const originKind = typeof entry.origin?.kind === "string" ? entry.origin.kind : undefined;
  if (entry.isMeta && turnOrigin !== "peer" && originKind !== "peer") return false;
  if (asBlocks(entry.message?.content).some((b) => b.type === "tool_result")) return false;
  return turnOrigin !== undefined || originKind !== undefined;
}
