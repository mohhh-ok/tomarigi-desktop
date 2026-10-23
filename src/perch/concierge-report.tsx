// The concierge's bubble in "Concierge only" while a "What's going on?" summary is shown (docs/design.md "Concierge"):
// when it was made with × at its top right, a line per session, the suggestions under their heading, then the advice
// below a dividing line. Each line is built here as 「<name>: <text> <state>」, the state from the app's facts, and the
// name links to its session; no name is searched for in text. A line whose session changed since is dimmed with its
// state now
import type { ReactNode } from "react";
import { t, uiLanguage } from "@/lib/i18n";
import type { ConciergeAdvice } from "@/lib/concierge";
import { summaryEntryNow, type Summary, type SummaryEntry } from "@/lib/concierge-summary";
import type { SessionView } from "@/lib/sessions";

const STATE_LABEL = {
  reply: "conciergeSummaryStateReply",
  done: "conciergeSummaryStateDone",
  working: "conciergeSummaryStateWorking",
} as const;
const NOW_LABEL = {
  reply: "conciergeSummaryNowReply",
  done: "conciergeSummaryNowDone",
  working: "conciergeSummaryNowWorking",
  gone: "conciergeSummaryGone",
} as const;

/** Something that jumps to a session's pane on a click or Enter, at rest too (fade-target, like the ×); a span, so a
    long name wraps with the line */
function Jump({ className, onJump, children }: { className: string; onJump: () => void; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={`${className} fade-target`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onJump}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onJump();
      }}
    >
      {children}
    </span>
  );
}

export function ConciergeReport({
  parts,
  sessions,
  canJump,
  onFocus,
  onCloseSummary,
}: {
  parts: {
    summary: { kind: "loading" } | { kind: "shown"; summary: Summary } | { kind: "failed" };
    advice?: ConciergeAdvice;
  };
  // The sessions on screen now: a line's name links to its pane, and a line whose session changed is dimmed
  sessions: SessionView[];
  canJump: (id: string) => boolean;
  onFocus?: (id: string) => void;
  onCloseSummary: () => void;
}) {
  // withState: items get their state from the app's facts after the AI's text; suggestions don't
  const line = (e: SummaryEntry, i: number, withState: boolean) => {
    const now = summaryEntryNow(e, sessions);
    // The name as it is on screen now; the one from when the summary was made once the session left
    const name = sessions.find((s) => s.id === e.sessionId)?.project ?? e.name;
    return (
      <span key={i} className={`concierge-summary-line${now ? " is-stale" : ""}`}>
        {now !== "gone" && canJump(e.sessionId) ? (
          <Jump className="concierge-summary-name" onJump={() => onFocus?.(e.sessionId)}>
            {name}
          </Jump>
        ) : (
          name
        )}
        {`: ${e.text ?? t(STATE_LABEL[e.status])}`}
        {/* A changed line shows its state now instead of the one it had */}
        {now ? (
          <span className="concierge-summary-now">{` ${t(NOW_LABEL[now])}`}</span>
        ) : (
          withState &&
          e.text !== undefined && (
            <span className="concierge-summary-state" data-status={e.status}>
              {` ${t(STATE_LABEL[e.status])}`}
            </span>
          )
        )}
      </span>
    );
  };
  const summary = parts.summary.kind === "shown" ? parts.summary.summary : undefined;
  const advice = parts.advice;
  return (
    <>
      <span className="concierge-summary">
        {/* Takes clicks at rest too (fade-target in garden-fade.ts); the rest of the bubble lets them through */}
        <button
          type="button"
          className="concierge-summary-close fade-target"
          aria-label={t("conciergeSummaryClose")}
          title={t("conciergeSummaryClose")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onCloseSummary}
        >
          ×
        </button>
        {summary ? (
          <>
            <span className="concierge-summary-made">
              {t("conciergeSummaryMadeAt", [
                new Date(summary.madeAt).toLocaleTimeString(uiLanguage(), { hour: "2-digit", minute: "2-digit" }),
              ])}
            </span>
            <span className="concierge-summary-text">
              {summary.items.map((e, i) => line(e, i, true))}
              {summary.more > 0 && (
                <span className="concierge-summary-more">{t("conciergeSummaryMore", [String(summary.more)])}</span>
              )}
            </span>
            {summary.suggestions.length > 0 && (
              <>
                <span className="concierge-summary-heading">{t("conciergeSummarySuggestions")}</span>
                <span className="concierge-summary-text">{summary.suggestions.map((e, i) => line(e, i, false))}</span>
              </>
            )}
          </>
        ) : (
          <span className="concierge-summary-note">
            {t(parts.summary.kind === "loading" ? "conciergeSummaryLoading" : "conciergeSummaryFailed")}
          </span>
        )}
      </span>
      {advice && (
        <>
          <span className="concierge-summary-divider" aria-hidden />
          {/* The whole line jumps to the advice's session, like clicking the concierge */}
          {advice.targetId && canJump(advice.targetId) ? (
            <Jump className="concierge-summary-advice is-link" onJump={() => onFocus?.(advice.targetId!)}>
              {advice.line}
            </Jump>
          ) : (
            <span className="concierge-summary-advice">{advice.line}</span>
          )}
        </>
      )}
    </>
  );
}
