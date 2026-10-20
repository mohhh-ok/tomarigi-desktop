import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { uiLanguage } from "@/lib/i18n";
import { nextAngry, summarizeTurn, turnOutcome, turnPayload, type TurnOutcome } from "@/lib/summarize";
import { loadActiveAiProvider } from "@/lib/api-keys";
import { appendConciergeLog } from "@/lib/concierge";
import { recordTurnVerdict, type SessionView } from "@/lib/sessions";

/** Identifies a turn for the turn verdict. Same basis as the done event key (sessionId + time of the last response) */
export function turnKey(sessionId: string, at: number): string {
  return `${sessionId}:${at}`;
}

/** Per-turn requests made from each scan (docs/design.md "Turn verdicts": one request per finished turn gives the
 * speech bubble line, the "?", and the anger mark), and the sessions with those results attached for display.
 * summarySetUp: an OpenAI / Anthropic key is saved, or Local is set up */
export function useTurnJudgements(sessions: SessionView[], summarySetUp: boolean) {
  // Results keyed by turn (turnKey). Turns whose request has started go into requestedRef and aren't re-requested on
  // every poll; the "?" is pending until the answer comes. Turns that leave the screen are dropped. Once working,
  // reply is gone and the bubble and the "?" go with it
  const [turns, setTurns] = useState<Record<string, TurnOutcome>>({});
  const requestedRef = useRef(new Set<string>());
  // The anger mark, keyed by session id: whether the latest judged turn had an abusive message, with that turn's reply
  // time. It stays until the next turn's verdict, also while the next turn is working, and isn't changed by a failed
  // request (docs/design.md "Anger mark for abuse toward the AI")
  const [anger, setAnger] = useState<Record<string, { at: number; angry: boolean }>>({});
  const setUpRef = useRef(false);
  useEffect(() => {
    setUpRef.current = summarySetUp;
  }, [summarySetUp]);

  // Ask once about a stopped turn (done / dozing with a reply), including those on screen at launch. The done chirp
  // and readout don't wait for it
  const requestJudgements = useCallback((views: SessionView[]) => {
    const liveTurns = new Set<string>();
    const liveSessions = new Set<string>();
    for (const view of views) {
      liveSessions.add(view.id);
      // Views that already have a summary or a verdict (mock) aren't sent
      if (!view.reply || view.summary || view.ask) continue;
      const key = turnKey(view.id, view.reply.at);
      liveTurns.add(key);
      if (!setUpRef.current || requestedRef.current.has(key)) continue;
      requestedRef.current.add(key);
      const { id, project, reply, userMessages = [] } = view;
      setTurns((current) => ({ ...current, [key]: { ask: { status: "pending" } } }));
      void (async () => {
        const provider = await loadActiveAiProvider();
        if (!provider) {
          setTurns((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
          return;
        }
        const payload = turnPayload(uiLanguage(), reply.text, userMessages.map((m) => m.text));
        const result = await summarizeTurn(provider, payload);
        const outcome = turnOutcome(result);
        // A local model's answer that isn't JSON matching the schema is no summary (docs/design.md "BYOK API keys",
        // Local AI), recorded as such in the app log and the debug log screen
        const noMatchingJson = !result.ok && result.noMatchingJson === true;
        const head = result.ok
          ? `ok len=${outcome.line?.length ?? 0} asking=${result.verdict.asking} abusive=${result.verdict.abusive}`
          : noMatchingJson
            ? "no summary no-matching-json"
            : `error=${result.kind}`;
        void invoke("log", { line: `[bubble] ${head} user_messages=${userMessages.length} ${project}` });
        if (noMatchingJson) {
          appendConciergeLog({
            at: Date.now(),
            kind: "none",
            source: "bubble",
            text: `no summary (answer didn't match the schema) ${project}`,
          });
        }
        recordTurnVerdict(id, reply.at, outcome.ask, outcome.abusive);
        setTurns((current) => (requestedRef.current.has(key) ? { ...current, [key]: outcome } : current));
        if (outcome.abusive === undefined) return;
        setAnger((current) => {
          const before = current[id];
          // An answer for an older turn that comes after a newer one doesn't overwrite it
          if (before && before.at > reply.at) return current;
          return { ...current, [id]: { at: reply.at, angry: nextAngry(before?.angry ?? false, outcome) } };
        });
      })();
    }
    for (const key of requestedRef.current) {
      if (!liveTurns.has(key)) requestedRef.current.delete(key);
    }
    setTurns((current) => {
      const stale = Object.keys(current).filter((key) => !liveTurns.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
    setAnger((current) => {
      const stale = Object.keys(current).filter((id) => !liveSessions.has(id));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, []);

  // Attach the results only to the bird of the same turn (if the turn changes, turnKey changes and they aren't
  // attached). mock holds summary / ask / angry directly, so they aren't overwritten
  const displaySessions = useMemo(
    () =>
      sessions.map((s) => {
        // The anger mark only works while a summary provider is set up, so removing it clears the mark
        const angry = s.angry ?? (summarySetUp ? anger[s.id]?.angry : undefined);
        if (angry !== undefined && s.angry === undefined) s = { ...s, angry };
        if (!s.reply) return s;
        const turn = turns[turnKey(s.id, s.reply.at)];
        return { ...s, ask: s.ask ?? turn?.ask, summary: s.summary ?? turn?.line };
      }),
    [sessions, turns, anger, summarySetUp],
  );

  return { requestJudgements, displaySessions };
}
