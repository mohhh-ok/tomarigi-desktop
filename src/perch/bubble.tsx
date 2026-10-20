// The bird's speech bubble (docs/design.md "Speech bubbles").
// This one component is used both in the Garden (under the icon) and in Perch (one line within the row).
import type { CSSProperties } from "react";
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

/** placement: below is under the icon in the Garden, row is within a row in Perch / Recent activity */
export function SpeechBubble({
  text,
  placement,
  style,
}: {
  text: string;
  placement: "below" | "row";
  // Position when pulled inward at the edge of the garden (bubbleShift in garden.tsx)
  style?: CSSProperties;
}) {
  // Long text is cut with "…" by CSS. Hovering shows the full text (title)
  if (placement === "below") {
    // Garden: an outer box holding the tail and position sits outside the body that is cut with "…" (overflow: hidden) (.speech-bubble-below in styles/speech-bubble.css)
    return (
      <span className="speech-bubble-below" title={text} style={style}>
        <span className="speech-bubble">{text}</span>
      </span>
    );
  }
  // In Perch rows, put it in an outer box that takes the whole second line, and size the bubble itself to the text
  return (
    <span className="speech-bubble-line">
      <span className="speech-bubble speech-bubble-row" title={text} style={style}>
        {text}
      </span>
    </span>
  );
}
