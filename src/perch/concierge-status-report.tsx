// The concierge's bubble in the Concierge tab (docs/design.md "Concierge"): the suggestions that came with the advice
// under their heading at the top, standing out, then a line per session, 「<name>: <text> <state>」, built here from the
// app's facts (lib/concierge-status.ts) on every render, smaller and muted as the detail to read after. Each name links to its session by id; no name is searched for in text. A suggestion
// whose session changed since it came is dimmed with its state now
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { clampText, linesIn } from "@/lib/clamp-text";
import {
  suggestionNow,
  type ConciergeStatus,
  type ShownSuggestion,
  type StatusLine,
} from "@/lib/concierge-status";
import type { SessionView } from "@/lib/sessions";
import { sinceAfterState } from "./format-time";

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

// A state line shows at most this many lines (docs/design.md "Concierge")
export const STATE_LINE_MAX_LINES = 2;

/**
 * A state line's text, 「: <text>」, cut so the whole line (dot, name, text, state) fits STATE_LINE_MAX_LINES lines, with
 * 「…」 where it was cut. Only the text is cut, whatever it comes from (a question, the speech bubble line, a tool), so the
 * state word and the time after it always show. Measured after every render (the time after the state counts up, and
 * the text changes with each poll; a change of the lines' width renders the report again), before the page is painted
 * and before the tab measures the window's height (concierge-tab-view.tsx, a parent, so its layout effect runs after this)
 */
function StateLineText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const span = ref.current;
    const line = span?.parentElement;
    if (!span || !line) return;
    const lineHeight = parseFloat(getComputedStyle(line).lineHeight);
    // The text is written straight into the span while measuring; React wrote the whole text into it and only writes it
    // again when the text changes, so what is left here is what shows
    span.textContent = `: ${clampText(text, (candidate) => {
      span.textContent = `: ${candidate}`;
      return linesIn(line.getBoundingClientRect().height, lineHeight) <= STATE_LINE_MAX_LINES;
    })}`;
  });
  return (
    <span ref={ref} className="concierge-status-text">
      {`: ${text}`}
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
  // The state with, for a finished line, the time since it finished, as the bird's status line shows it. One nowrap
  // part, so a line too wide wraps before it and the time is never cut off on its own
  const state = (status: ConciergeStatus, sinceMs?: number) => (
    <span className="concierge-status-state" data-status={status}>
      {" "}
      {t(STATE_LABEL[status])}
      {sinceMs !== undefined && sinceAfterState(sinceMs)}
    </span>
  );
  // The state lines' width: a change (the window resized) renders again, which cuts their texts again
  const linesRef = useRef<HTMLSpanElement>(null);
  const [, setLinesW] = useState(0);
  useEffect(() => {
    const el = linesRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLinesW(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
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
      <span ref={linesRef} className="concierge-status-lines">
        {lines.map((l) => (
          <span key={l.sessionId} className="concierge-status-line">
            {/* Every line starts with a dot whose color tells the state (docs/design.md "Concierge"); a mark, so it isn't
                read as a link (its color by its state in styles/concierge.css), and the state word stays after the text so the state doesn't rest on color alone */}
            <span className="concierge-status-dot" data-status={l.status} aria-hidden="true" />
            {name(l.sessionId, l.name, true)}
            {/* The state is always the same part, so it looks the same with a text or without; a session the app has no
                text for says only its state, once */}
            {l.text === undefined ? ":" : <StateLineText text={l.text} />}
            {state(l.status, l.sinceMs)}
          </span>
        ))}
        {more > 0 && <span className="concierge-status-more">{t("conciergeSummaryMore", [String(more)])}</span>}
      </span>
    </span>
  );
}
