// Asks the concierge (lib/concierge.ts) when a session starts or stops needing a reply or finishes, and while any needs
// a reply, and keeps its advice for the Garden's concierge bird and the line above Perch (docs/design.md "Concierge")
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { uiLanguage } from "@/lib/i18n";
import { loadActiveAiProvider } from "@/lib/api-keys";
import {
  adviceStillHolds,
  adviceTargetChanged,
  appendConciergeLog,
  askConcierge,
  buildConciergePayload,
  ConciergeScheduler,
  conciergeStateOf,
  conciergeTriggerClasses,
  recentJumps,
  type ConciergeAdvice,
  type ConciergeStateClass,
} from "@/lib/concierge";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import { bubbleText } from "./bubble";
import { orderByWatchLinks } from "./watch-links";

export interface ConciergeState {
  /** Whether the concierge is shown at all (an OpenAI / Anthropic key is saved) */
  shown: boolean;
  /** The current advice, with its target only while that session is still on screen */
  advice: ConciergeAdvice | null;
}

/**
 * enabled: an OpenAI / Anthropic key is saved. agentOf: the agent kind of a session id, when known.
 * mockAdvice: a source that doesn't call the API (mock) gives the advice itself; then nothing is requested
 */
export function useConcierge(
  sessions: SessionView[],
  events: SessionEvent[],
  enabled: boolean,
  agentOf: (id: string) => string | undefined,
  mockAdvice?: ConciergeAdvice | null,
): ConciergeState {
  const [advice, setAdvice] = useState<ConciergeAdvice | null>(null);
  // The advice shown and its target's state when it came, to tell whether it still holds after a failed request
  const shownRef = useRef<{ advice: ConciergeAdvice; targetState?: ConciergeStateClass } | null>(null);
  const inputsRef = useRef({ sessions, events, agentOf });
  inputsRef.current = { sessions, events, agentOf };
  // The latest request wins: an older one that comes back later is dropped
  const seqRef = useRef(0);
  const schedulerRef = useRef<ConciergeScheduler | null>(null);
  // While no session needs a reply or is done the advice is cleared; one that comes back after that is dropped
  const clearAdvice = () => {
    seqRef.current++;
    shownRef.current = null;
    setAdvice(null);
  };
  schedulerRef.current ??= new ConciergeScheduler(() => {
    const seq = ++seqRef.current;
    const { sessions, events, agentOf } = inputsRef.current;
    const { parentOf } = orderByWatchLinks(sessions);
    const payload = buildConciergePayload(
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
    const summary = `sessions=${payload.sessions.length} holds=${payload.holds.length} events=${payload.recent_events.length} chars=${JSON.stringify(payload).length}`;
    void (async () => {
      const provider = await loadActiveAiProvider();
      if (!provider || seq !== seqRef.current) return;
      appendConciergeLog({
        at: Date.now(),
        kind: "request",
        text: `${provider} ${summary}`,
        detail: JSON.stringify(payload, null, 2),
      });
      void invoke("log", { line: `[concierge] request ${provider} ${summary}` }).catch(() => {});
      const result = await askConcierge(provider, payload);
      if (seq !== seqRef.current) return;
      if (!result.ok) {
        // A failed request keeps the advice shown until the next one, unless its target changed state since the advice
        // came (Claude's own decision, with the parent's addition)
        const shown = shownRef.current;
        if (shown && !adviceStillHolds(shown.advice, shown.targetState, inputsRef.current.sessions)) {
          shownRef.current = null;
          setAdvice(null);
        }
        const text = `${result.kind}${result.status ? ` ${result.status}` : ""}${result.message ? ` ${result.message}` : ""}`;
        appendConciergeLog({ at: Date.now(), kind: "error", text });
        void invoke("log", { line: `[concierge] error=${result.kind}` }).catch(() => {});
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
          : { at: Date.now(), kind: "none", text: `no advice${tokens}` }),
        ...(detail !== undefined && { detail }),
      });
      void invoke("log", {
        line: next
          ? `[concierge] advice len=${next.line.length} target=${next.targetId ?? "-"}${tokens}`
          : `[concierge] no advice${tokens}`,
      }).catch(() => {});
      const target = next?.targetId ? sessions.find((s) => s.id === next.targetId) : undefined;
      shownRef.current = next && { advice: next, targetState: target && conciergeStateOf(target) };
      setAdvice(next);
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

  const current = mockAdvice !== undefined ? mockAdvice : advice;
  return useMemo(() => {
    const shown = (enabled || mockAdvice !== undefined) && sessions.length > 0;
    if (!shown || !current) return { shown, advice: null };
    const targetOnScreen = current.targetId !== undefined && sessions.some((s) => s.id === current.targetId);
    return { shown, advice: targetOnScreen ? current : { line: current.line } };
  }, [enabled, mockAdvice, current, sessions]);
}
