import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { uiLanguage } from "@/lib/i18n";
import { summarizeTurnLine } from "@/lib/summarize";
import { lastSentence } from "@/lib/last-sentence";
import { loadActiveAiProvider, type ApiKeyProvider } from "@/lib/fsa";
import { judgeAbuse, judgeAsking, type AngerJudgement, type AskJudgement } from "@/lib/jev";
import { recordAngerJudgement, recordAskJudgement, type SessionView } from "@/lib/sessions";

/** Identifies a turn for the Jev verdict. Same basis as the done event key (sessionId + time of the last response) */
export function turnKey(sessionId: string, at: number): string {
  return `${sessionId}:${at}`;
}

/** Per-turn requests made from each scan (the Jev "?" verdict, the Jev anger verdict, and the speech bubble summary),
 * and the sessions with those results attached for display */
export function useTurnJudgements(sessions: SessionView[], aiKeySet: Record<ApiKeyProvider, boolean>) {
  // Jev verdict for needs reply (lib/jev.ts). Keyed by turn (turnKey). Turns whose check has started go into
  // askRequestedRef and aren't re-requested on every poll. Turns that leave the screen are dropped
  const [askJudgements, setAskJudgements] = useState<Record<string, AskJudgement>>({});
  const askRequestedRef = useRef(new Set<string>());
  const typeSafeKeySetRef = useRef(false);
  // Jev abuse verdict for the anger mark (docs/design.md "Anger mark for abuse toward the AI"). Keyed by session id,
  // holding the verdict of the latest judged user message, so the mark stays until the next message is judged.
  // angerRequestedRef remembers the time of the message last sent per session
  const [angerJudgements, setAngerJudgements] = useState<
    Record<string, { at: number; anger: AngerJudgement }>
  >({});
  const angerRequestedRef = useRef(new Map<string, number>());
  useEffect(() => {
    typeSafeKeySetRef.current = aiKeySet.typesafe;
  }, [aiKeySet.typesafe]);

  // Summarize the last response of a stopped turn into speech bubble text once, with BYOK (OpenAI / Anthropic)
  // (docs/design.md "Speech bubbles"). Nothing is shown without a key.
  // The result goes into turnLines and is attached as SessionView.summary at render. Once working, reply is gone and it disappears
  const [turnLines, setTurnLines] = useState<Record<string, string>>({});
  const turnLineRequestedRef = useRef(new Set<string>());
  const summaryKeySetRef = useRef(false);
  useEffect(() => {
    summaryKeySetRef.current = aiKeySet.anthropic || aiKeySet.openai;
  }, [aiKeySet.anthropic, aiKeySet.openai]);
  const requestTurnLines = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      // Views that already have a summary (mock) aren't summarized
      if (!view.reply || view.summary) continue;
      const key = turnKey(view.id, view.reply.at);
      live.add(key);
      if (!summaryKeySetRef.current || turnLineRequestedRef.current.has(key)) continue;
      turnLineRequestedRef.current.add(key);
      const { project, reply } = view;
      void (async () => {
        const provider = await loadActiveAiProvider();
        if (!provider) return;
        const result = await summarizeTurnLine(provider, {
          ui_language: uiLanguage(),
          assistant_text: reply.text,
        });
        const line = result.ok && typeof result.verdict.line === "string" ? result.verdict.line.trim() : "";
        void invoke("log", {
          line: `[bubble] ${result.ok ? `ok len=${line.length}` : `error=${result.kind}`} ${project}`,
        });
        if (!line) return;
        setTurnLines((current) =>
          turnLineRequestedRef.current.has(key) ? { ...current, [key]: line } : current,
        );
      })();
    }
    for (const key of turnLineRequestedRef.current) {
      if (!live.has(key)) turnLineRequestedRef.current.delete(key);
    }
    setTurnLines((current) => {
      const stale = Object.keys(current).filter((key) => !live.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, []);

  // Ask Jev once about a stopped turn (done / dozing with a reply). The done chirp and readout don't wait
  // for it. The result goes into askJudgements and is attached as SessionView.ask at render
  const requestAskJudgements = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      // Views that already have ask (mock) aren't sent to Jev
      if (!view.reply || view.ask) continue;
      const key = turnKey(view.id, view.reply.at);
      live.add(key);
      if (!typeSafeKeySetRef.current || askRequestedRef.current.has(key)) continue;
      askRequestedRef.current.add(key);
      const { id, project, reply } = view;
      setAskJudgements((current) => ({ ...current, [key]: { status: "pending" } }));
      void (async () => {
        const ask: AskJudgement = await judgeAsking(reply.text);
        setAskJudgements((current) => (key in current ? { ...current, [key]: ask } : current));
        recordAskJudgement(id, reply.at, ask);
        void invoke("log", {
          line: `[jev] ${ask.status} p=${ask.probability?.toFixed(2) ?? "-"}${ask.errorKind ? ` error=${ask.errorKind}` : ""} ${project}`,
        });
      })();
    }
    for (const key of askRequestedRef.current) {
      if (!live.has(key)) askRequestedRef.current.delete(key);
    }
    setAskJudgements((current) => {
      const stale = Object.keys(current).filter((key) => !live.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, []);

  // Send each new user message to Jev right when it appears (separately from the "?" verdict, which waits for the
  // turn to stop). The previous verdict stays shown until the new one comes back
  const requestAngerJudgements = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      live.add(view.id);
      // Views that already have anger (mock) aren't sent to Jev
      if (!view.userMessage || view.anger) continue;
      const { id, project, userMessage } = view;
      if (!typeSafeKeySetRef.current || angerRequestedRef.current.get(id) === userMessage.at) continue;
      angerRequestedRef.current.set(id, userMessage.at);
      void (async () => {
        const anger = await judgeAbuse(userMessage.text);
        setAngerJudgements((current) =>
          (current[id]?.at ?? -1) > userMessage.at ? current : { ...current, [id]: { at: userMessage.at, anger } },
        );
        recordAngerJudgement(id, userMessage.at, anger);
        void invoke("log", {
          line: `[jev] anger ${anger.status} p=${anger.probability?.toFixed(2) ?? "-"}${anger.errorKind ? ` error=${anger.errorKind}` : ""} ${project}`,
        });
      })();
    }
    for (const id of angerRequestedRef.current.keys()) {
      if (!live.has(id)) angerRequestedRef.current.delete(id);
    }
    setAngerJudgements((current) => {
      const stale = Object.keys(current).filter((id) => !live.has(id));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const id of stale) delete next[id];
      return next;
    });
  }, []);

  const requestJudgements = useCallback(
    (views: SessionView[]) => {
      requestAskJudgements(views);
      requestAngerJudgements(views);
      requestTurnLines(views);
    },
    [requestAskJudgements, requestAngerJudgements, requestTurnLines],
  );

  // Attach the Jev verdict only to the bird of the same turn (if the turn changes, turnKey changes and it isn't attached).
  // mock holds ask directly, so it isn't overwritten
  const displaySessions = useMemo(() => {
    // Without a summary key (OpenAI / Anthropic), for a turn where the Jev verdict is needs reply, the last sentence of the
    // last response goes in the speech bubble (docs/design.md "Speech bubbles"; no AI used)
    const hasSummaryKey = aiKeySet.anthropic || aiKeySet.openai;
    return sessions.map((s) => {
      // The anger mark only works while a TypeSafe key is saved, so deleting the key clears it
      const anger = s.anger ?? (aiKeySet.typesafe ? angerJudgements[s.id]?.anger : undefined);
      if (anger && !s.anger) s = { ...s, anger };
      if (!s.reply) return s;
      const key = turnKey(s.id, s.reply.at);
      const ask = s.ask ?? askJudgements[key];
      return {
        ...s,
        ask,
        summary: s.summary ?? turnLines[key],
        replyTail: !hasSummaryKey && ask?.status === "asking" ? lastSentence(s.reply.text) : undefined,
      };
    });
  }, [sessions, askJudgements, angerJudgements, turnLines, aiKeySet.anthropic, aiKeySet.openai, aiKeySet.typesafe]);

  return { requestJudgements, displaySessions };
}
