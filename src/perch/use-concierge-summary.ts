// "What's going on?" in "Concierge only" (docs/design.md "Concierge"; lib/concierge-summary.ts): pressing the button asks
// the concierge to sum up every session now, with the same provider and facts as the advice. The summary stays in the
// concierge's bubble until closed with ×. Asked only on a press, so the advice's request limit doesn't apply
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";
import { judgeModelFor } from "@/lib/ai-judge";
import { loadActiveAiProvider } from "@/lib/api-keys";
import { appendConciergeLog } from "@/lib/concierge";
import {
  askConciergeSummary,
  nextSummaryState,
  parseConciergeSummary,
  type SummaryEvent,
  type SummaryState,
} from "@/lib/concierge-summary";
import type { SessionEvent, SessionView } from "@/lib/sessions";
import { conciergePayloadNow } from "./use-concierge";

/** mock: a source that doesn't call the API gives the answer itself, in the AI's form with the sessions' own ids
    (PerchSource.conciergeSummary); it is read the same way */
export function useConciergeSummary(
  sessions: SessionView[],
  events: SessionEvent[],
  agentOf: (id: string) => string | undefined,
  mock?: (sessions: SessionView[]) => Promise<unknown> | undefined,
): { state: SummaryState; ask: () => void; close: () => void } {
  const [state, setState] = useState<SummaryState>({ kind: "idle" });
  const dispatch = useCallback((event: SummaryEvent) => setState((s) => nextSummaryState(s, event)), []);
  const inputsRef = useRef({ sessions, events, agentOf, mock });
  inputsRef.current = { sessions, events, agentOf, mock };
  const seqRef = useRef(0);

  const ask = useCallback(() => {
    const seq = ++seqRef.current;
    dispatch({ type: "ask", seq });
    const { sessions, events, agentOf, mock } = inputsRef.current;
    const payload = conciergePayloadNow(sessions, events, agentOf);
    const mocked = mock?.(sessions);
    if (mocked) {
      mocked.then(
        (answer) => {
          const parsed = parseConciergeSummary(answer, payload.sessions, Date.now());
          dispatch(parsed ? { type: "answer", seq, summary: parsed.summary } : { type: "fail", seq });
        },
        () => dispatch({ type: "fail", seq }),
      );
      return;
    }
    void (async () => {
      const provider = await loadActiveAiProvider();
      if (!provider) return dispatch({ type: "fail", seq });
      const req = crypto.randomUUID().slice(0, 8);
      const head = `[concierge] summary req=${req} provider=${provider} model=${await judgeModelFor(provider)}`;
      appendConciergeLog({
        at: Date.now(),
        kind: "request",
        source: "summary",
        text: `${provider} sessions=${payload.sessions.length}`,
        detail: JSON.stringify(payload, null, 2),
      });
      void invoke("log", { line: `${head} request sessions=${payload.sessions.length}` }).catch(() => {});
      const result = await askConciergeSummary(provider, payload);
      if (!result.ok) {
        const text = `${result.kind}${result.status ? ` ${result.status}` : ""}${result.message ? ` ${result.message}` : ""}`;
        appendConciergeLog({ at: Date.now(), kind: "error", source: "summary", text });
        void invoke("log", { line: `${head} error=${text}` }).catch(() => {});
        return dispatch({ type: "fail", seq });
      }
      const { summary, dropped } = result.verdict;
      const text = [...summary.items, ...summary.suggestions].map((e) => `${e.name}: ${e.text ?? `(${e.status})`}`).join("\n");
      appendConciergeLog({ at: Date.now(), kind: "advice", source: "summary", text });
      // The text is JSON-quoted, so its line breaks stay on one line. Objects with an id that wasn't sent are dropped
      void invoke("log", {
        line: `${head} text=${JSON.stringify(text)}${dropped.length > 0 ? ` dropped=${JSON.stringify(dropped)}` : ""}`,
      }).catch(() => {});
      dispatch({ type: "answer", seq, summary });
    })().catch(() => dispatch({ type: "fail", seq }));
  }, [dispatch]);

  const close = useCallback(() => dispatch({ type: "close" }), [dispatch]);
  return { state, ask, close };
}
