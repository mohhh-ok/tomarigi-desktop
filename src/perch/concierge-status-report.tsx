// The concierge's bubble in the Concierge tab (docs/design.md "Concierge"): the suggestions that came with the advice
// under their heading at the top, standing out, then a line per session, 「<name>: <text> <state>」, built here from the
// app's facts (lib/concierge-status.ts) on every render, smaller and muted as the detail to read after. Each name links to its session by id; no name is searched for in text. A suggestion
// whose session changed since it came is dimmed with its state now
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import {
  suggestionNow,
  type ConciergeStatus,
  type ShownSuggestion,
  type StatusLine,
} from "@/lib/concierge-status";
import type { SessionView } from "@/lib/sessions";

// The birds' own state words (docs/design.md "Bird states"), so a state reads the same here as at the bird
const STATE_LABEL = {
  reply: "birdWaitingLabel",
  done: "eventDoneLabel",
  working: "birdWorkingLabel",
} as const;
const nowLabel = (now: ConciergeStatus | "gone") =>
  now === "gone" ? t("conciergeSummaryGone") : t("conciergeSummaryNow", [t(STATE_LABEL[now])]);

/** Something that jumps to a session's pane on a click or Enter, at rest too (fade-target); a span, so a long name wraps
    with the line */
function Jump({ onJump, children }: { onJump: () => void; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="concierge-status-name fade-target"
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

export function ConciergeStatusReport({
  lines,
  more,
  suggestions,
  sessions,
  canJump,
  onFocus,
}: {
  lines: StatusLine[];
  more: number;
  suggestions: ShownSuggestion[];
  // The sessions on screen now: a suggestion whose session changed is dimmed, and its name is the one on screen now
  sessions: SessionView[];
  canJump: (id: string) => boolean;
  onFocus?: (id: string) => void;
}) {
  const name = (id: string, text: string, linked: boolean) =>
    linked && canJump(id) ? <Jump onJump={() => onFocus?.(id)}>{text}</Jump> : text;
  const state = (status: ConciergeStatus) => (
    <span className="concierge-status-state" data-status={status}>
      {` ${t(STATE_LABEL[status])}`}
    </span>
  );
  return (
    <span className="concierge-status">
      {/* None: no heading either */}
      {suggestions.length > 0 && (
        <span className="concierge-status-suggestions">
          <span className="concierge-status-heading">{t("conciergeSummarySuggestions")}</span>
          {suggestions.map((s) => {
            const now = suggestionNow(s, sessions);
            // The name on screen now; the one from when it came once the session left
            const shown = sessions.find((v) => v.id === s.sessionId)?.project;
            return (
              <span key={s.sessionId} className={`concierge-status-line${now ? " is-stale" : ""}`}>
                {name(s.sessionId, shown ?? s.name, now !== "gone")}
                {`: ${s.text}`}
                {now && <span className="concierge-status-now">{` ${nowLabel(now)}`}</span>}
              </span>
            );
          })}
        </span>
      )}
      <span className="concierge-status-lines">
        {lines.map((l) => (
          <span key={l.sessionId} className="concierge-status-line">
            {name(l.sessionId, l.name, true)}
            {/* The state is always the same part, so it looks the same with a text or without; a session the app has no
                text for says only its state, once */}
            {l.text === undefined ? ":" : `: ${l.text}`}
            {state(l.status)}
          </span>
        ))}
        {more > 0 && <span className="concierge-status-more">{t("conciergeSummaryMore", [String(more)])}</span>}
      </span>
    </span>
  );
}
