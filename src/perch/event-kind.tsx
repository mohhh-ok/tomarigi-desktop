import type { IconType } from "react-icons/lib";
// Use the Material filled set. Thin-line outlines like lucide get lost at 12px on a dark background,
// so filled shapes designed for status display (check_circle / warning etc.) make them stand out
import { MdCheckCircle, MdHelp, MdPlayArrow, MdStopCircle } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { SessionEvent } from "@/lib/sessions";

// Color classes for event types. Rather than giving each type its own separate color, types are grouped
// by meaning
type EventTone = "done" | "turn" | "log";

// Look of the transition events reconstructed from the transcript (experimental feature). Meaning is carried
// three ways: icon (shape) + color (tone) + label. Icons designed as symbols, such as a check mark, stay
// legible at small sizes, so icons are used rather than a color dot alone
export const EVENT: Record<SessionEvent["type"], { label: string; tone: EventTone; icon: IconType }> = {
  started: { label: t("eventStartedLabel"), tone: "log", icon: MdPlayArrow },
  done: { label: t("eventDoneLabel"), tone: "done", icon: MdCheckCircle },
  // The name for the state waiting on a reply is the same word across the bird state, events, and the sound setting buttons (docs/design.md "Bird states")
  waiting: { label: t("birdWaitingLabel"), tone: "turn", icon: MdHelp },
  closed: { label: t("eventClosedLabel"), tone: "log", icon: MdStopCircle },
};

/** The event type as displayed. A done for a turn where the Jev verdict is needs reply is shown as needs reply,
 * matching the "?" in the Garden and on the Perch (docs/design.md "The "?" for sessions waiting on you") */
export function eventKind(e: SessionEvent): SessionEvent["type"] {
  return e.type === "done" && e.ask?.status === "asking" ? "waiting" : e.type;
}

/** The icon of an event type (shape + tone color). Used by Recent activity cards, the markers under garden birds, and
 * the sound settings */
export function EventIcon({ kind, size }: { kind: SessionEvent["type"]; size: number }) {
  const Icon = EVENT[kind].icon;
  return <Icon className={`event-icon tone-${EVENT[kind].tone}`} size={size} />;
}
