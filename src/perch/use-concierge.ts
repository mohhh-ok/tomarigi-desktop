// Asks the concierge (lib/concierge.ts) when a session starts or stops needing a reply or finishes, and while any needs
// a reply, and keeps its advice for the Garden's concierge bird and the line above Perch (docs/design.md "Concierge")
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { uiLanguage } from "@/lib/i18n";
import { loadActiveAiProvider } from "@/lib/api-keys";
import { judgeModelFor } from "@/lib/ai-judge";
import {
  adviceStillHolds,
  adviceTargetChanged,
  appendConciergeLog,
  askConcierge,
  buildConciergePayload,
  conciergeRequestLogLines,
  conciergeErrorIsTemporary,
  conciergeResultLogLine,
  conciergeRetryLogLine,
  ConciergeScheduler,
  conciergeSuggestionLogLines,
  conciergeStateOf,
  conciergeTriggerClasses,
  recentJumps,
  type ConciergeAdvice,
  type ConciergeStateClass,
  type DroppedConciergeAdvice,
  type DroppedConciergeSuggestion,
} from "@/lib/concierge";
import { suggestionsAt, type ShownSuggestion } from "@/lib/concierge-status";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import { bubbleText } from "./bubble";
import { orderByWatchLinks } from "./watch-links";

/** Why an advice wasn't shown, for the debug log screen (English only, like the rest of that screen) */
const DROP_REASON_TEXT: Record<DroppedConciergeAdvice["reason"], string> = {
  nothing_to_do: "nothing to do now",
  working: "the session is working",
  no_reply_needed: "the session doesn't need a reply",
  no_name: "no session name",
  other_session: "another session is in the advice",
  not_waiting: "another session needs a reply",
  watched: "a watching session takes its result",
  child_working: "a session it watches is still working",
};

const SUGGESTION_DROP_TEXT: Record<DroppedConciergeSuggestion["reason"], string> = {
  ...DROP_REASON_TEXT,
  unknown_session: "not one of the sessions sent",
  no_kind: "no kind",
  no_text: "no text",
  duplicate: "a second one for the session",
  too_many: "more than three",
};

/** The facts sent to the concierge now */
export function conciergePayloadNow(
  sessions: SessionView[],
  events: SessionEvent[],
  agentOf: (id: string) => string | undefined,
) {
  const { parentOf } = orderByWatchLinks(sessions);
  return buildConciergePayload(
    sessions.map((view) => ({
      view,
      agent: agentOf(view.id),
      line: bubbleText(view),
      parentId: parentOf.get(view.id)?.id,
    })),
    events,
    recentJumps(),
    Date.now(),
    uiLanguage(),
  );
}

export interface ConciergeState {
  /** Whether the concierge is shown at all (an OpenAI / Anthropic key is saved, or Local is set up) */
  shown: boolean;
  /** The same, whether or not a session is on screen ("Concierge only" stays on with no session; concierge-only.ts) */
  available: boolean;
  /** The current advice, with its target only while that session is still on screen */
  advice: ConciergeAdvice | null;
  /** The suggestions of the last answer while the Concierge tab is open (empty otherwise), each with its session's state
   * when it came; they stay until the next answer (docs/design.md "Concierge") */
  suggestions: ShownSuggestion[];
}

/**
 * enabled: an OpenAI / Anthropic key is saved, or Local is set up. agentOf: the agent kind of a session id, when known.
 * mockAdvice: a source that doesn't call the API (mock) gives the advice itself; then nothing is requested.
 * withSuggestions: the Concierge tab is open, so the advice's request also asks for suggestions. It isn't an input of the
 * scheduler: opening the tab doesn't ask, the next request does (no extra request; Claude's own decision).
 * mockSuggestions: the same as mockAdvice for the suggestions
 */
export function useConcierge(
  sessions: SessionView[],
  events: SessionEvent[],
  enabled: boolean,
  agentOf: (id: string) => string | undefined,
  mockAdvice?: ConciergeAdvice | null,
  withSuggestions = false,
  mockSuggestions?: ShownSuggestion[],
): ConciergeState {
  const [advice, setAdvice] = useState<ConciergeAdvice | null>(null);
  const [suggestions, setSuggestions] = useState<ShownSuggestion[]>([]);
  // The advice shown and its target's state when it came, to tell whether it still holds after a failed request
  const shownRef = useRef<{ advice: ConciergeAdvice; targetState?: ConciergeStateClass } | null>(null);
  const inputsRef = useRef({ sessions, events, agentOf, withSuggestions });
  inputsRef.current = { sessions, events, agentOf, withSuggestions };
  // The latest request wins: an older one that comes back later is dropped
  const seqRef = useRef(0);
  const schedulerRef = useRef<ConciergeScheduler | null>(null);
  // While no session needs a reply or is done the advice is cleared; one that comes back after that is dropped
  const clearAdvice = () => {
    seqRef.current++;
    shownRef.current = null;
    setAdvice(null);
    setSuggestions([]);
  };
  schedulerRef.current ??= new ConciergeScheduler(() => {
    const seq = ++seqRef.current;
    const { sessions, events, agentOf, withSuggestions } = inputsRef.current;
    const payload = conciergePayloadNow(sessions, events, agentOf);
    const summary = `sessions=${payload.sessions.length} holds=${payload.holds.length} events=${payload.recent_events.length} chars=${JSON.stringify(payload).length}`;
    void (async () => {
      const provider = await loadActiveAiProvider();
      if (!provider || seq !== seqRef.current) return;
      appendConciergeLog({
        at: Date.now(),
        kind: "request",
        text: `${provider} ${summary}${withSuggestions ? " suggestions" : ""}`,
        detail: JSON.stringify(payload, null, 2),
      });
      // The request's id ties the advice in the app log to the facts it was given
      const logContext = { req: crypto.randomUUID().slice(0, 8), provider, model: await judgeModelFor(provider) };
      for (const line of conciergeRequestLogLines(logContext, payload)) void invoke("log", { line }).catch(() => {});
      const result = await askConcierge(provider, payload, undefined, withSuggestions);
      if (seq !== seqRef.current) return;
      void invoke("log", { line: conciergeResultLogLine(logContext, result) }).catch(() => {});
      for (const line of conciergeSuggestionLogLines(logContext, result)) void invoke("log", { line }).catch(() => {});
      if (!result.ok) {
        // A failed request keeps the advice shown until the next one, unless its target changed state since the advice
        // came (Claude's own decision, with the parent's addition)
        const shown = shownRef.current;
        if (shown && !adviceStillHolds(shown.advice, shown.targetState, inputsRef.current.sessions)) {
          shownRef.current = null;
          setAdvice(null);
        }
        // A temporary error is asked again after 10, 30 and 60 seconds (docs/design.md "Concierge")
        const retry = schedulerRef.current?.failed(conciergeErrorIsTemporary(result));
        if (retry) void invoke("log", { line: conciergeRetryLogLine(logContext, retry) }).catch(() => {});
        const text = `${result.kind}${result.status ? ` ${result.status}` : ""}${result.message ? ` ${result.message}` : ""}${retry ? `, retry ${retry.attempt} in ${retry.afterMs / 1000}s` : ""}`;
        appendConciergeLog({ at: Date.now(), kind: "error", text });
        return;
      }
      const next = result.verdict;
      const tokens = result.usage
        ? ` tokens in=${result.usage.input} cached=${result.usage.cachedInput} out=${result.usage.output}`
        : "";
      const detail = result.answer === undefined ? undefined : JSON.stringify(result.answer, null, 2);
      appendConciergeLog({
        ...(next
          ? { at: Date.now(), kind: "advice", text: `${next.line}${next.targetId ? ` → ${next.targetId}` : " (no target)"}${tokens}` }
          : result.dropped
            ? { at: Date.now(), kind: "dropped", text: `not shown, ${DROP_REASON_TEXT[result.dropped.reason]}: ${result.dropped.line} → ${result.dropped.targetId ?? "(no target)"}${tokens}` }
            : { at: Date.now(), kind: "none", text: `no advice${result.noMatchingJson ? " (answer didn't match the schema)" : ""}${tokens}` }),
        ...(detail !== undefined && { detail }),
      });
      for (const s of result.suggestions ?? []) {
        appendConciergeLog({ at: Date.now(), kind: "advice", source: "suggestion", text: `${s.kind}: ${s.text} → ${s.sessionId}` });
      }
      for (const s of result.droppedSuggestions ?? []) {
        appendConciergeLog({
          at: Date.now(),
          kind: "dropped",
          source: "suggestion",
          text: `not shown, ${SUGGESTION_DROP_TEXT[s.reason]}: ${s.kind ?? "-"}: ${s.text} → ${s.sessionId}`,
        });
      }
      const target = next?.targetId ? sessions.find((s) => s.id === next.targetId) : undefined;
      shownRef.current = next && { advice: next, targetState: target && conciergeStateOf(target) };
      setAdvice(next);
      // An answer without suggestions (the tab was closed when it was asked) leaves none; the states are the ones now,
      // so a suggestion is dimmed once its session moves after this
      setSuggestions(suggestionsAt(result.suggestions ?? [], inputsRef.current.sessions));
    })();
  }, clearAdvice);

  const live = enabled && mockAdvice === undefined && sessions.length > 0;
  useEffect(() => {
    schedulerRef.current?.update(conciergeTriggerClasses(sessions), live);
  }, [sessions, live]);
  useEffect(() => () => schedulerRef.current?.stop(), []);
  // The advice's target changed state (e.g. the user answered it): hidden on this poll, not at the next request. A
  // request already on its way still shows its advice when it comes
  useEffect(() => {
    const shown = shownRef.current;
    if (!shown || !adviceTargetChanged(shown.advice, shown.targetState, sessions)) return;
    shownRef.current = null;
    setAdvice(null);
  }, [sessions]);
  // Deleting the key clears the advice; one that comes back after that is dropped
  useEffect(() => {
    if (enabled) return;
    clearAdvice();
  }, [enabled]);
  // Leaving the tab drops the suggestions; opening it again shows them from the next answer
  useEffect(() => {
    if (!withSuggestions) setSuggestions([]);
  }, [withSuggestions]);

  const current = mockAdvice !== undefined ? mockAdvice : advice;
  const currentSuggestions = mockSuggestions ?? suggestions;
  return useMemo(() => {
    const available = enabled || mockAdvice !== undefined;
    const shown = available && sessions.length > 0;
    const listed = shown && withSuggestions ? currentSuggestions : [];
    if (!shown || !current) return { shown, available, advice: null, suggestions: listed };
    const targetOnScreen = current.targetId !== undefined && sessions.some((s) => s.id === current.targetId);
    return { shown, available, advice: targetOnScreen ? current : { line: current.line }, suggestions: listed };
  }, [enabled, mockAdvice, current, sessions, withSuggestions, currentSuggestions]);
}
