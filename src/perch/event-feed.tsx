import { AnimatePresence, motion } from "motion/react";
import { MdVolumeOff } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { SessionEvent } from "@/lib/sessions";
import { SpeechBubble } from "./bubble";
import { BirdBadge } from "./bird-glyph";
import { EVENT, EventIcon, eventKind } from "./event-kind";
import { focusProps } from "./focus";
import { formatEventTime } from "./format-time";

// It's an experimental feature, so keep the count modest.
// One card = one session. Past events of the same session aren't shown; only the latest one is
const EVENT_FEED_CARD_LIMIT = 6;

// events arrive newest first (lib/sessions.ts). The first e seen per sessionId is the latest, so
// the Map's insertion order is directly "sessions ordered by latest event" = the card display order
function pickLatestPerSession(events: SessionEvent[]): SessionEvent[] {
  const map = new Map<string, SessionEvent>();
  for (const e of events) {
    if (!map.has(e.sessionId)) map.set(e.sessionId, e);
  }
  return [...map.values()];
}

export function EventFeed({
  events,
  showHeading = true,
  onFocus,
  canFocus,
}: {
  events: SessionEvent[];
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  // In the tab view the tab label above doubles as the heading, so no h2 is rendered (App.tsx always passes false)
  showHeading?: boolean;
}) {
  const latest = pickLatestPerSession(events).slice(0, EVENT_FEED_CARD_LIMIT);
  // While any row has the anger mark, every row keeps room for it so the text lines up
  const anyAngry = latest.some((e) => e.angry);
  return (
    <div className={anyAngry ? "event-feed event-feed-anger" : "event-feed"}>
      {showHeading && (
        <h2 className="event-feed-heading">{t("eventFeedHeading")}</h2>
      )}
      {events.length === 0 && (
        <p className="empty event-feed-empty">{t("emptyNoEvents")}</p>
      )}
      <motion.ul className="event-feed-list" layout>
        <AnimatePresence initial={false}>
          {latest.map((e) => {
            const kind = eventKind(e);
            const focus = focusProps(e.sessionId, onFocus, canFocus);
            return (
              <motion.li
                key={e.sessionId}
                onClick={focus.onClick}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                // muted: a done that was held back while waiting on chicks, then canceled when the parent
                // restarted, so it never chirped (see deriveDoneEvent in lib/session-events.ts). The whole card is
                // dimmed so it can be told apart from a done that chirped (no flashy badge)
                className={`event-card event-${kind}${e.muted ? " event-muted" : ""} ${focus.className ?? ""}`}
              >
                <span className="event-marks">
                  <EventIcon kind={kind} size={16} />
                  {/* The same anger mark as on the bird (docs/design.md "Anger mark for abuse toward the AI") */}
                  {e.angry && <BirdBadge kind="anger" inline />}
                </span>
                <div className="event-card-body">
                  <div className="event-card-head">
                    <span className="event-card-project">{e.project}</span>
                    {e.snippet && <span className="event-snippet">{t("quotedSnippet", e.snippet)}</span>}
                  </div>
                  <div className="event-card-meta">
                    <span className="event-label">{EVENT[kind].label}</span>
                    {e.muted && (
                      <MdVolumeOff
                        className="event-mute-icon"
                        size={12}
                        role="img"
                        title={t("eventMutedTitle")}
                      />
                    )}
                    <span className="event-time">{formatEventTime(e.at)}</span>
                  </div>
                  {/* The same text as that turn's speech bubble (set by displayEvents in App.tsx) */}
                  {e.line && <SpeechBubble text={e.line} placement="row" />}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </motion.ul>
    </div>
  );
}
