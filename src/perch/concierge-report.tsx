// The concierge's bubble in "Concierge only" while a "What's going on?" summary is shown (docs/design.md "Concierge"):
// the summary with × at its top right, then the advice below a dividing line. Session names in the text jump to their
// panes (summaryNameLinks)
import { t } from "@/lib/i18n";
import { summaryNameLinks, type conciergeBubbleParts } from "@/lib/concierge-summary";
import type { SessionView } from "@/lib/sessions";

type BubbleParts = ReturnType<typeof conciergeBubbleParts>;

export function ConciergeReport({
  parts,
  sessions,
  canJump,
  onFocus,
  onCloseSummary,
}: {
  parts: { summary: NonNullable<BubbleParts["summary"]>; advice?: string };
  // The sessions on screen, whose names in the text link to their terminal panes; only those canJump are links
  sessions: SessionView[];
  canJump: (id: string) => boolean;
  onFocus?: (id: string) => void;
  onCloseSummary: () => void;
}) {
  // A session's name jumps to its pane, as clicking its bird does; in the summary and in the advice alike
  const linked = (text: string) =>
    summaryNameLinks(text, sessions, canJump).map((p, i) =>
      p.id === undefined ? (
        p.text
      ) : (
        // Takes clicks at rest too, like the × (fade-target); a span, so a long name wraps with the line
        <span
          key={i}
          role="button"
          tabIndex={0}
          className="concierge-summary-name fade-target"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onFocus?.(p.id!)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onFocus?.(p.id!);
          }}
        >
          {p.text}
        </span>
      ),
    );
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
        {parts.summary.kind === "shown" ? (
          <span className="concierge-summary-text">
            {parts.summary.text.split("\n").map((line, i) => {
              // A state in brackets at the line's end wraps as one piece, not 「（返事待」「ち）」
              const tail = /\s?(（[^（）]*）|\([^()]*\))$/.exec(line);
              return (
                <span key={i} style={{ display: "block" }}>
                  {linked(tail ? line.slice(0, tail.index) : line)}
                  {tail && <span className="concierge-summary-tail">{linked(tail[0])}</span>}
                </span>
              );
            })}
          </span>
        ) : (
          <span className="concierge-summary-note">
            {t(parts.summary.kind === "loading" ? "conciergeSummaryLoading" : "conciergeSummaryFailed")}
          </span>
        )}
      </span>
      {parts.advice && (
        <>
          <span className="concierge-summary-divider" aria-hidden />
          {/* Its names link too, the same way as the summary's */}
          <span className="concierge-summary-advice">{linked(parts.advice)}</span>
        </>
      )}
    </>
  );
}
