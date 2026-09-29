// Text taken from the transcript for display: the prompt snippet, the latest user message, the question text
import type { TailEvent, TailInfo } from "./transcript";

const SNIPPET_MAX_WIDTH = 24; // max display width (in half-width units). Overflow becomes "…"

// Full-width characters (CJK, kana, etc.) are about twice as wide as half-width ones, so counting code points
// makes the display width differ between Japanese and English. Count in half-width units (full-width = 2,
// half-width = 1). The approximation "everything except ASCII and half-width kana is full-width" is enough
// (snippets don't need exact layout calculation)
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= 0xff) return 1; // ASCII, Latin-1
  if (code >= 0xff61 && code <= 0xffdc) return 1; // half-width kana
  return 2;
}

/**
 * Picks the snippet that shows "what this session is being asked to do right now". Walks the user events
 * (with text) in tail.events from newest, and takes the first "usable" text. Short instructions ("push" etc.)
 * are still information as prompts, so they aren't rejected. undefined if none is found (e.g. a session with
 * only machine text)
 */
export function pickSnippet(tail: TailInfo): string | undefined {
  for (let i = tail.events.length - 1; i >= 0; i--) {
    const event = tail.events[i];
    if (event.kind !== "user" || !event.text) continue;
    const snippet = formatSnippet(event.text);
    if (snippet) return snippet;
  }
  return undefined;
}

/**
 * The latest message a person typed (anger mark input). Skips lines marked as not from a person
 * (task-notification etc.) and machine text that formatSnippet rejects (slash command echoes, bash-input,
 * [Request interrupted, ...). The at is the same as that message's started event
 */
export function lastUserMessage(events: TailEvent[]): { at: number; text: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== "user" || event.machine || !event.text) continue;
    if (!formatSnippet(event.text)) continue;
    return { at: event.at, text: event.text };
  }
  return undefined;
}

// Rejects text unusable as a snippet and formats the rest: machine text (slash command <command- tags,
// [SYSTEM notices, [Request interrupted, etc.) gives undefined.
// "[Image #N]" marks an image attachment followed by the body, so strip it and use the body.
// Newlines and runs of whitespace are normalized to a single space, then cut at the display width limit
// (full-width = 2, half-width = 1)
export function formatSnippet(rawText: string): string | undefined {
  let normalized = rawText.trim().replace(/\s+/g, " ");
  normalized = normalized.replace(/^(\[Image #\d+\]\s*)+/, "");
  if (!normalized) return undefined;
  if (normalized.startsWith("<")) return undefined;
  if (normalized.startsWith("[SYSTEM") || normalized.startsWith("[Request interrupted")) {
    return undefined;
  }
  let width = 0;
  let cut = normalized.length; // position (string index) where the limit was reached. The end if never reached
  for (let i = 0; i < normalized.length; ) {
    const ch = String.fromCodePoint(normalized.codePointAt(i) ?? 0);
    width += charWidth(ch);
    i += ch.length;
    if (width > SNIPPET_MAX_WIDTH) {
      cut = i - ch.length;
      break;
    }
  }
  if (cut >= normalized.length) return normalized;
  return `${normalized.slice(0, cut)}…`;
}

/**
 * Extracts the first question text from a question tool's input (first 500 chars of the JSON;
 * summarizeToolInput in lib/transcript.ts, arguments for Codex). AskUserQuestion and request_user_input both
 * have questions[].question. When cut at 500 chars with no closing ", use what is there up to the cut.
 * ExitPlanMode has no question text (undefined)
 */
export function extractQuestion(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const m = /"question"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(input);
  if (!m) return undefined;
  let text = m[1];
  if (m[2] === "") text = text.replace(/\\$/, ""); // drop a trailing escape cut off midway
  try {
    text = JSON.parse(`"${text}"`) as string;
  } catch {
    // If the escapes are broken, use it raw
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}
