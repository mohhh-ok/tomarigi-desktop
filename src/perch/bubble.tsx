// The bird's speech bubble (docs/design.md "Speech bubbles").
// SpeechBubble is one line within a row (Perch, Recent activity); GardenBubble is under the icon in the Garden.
import type { CSSProperties, ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { SessionView } from "@/lib/sessions";

/**
 * Text shown in the bubble. Not shown while working.
 * - Needs reply (question tool): the question text from the tool input. ExitPlanMode has no question text, so a fixed sentence
 * - Stopped turn (done / dozing): the line summarized with BYOK (docs/design.md "Turn verdicts"). If it needs a reply, what is
 *   being asked. Without a summary provider, no bubble
 */
export function bubbleText(s: SessionView): string | undefined {
  if (s.state === "waiting") {
    return s.question ?? (s.toolName === "ExitPlanMode" ? t("bubblePlanApproval") : undefined);
  }
  if (s.state === "done" || s.state === "dozing") return s.summary;
  return undefined;
}

/** placement: row is within a row in Perch / Recent activity. Under the icon in the Garden is GardenBubble below */
export function SpeechBubble({
  text,
  style,
}: {
  text: string;
  placement: "row";
  style?: CSSProperties;
}) {
  // In Perch rows, long text is cut with "…" by CSS and hovering shows the full text (title). Put it in an outer box
  // that takes the whole second line, and size the bubble itself to the text
  return (
    <span className="speech-bubble-line">
      <span className="speech-bubble speech-bubble-row" title={text} style={style}>
        {text}
      </span>
    </span>
  );
}

/** A bubble in the Garden (garden.tsx): a bird's text, or what the Concierge tab shows in place of it (content: the
 * suggestions and every session's line, concierge-status-report.tsx). The concierge's bubble takes clicks over its whole
 * box at rest (.fade-box, fade-targets.ts), in the Garden and in the Concierge tab, so a click on its empty space doesn't
 * reach what is under it; a bird's bubble lets clicks through (docs/design.md "Fade until hovered") */
export function GardenBubble({
  text,
  content,
  concierge,
  style,
}: {
  text: string;
  content?: ReactNode;
  concierge: boolean;
  style?: CSSProperties;
}) {
  const box = concierge ? " fade-box" : "";
  // The whole text, wrapping past 180px; an outer box holds the tail and position (.speech-bubble-below in
  // styles/speech-bubble.css), placed by style when pulled inward at the edge of the garden (bubbleVars in garden.tsx)
  if (content === undefined) {
    return (
      <span className={`speech-bubble-below${box}`} style={style}>
        <span className="speech-bubble">{text}</span>
      </span>
    );
  }
  return (
    <span className={`speech-bubble-below concierge-report${box}`} style={style}>
      <span className="speech-bubble">{content}</span>
    </span>
  );
}
