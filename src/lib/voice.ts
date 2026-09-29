// Reads events aloud (a separate layer from the sound synthesis in chirp.ts: this one is text).
// Uses window.speechSynthesis in the WebView.
// Serializing multiple simultaneous events is left to speechSynthesis's native queue;
// here we only push one utterance at a time onto the queue.

import { t, uiLanguage } from "./i18n";
import { loadActiveAiProvider } from "./fsa";
import { summarizeDoneEvent } from "./summarize";
import type { SessionEvent } from "./sessions";

// i18n key names of the readout template sentences (scripts/locales/voice.mjs). A plain string is
// enough for the key argument of t() (lib/i18n.ts), but this stays a literal type as documentation
// that VOICE_KEY only holds this one key
type VoiceMessageName = "eventWaitingVoice";

// Event type → i18n key of the readout template sentence. Types without a key are not read aloud
// (started is excluded because it would sound on every session start and get noisy. done does not use
// a template and reads only the project name + prompt → handled by its own branch in speakEvent. closed
// only happens through the user's own explicit action (/clear, closing the terminal, interrupting), and
// reading out something you closed yourself carries no information, so it is excluded)
const VOICE_KEY: Partial<Record<SessionEvent["type"], VoiceMessageName>> = {
  waiting: "eventWaitingVoice",
};

// snippet can be long, so cut it at an easy-to-follow length (spec: about 100 characters)
const SNIPPET_MAX_CHARS = 100;

// Readout volume (SpeechSynthesisUtterance.volume, 0 to 1). Why it is a module-level variable:
// speakDoneEvent awaits the summary before speaking, so if the volume were passed as an argument at
// call time, changing the volume in settings during the await would still speak at the old value.
// enqueueUtterance reads the latest value set by setVoiceVolume "at the moment of speaking" every
// time, so changes made while waiting are applied. Default is 1 (full, same default as loadVoiceVolume).
let voiceVolume = 1;

/** Called from settings (App.tsx). Assumes out-of-range values were already rejected by the caller (loadVoiceVolume). */
export function setVoiceVolume(volume: number): void {
  voiceVolume = volume;
}

/**
 * Formats a snippet for readout. The display formatting (formatSnippet) contains symbols meant to be
 * read on screen, which the speech engine reads literally as noise, so they are dropped right before
 * speaking. The display side is not changed at all.
 */
function sanitizeSnippetForSpeech(raw: string): string {
  let text = raw.slice(0, SNIPPET_MAX_CHARS);
  // The display ellipsis "…" that formatSnippet adds when truncating. The speech engine would read
  // it out as something like "dot dot dot", so it is not spoken
  const truncated = text.endsWith("…");
  if (truncated) text = text.slice(0, -1);
  // Remove markdown symbols: backquotes, runs of 2+ emphasis asterisks, and a leading heading #.
  // A lone "*" or a "#" mid-sentence is left alone because removing it could be wrong
  text = text.replace(/`/g, "").replace(/\*{2,}/g, "").replace(/^#+\s*/, "");
  // Drop the trailing word fragment cut off by truncation (e.g. "the a"). Not applied when there are no
  // spaces (CJK), because it would erase the whole text. Applied when not truncated, it would wrongly
  // remove a complete final word ("bug" in "fix the bug"), so it runs only when both conditions hold.
  // Only ASCII/Latin word fragments are removed (with \S+, a mixed Japanese/English snippet like
  // 「git diff を見てレビュー」 would lose its whole trailing Japanese part). This layer can't tell whether
  // it is a fragment, so only ASCII fragments, which tend to become meaningless syllables, are
  // targeted. CJK is left alone because even a single character carries meaning
  if (truncated && text.includes(" ")) {
    text = text.replace(/[A-Za-z0-9'’-]+$/, "");
  }
  // Clean up by dropping a trailing run of punctuation/symbols (a trailing "..." the user wrote,
  // the "/" of "src/" left after fragment removal, etc.)
  text = text.replace(/[\s.…,;:/\-]+$/, "").trim();
  return text;
}

/**
 * Formats the project string for readout. Dropping display symbols right before speaking follows
 * the same design as sanitizeSnippetForSpeech.
 */
function sanitizeProjectForSpeech(raw: string): string {
  // A chick event's project is "parent · chick name", joined with a display middle dot (U+00B7)
  // (a format from the tomarigi Chrome extension; the desktop scan doesn't emit events for chicks, so this only
  // guards against it). The speech engine reads the middle dot literally, so for
  // speech it is replaced with ", " (a comma pause)
  let text = raw.replace(/ · /g, ", ");
  // The chick name can fall back to the description in agent-<id>.meta.json (resolveChickMeta),
  // which may contain the display ellipsis "…", "...", or markdown backquotes. Spoken, they become
  // noise like "dot dot dot", so they are collapsed to a single space / removed. Single and double
  // dots are excluded because they are legitimate dots like "app.v2" (only 3 or more).
  text = text.replace(/…+/g, " ").replace(/\.{3,}/g, " ").replace(/`/g, "");
  return text.replace(/\s+/g, " ").trim();
}

// Speech primitive used by both speakEvent and speakDoneEvent. Pushes separate utterances onto
// speechSynthesis's native queue and uses the gap between utterances as the separator (see the
// comment in speakEvent for why)
function enqueueUtterance(text: string, lang: string): void {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.volume = voiceVolume;
  speechSynthesis.speak(utterance);
}

/**
 * Reads one event aloud. The template sentence ($PROJECT$ embedded via t() substitution in lib/i18n.ts),
 * followed by the snippet if there is one.
 *
 * Constraint: while this page has never received a user interaction (e.g. right after the app starts
 * with the setting ON), the autoplay policy can make speak() fail silently with not-allowed.
 * This is the same constraint as the chirp (chirp's primeAudio waits for pointerdown); after the
 * first click, sticky activation allows speech. Failures are swallowed here (same behavior as chirp).
 *
 * For done events this is also the legacy behavior (project name + snippet) used when the summary
 * readout (speakDoneEvent) is unavailable or fails. To avoid speaking twice, never call this function
 * on a path where the done summary readout has already succeeded (see speakDoneEvent).
 */
export function speakEvent(event: SessionEvent): void {
  if (typeof speechSynthesis === "undefined") return;
  const snippet = event.snippet ? sanitizeSnippetForSpeech(event.snippet) : undefined;
  const project = sanitizeProjectForSpeech(event.project);
  // No separator symbol is used — not just ".", any symbol may be read literally as "dot" etc.
  // depending on the engine (actual issue: a strange word was reported right after the project name
  // in the done readout). The policy of not adding extra i18n keys (same as formatEventTime) is kept.
  const lang = uiLanguage();
  if (event.type === "done") {
    // For done, the template sentence (e.g. "... has finished") is noisy, so skip it and read only
    // the project name + prompt (just the project name if there is no snippet)
    enqueueUtterance(project, lang);
  } else {
    const key = VOICE_KEY[event.type];
    if (!key) return;
    enqueueUtterance(t(key, project), lang);
  }
  if (snippet) enqueueUtterance(snippet, lang);
}

/**
 * Extracts the last sentence of assistantText (the body of the assistant's final reply for the turn)
 * with Intl.Segmenter (granularity: "sentence"). The policy is not to hand-write per-language regex
 * branches, so this is left to Chromium's built-in Intl.Segmenter. The extracted sentence gets the same
 * sanitizing as sanitizeSnippetForSpeech (markdown symbol removal, cutting past 100 characters,
 * trailing symbol removal); if it ends up whitespace-only or empty, returns undefined (the caller
 * falls back to the snippet).
 */
function extractLastSentence(text: string, lang: string): string | undefined {
  // Drop trailing newlines first (blank lines after code fences, "\n\n" paragraph breaks, etc., which
  // are common in the assistant's markdown output). UAX#29 sentence segmentation also cuts out a
  // newline-only run as its own segment, so without trim the last segment is whitespace-only and it
  // falls back to the snippet practically every time (the actual problem was confirmed in a unit test).
  const trimmed = text.trim();
  const segmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
  const segments = Array.from(segmenter.segment(trimmed), (s) => s.segment);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  const sanitized = sanitizeSnippetForSpeech(last);
  return sanitized || undefined;
}

/**
 * Shared fallback for when the AI summary readout for done can't be or isn't used.
 * If the last sentence of event.assistantText can be extracted, reads project name + last sentence;
 * otherwise (no assistantText, last sentence whitespace-only, etc.) falls back to the legacy behavior
 * of speakEvent(event) (project name + snippet = user prompt). The fallback is always consolidated into a
 * single call of this function, so it never speaks twice alongside speakEvent.
 */
function speakDoneFallback(event: SessionEvent, lang: string): void {
  if (typeof speechSynthesis === "undefined") return;
  const lastSentence = event.assistantText ? extractLastSentence(event.assistantText, lang) : undefined;
  if (!lastSentence) {
    speakEvent(event);
    return;
  }
  const project = sanitizeProjectForSpeech(event.project);
  enqueueUtterance(project, lang);
  enqueueUtterance(lastSentence, lang);
}

// Timeout for fetching the summary. To keep a stuck BYOK call from delaying or dropping the done
// readout itself, give up once exceeded and fall back to the legacy behavior
const SUMMARY_TIMEOUT_MS = 5_000;

/** Internal marker for withTimeout only. A unique symbol so it can't collide with the verdict type */
const TIMED_OUT = Symbol("summary-timeout");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // runJudge (lib/judge.ts) is designed not to throw (errors come back as JudgeResult.ok=false), but
    // a catch is added in case something before the call, such as loadAiApiKey, rejects
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

/**
 * Reads a done event aloud. Only when there is an OpenAI or Anthropic API key and the assistant's
 * reply body for this turn (event.assistantText) is available does it read the AI summary
 * (lib/summarize.ts), in the order "project name → summary". Otherwise (no key, API error, timeout,
 * empty verdict) it falls back to speakDoneFallback — which reads project name + last sentence if the
 * last sentence of assistantText can be extracted, and otherwise the legacy behavior of
 * speakEvent(event) (project name + snippet). The fallback path is always consolidated into a single
 * speakDoneFallback call, so the summary readout and the legacy behavior never both sound.
 *
 * The summary readout is gated independently, only on whether a key exists (the judging feature, i.e.
 * the old LLM judging, has been removed; this key is used only for the summary readout and the
 * connection test).
 *
 * The caller (App.tsx) must call this function only for done events with readout ON and not muted
 * (both voiceEnabled and muted share the same gate as speakEvent).
 *
 * stillEnabled: if the readout toggle is turned OFF while waiting for the summary (up to
 * SUMMARY_TIMEOUT_MS), speaking after the wait regardless would break the guarantee that
 * toggleVoiceEnabled's cancelSpeech() sets up so that "OFF goes quiet immediately" (a leak where,
 * right after cancelSpeech() empties the queue, this wait resolves and pushes onto the queue again).
 * Call this every time right before speaking after an await; if false, nothing is spoken for that
 * turn (neither fallback nor summary). The caller must pass a function returning the latest value,
 * equivalent to voiceEnabledRef.current.
 */
export async function speakDoneEvent(
  event: SessionEvent,
  stillEnabled: () => boolean,
): Promise<void> {
  const lang = uiLanguage();
  if (!event.assistantText) {
    speakDoneFallback(event, lang);
    return;
  }
  if (typeof speechSynthesis === "undefined") return; // Reject environments without speech before calling the summary API

  const provider = await loadActiveAiProvider();
  if (!stillEnabled()) return;
  if (!provider) {
    speakDoneFallback(event, lang);
    return;
  }

  const result = await withTimeout(
    summarizeDoneEvent(provider, {
      ui_language: lang,
      prompt: event.snippet,
      assistant_text: event.assistantText,
    }),
    SUMMARY_TIMEOUT_MS,
  );
  if (!stillEnabled()) return;

  if (result === TIMED_OUT || !result.ok) {
    speakDoneFallback(event, lang);
    return;
  }
  const summary =
    typeof result.verdict.summary === "string" ? sanitizeSummaryForSpeech(result.verdict.summary) : "";
  if (!summary) {
    speakDoneFallback(event, lang);
    return;
  }

  const project = sanitizeProjectForSpeech(event.project);
  enqueueUtterance(project, lang);
  enqueueUtterance(summary, lang);
}

// Sanitizing only for the summary readout. Reuses the same symbol removal as sanitizeSnippetForSpeech
// (backquotes, runs of 2+ emphasis asterisks, heading #, trailing punctuation), but skips the
// snippet-specific "remove the display ellipsis" and "remove the truncated fragment" steps (the
// summary is assumed to be one sentence the LLM completed, not a truncation). The prompt asks for
// 50 characters or fewer; as a safety valve if that is ignored, cut at the same limit as SNIPPET_MAX_CHARS
function sanitizeSummaryForSpeech(raw: string): string {
  let text = raw.slice(0, SNIPPET_MAX_CHARS);
  text = text.replace(/`/g, "").replace(/\*{2,}/g, "").replace(/^#+\s*/, "");
  text = text.replace(/[\s.…,;:/\-]+$/, "").trim();
  return text;
}

/** Stops all playing and queued utterances (for turning the readout toggle OFF) */
export function cancelSpeech(): void {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
}
