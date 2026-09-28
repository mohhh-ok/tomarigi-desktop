import { Fragment, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { IconType } from "react-icons/lib";
// Use the Material filled set. Thin-line outlines like lucide get lost at 12px on a dark background,
// so filled shapes designed for status display (check_circle / warning etc.) make them stand out
import {
  MdCheckCircle,
  MdHelp,
  MdPlayArrow,
  MdStopCircle,
  MdVolumeOff,
} from "react-icons/md";
import { t } from "@/lib/i18n";
import { hasQuestion, isAngry, needsAnswer } from "@/lib/jev";
import { bubbleText, SpeechBubble } from "./bubble";
import type { BirdState, SessionEvent, SessionView } from "@/lib/sessions";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { DEFAULT_ICON_SET, ICON_SETS, resolveIconSet } from "./icon-sets";

// glyph is kept as an alternative for AX text readout and as a fallback if image loading ever fails.
// The actual display uses img (WebP sprites generated with gpt-image-2). img takes ICON_SETS.birds as its
// source (with the introduction of icon sets, the source of truth for the images was consolidated in
// icon-sets.ts. birds is the default set, so referencing it here still works as before)
export const BIRD: Record<BirdState, { glyph: string; label: string; img: string }> = {
  working: {
    glyph: "🐦",
    label: t("birdWorkingLabel"),
    img: ICON_SETS.birds.working,
  },
  waiting: {
    glyph: "🕊️",
    label: t("birdWaitingLabel"),
    img: ICON_SETS.birds.waiting,
  },
  done: {
    glyph: "🕊️",
    // The name for the state after a turn ends is the same word across the bird state, events, and the sound setting buttons (docs/design.md "State names")
    label: t("eventDoneLabel"),
    img: ICON_SETS.birds.done,
  },
  dozing: {
    glyph: "💤",
    label: t("birdDozingLabel"),
    img: ICON_SETS.birds.dozing,
  },
};

/**
 * State label. If this session needs a reply (asking), use the needs-reply word even when done or dozing
 * (the word matches the badge). If watching (the peer is working), use the watching word. Even if the peer
 * is asking, a watching bird stays watching
 */
export function birdLabel(state: BirdState, asking: boolean, watching = false): string {
  if (asking) return BIRD.waiting.label;
  if (watching) return t("birdWatchingLabel");
  return BIRD[state].label;
}

/** Shared component that shows a BirdState as a WebP sprite instead of an emoji.
 * alt is empty — callers always put the state label text next to it, so it can be treated as decorative.
 * flip is the horizontal mirror for the garden (if everyone faces the same way it looks stuffed, so it is
 * split half and half based on the id).
 * set is the icon set assigned to the project (DEFAULT_ICON_SET = birds when unspecified).
 * asking means waiting on the user's reply (needsAnswer in lib/jev.ts). Overlays the "?" badge, shared by
 * all icon sets, at the top right. angry overlays the anger mark (isAngry in lib/jev.ts) at the top left; both can
 * show at once. The Garden, the Perch, and the nest list all render through this component */
export function BirdGlyph({
  state,
  size,
  flip = false,
  set = DEFAULT_ICON_SET,
  asking = false,
  angry = false,
}: {
  state: BirdState;
  size: number;
  flip?: boolean;
  set?: IconSetId;
  asking?: boolean;
  angry?: boolean;
}) {
  // Only working gets the "charging aura" effect class (.bird-working-fx in perch.css).
  // flip used to mirror directly with style.transform: scaleX(-1), but while working the CSS animation
  // (sway/peck) owns the same transform property, so it goes through a custom property (--glyph-flip)
  // instead. Both .bird-glyph-img in perch.css (at rest) and each working keyframes (during animation)
  // multiply by var(--glyph-flip, 1), so the mirror is kept whether working or not
  // The value is passed as a string. React doesn't append px to custom properties (--*) and passes the
  // value through stringified, so a number would also work, but this is a scaleX factor, not a length,
  // and the string form makes it explicit that the question of units doesn't apply to it
  const style = flip ? ({ "--glyph-flip": "-1" } as CSSProperties) : undefined;
  return (
    <span
      className={state === "dozing" ? "bird-glyph bird-glyph-dozing" : "bird-glyph"}
      style={{ "--glyph-size": `${size}px` } as CSSProperties}
    >
      <img
        className={state === "working" ? "bird-glyph-img bird-working-fx" : "bird-glyph-img"}
        src={ICON_SETS[set][state]}
        width={size}
        height={size}
        alt=""
        draggable={false}
        style={style}
      />
      {asking && <BirdBadge kind="ask" />}
      {angry && <BirdBadge kind="anger" />}
    </span>
  );
}

const ANGER_VEIN =
  "M8.5 2.5v2q0 4-4 4h-2M15.5 2.5v2q0 4 4 4h2M8.5 21.5v-2q0-4-4-4h-2M15.5 21.5v-2q0-4 4-4h2";

/** A mark drawn over the bird. "?" (needs reply) sits at the top right, the anger mark at the top left */
function BirdBadge({ kind, inline = false }: { kind: "ask" | "anger"; inline?: boolean }) {
  const title = t(kind === "ask" ? "askingBadgeTitle" : "angerBadgeTitle");
  // inline: placed in the flow next to another mark (Recent activity rows) instead of over a bird
  return (
    <span
      className={`bird-badge bird-badge-${kind}${inline ? " bird-badge-inline" : ""}`}
      title={title}
      aria-label={title}
    >
      {kind === "ask" ? (
        "?"
      ) : (
        // The manga anger vein (💢) drawn as is, not an emoji font: four red corner brackets bending toward the
        // center. The same path is drawn twice, a thicker dark one underneath as the outline
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path className="bird-badge-anger-outline" d={ANGER_VEIN} />
          <path className="bird-badge-anger-vein" d={ANGER_VEIN} />
        </svg>
      )}
    </span>
  );
}

// Color classes for event types. Rather than giving each type its own separate color, types are grouped
// by meaning
export type EventTone = "done" | "turn" | "alert" | "log";

// Look of the transition events reconstructed from the transcript (experimental feature). Meaning is carried
// three ways: icon (shape) + color (tone) + label. Icons designed as symbols, such as a check mark, stay
// legible at small sizes, so icons are used rather than a color dot alone
export const EVENT: Record<SessionEvent["type"], { label: string; tone: EventTone; icon: IconType }> = {
  started: { label: t("eventStartedLabel"), tone: "log", icon: MdPlayArrow },
  done: { label: t("eventDoneLabel"), tone: "done", icon: MdCheckCircle },
  // The name for the state waiting on a reply is the same word across the bird state, events, and the sound setting buttons (docs/design.md "State names")
  waiting: { label: t("birdWaitingLabel"), tone: "turn", icon: MdHelp },
  closed: { label: t("eventClosedLabel"), tone: "log", icon: MdStopCircle },
};

/** Attributes for elements that jump to the Ghostty pane on click (Perch rows, event cards, garden birds).
 * Nothing is added for ones that can't be matched (Codex, mock) = clicking does nothing and the look doesn't change */
export function focusProps(id: string, onFocus?: (id: string) => void, canFocus?: (id: string) => boolean) {
  if (!onFocus || !canFocus?.(id)) return {};
  return {
    className: "focusable",
    onClick: () => onFocus(id),
  };
}

/** Pulsing dots shown only while working. Makes "rows that are moving" recognizable at a glance.
 * Exported because garden.tsx uses the same look */
export function LiveDots() {
  return (
    <span className="live-dots">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * Perch ordering. Among birds linked by watching, the one started first (smaller startedAt; if absent,
 * the earlier in the list) becomes the parent, and the others are placed right after it. Only one level of
 * parent (a peer's peer goes under the same parent)
 */
function orderByWatchLinks(sessions: SessionView[]): {
  ordered: SessionView[];
  parentOf: Map<string, SessionView>;
} {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rank = new Map(sessions.map((s, i) => [s.id, i]));
  const earlier = (a: SessionView, b: SessionView) =>
    (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  // For each connected component, the bird started first becomes the parent
  const rootOf = new Map<string, SessionView>();
  for (const start of sessions) {
    if (rootOf.has(start.id) || !start.peers?.some((p) => p.viewId && byId.has(p.viewId))) continue;
    const component: SessionView[] = [];
    const queue = [start];
    const seen = new Set([start.id]);
    while (queue.length > 0) {
      const current = queue.shift() as SessionView;
      component.push(current);
      for (const peer of current.peers ?? []) {
        const next = peer.viewId ? byId.get(peer.viewId) : undefined;
        if (next && !seen.has(next.id)) {
          seen.add(next.id);
          queue.push(next);
        }
      }
    }
    const root = [...component].sort(earlier)[0];
    for (const member of component) rootOf.set(member.id, root);
  }
  const parentOf = new Map<string, SessionView>();
  for (const [id, root] of rootOf) if (root.id !== id) parentOf.set(id, root);
  const ordered: SessionView[] = [];
  for (const s of sessions) {
    if (parentOf.has(s.id)) continue;
    ordered.push(s);
    for (const child of sessions) if (parentOf.get(child.id)?.id === s.id) ordered.push(child);
  }
  return { ordered, parentOf };
}

/**
 * Name of a peer listed under a watching parent. Not shown if it is in the same folder as the parent
 * (undefined; the same in garden blocks). If under the parent, the path relative to the parent's working
 * folder; otherwise the folder name (display name)
 */
export function relativeLabel(parent: SessionView, child: SessionView): string | undefined {
  const base = parent.cwd?.replace(/\/+$/, "");
  const own = child.cwd?.replace(/\/+$/, "");
  if (base && own === base) return undefined;
  if (base && own?.startsWith(`${base}/`)) return own.slice(base.length + 1);
  return child.project;
}

/**
 * A bird's status line (state word · elapsed time · tool name). Used by both Perch rows and garden birds.
 * The container (.bird-row-main on the Perch, .garden-status in the garden) is flex; the state word and
 * elapsed time don't shrink, and the tool name is hidden entirely if it doesn't fit (.bird-row-tool in
 * perch.css). The tool name goes last so that the gap left when it is hidden doesn't appear between the
 * word and the time. Needs reply shows only "needs reply · elapsed time"
 * (what is being asked goes in the speech bubble)
 */
export function StatusParts({
  session,
  asking,
  liveDots = false,
  toolOnOwnLine = false,
  stacked = false,
}: {
  session: SessionView;
  asking: boolean;
  liveDots?: boolean;
  /** For the garden. Don't hide the tool name; show it on one line below the status line */
  toolOnOwnLine?: boolean;
  /** For the narrow cells of a watching block (used with toolOnOwnLine). The first line has only the state word; elapsed time goes on the second line with the tool name */
  stacked?: boolean;
}) {
  const tool = session.toolName && !asking ? session.toolName : undefined;
  if (toolOnOwnLine) {
    const label = (
      <span className="status bird-row-label">
        {birdLabel(session.state, asking, session.watching !== undefined)}
      </span>
    );
    const since = formatSince(session.sinceMs);
    if (stacked) {
      return (
        <>
          <span className="garden-status-main">{label}</span>
          <span className="status garden-status-sub">{tool ? `${since} · ${tool}` : since}</span>
        </>
      );
    }
    return (
      <>
        <span className="garden-status-main">
          {label}
          <span className="status bird-row-since">&nbsp;· {since}</span>
        </span>
        {tool && <span className="status garden-status-sub">{tool}</span>}
      </>
    );
  }
  return (
    <>
      <span className="status bird-row-label">
        {/* During the grace period (within 5 minutes after the peer stopped; watching is 0) it still shows "watching". Uses the
            same check as the reason it is kept in the garden instead of the nest (lib/watching.ts) */}
        {birdLabel(session.state, asking, session.watching !== undefined)}
      </span>
      <span className="status bird-row-since">
        &nbsp;· {formatSince(session.sinceMs)}
        {liveDots && session.state === "working" && <LiveDots />}
      </span>
      {tool && (
        <span className="status bird-row-tool">
          <span>&nbsp;· {tool}</span>
        </span>
      )}
    </>
  );
}

// The request excerpt on a Perch row is hidden entirely when narrower than this (so fragments like "「." aren't shown)
const SNIPPET_MIN_VISIBLE_EM = 2.5;

/** The request excerpt on a Perch row. Its width is set by .bird-row-snippet in perch.css; this only hides it
 * when too narrow (it uses visibility, so the width doesn't change and remeasuring doesn't flicker) */
function RowSnippet({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const em = parseFloat(getComputedStyle(el).fontSize) || 11;
      el.dataset.tight = String(el.clientWidth < em * SNIPPET_MIN_VISIBLE_EM);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={ref} className="snippet bird-row-snippet">
      {t("quotedSnippet", text)}
    </span>
  );
}

export function Perch({
  sessions,
  hasGranted,
  iconSetAssignments = {},
  onFocus,
  canFocus,
}: {
  sessions: SessionView[];
  hasGranted: boolean;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  // slug → assignment map. For unspecified or unassigned slugs, resolveIconSet
  // falls back to DEFAULT_ICON_SET
  iconSetAssignments?: IconSetAssignments;
}) {
  if (sessions.length === 0) {
    return (
      <div className="empty">
        {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
      </div>
    );
  }
  // For watching links, the one started first becomes the parent and the peers' rows are indented below it (docs/design.md "Watching")
  const { ordered, parentOf } = orderByWatchLinks(sessions);
  // Watching group: the parent's id (the parent itself uses its own id). Dividers inside a group are dashed; the border with the outside is solid
  const groupOf = (s: SessionView): string | undefined =>
    parentOf.get(s.id)?.id ?? (ordered.some((o) => parentOf.get(o.id)?.id === s.id) ? s.id : undefined);
  const continuesGroup = (s: SessionView, i: number): boolean => {
    const next = ordered[i + 1];
    const group = groupOf(s);
    return group !== undefined && next !== undefined && groupOf(next) === group;
  };
  return (
    <ul className="perch">
      {ordered.map((s, i) => {
        const parent = parentOf.get(s.id);
        const set = resolveIconSet(iconSetAssignments, s.slug);
        const focus = focusProps(s.id, onFocus, canFocus);
        const asking = needsAnswer(s.state, s.ask);
        const bubble = bubbleText(s);
        return (
          <Fragment key={s.id}>
            <li
              {...focus}
              className={`bird ${s.state}${parent ? " linked-child" : ""}${continuesGroup(s, i) ? " linked-continues" : ""} ${focus.className ?? ""}`}
            >
              {/* First line (bird, name, status). The speech bubble goes separately on a second line; the first line doesn't wrap */}
              <div className="bird-row-main">
              <BirdGlyph state={s.state} size={18} set={set} asking={hasQuestion(s)} angry={isAngry(s)} />
              {/* When width runs short, the shrink order is request excerpt → name → status (.bird-row-* in perch.css).
                  The state word and elapsed time always stay; the tool name is hidden entirely if it doesn't fit */}
              {/* Indented peer rows are named by the path relative to the parent's working folder (the folder name if not under it) */}
              {/* Peer rows in the same folder as the parent show no name (relativeLabel is undefined) */}
              {(() => {
                const name = parent ? relativeLabel(parent, s) : s.project;
                return name !== undefined && <span className="name bird-row-name">{name}</span>;
              })()}
              {/* The latest user message (always set by lib/sessions.ts; absent only for sessions with no message in the window) */}
              {s.snippet && <RowSnippet text={s.snippet} />}
              <StatusParts session={s} asking={asking} liveDots />
              </div>
              {bubble && <SpeechBubble text={bubble} placement="row" />}
            </li>
            {/* Chicks belong to the same project as the parent, so use the chick image from the parent's set */}
            {s.chicks?.map((c) => (
              // Chicks jump to the parent's pane (focusTargetOf in lib/ghostty.ts)
              <li
                key={c.id}
                {...focus}
                className={`chick ${c.state} ${focus.className ?? ""}`}
              >
                <img
                  className={
                    c.state === "working" ? "bird-glyph-img bird-working-fx" : "bird-glyph-img"
                  }
                  src={ICON_SETS[set].chick}
                  width={14}
                  height={14}
                  alt=""
                  draggable={false}
                />
                <span className="name">{c.name}</span>
                <span className="status">
                  {BIRD[c.state].label}
                  {c.toolName ? ` · ${c.toolName}` : ""} · {formatSince(c.sinceMs)}
                  {c.state === "working" && <LiveDots />}
                </span>
              </li>
            ))}
          </Fragment>
        );
      })}
    </ul>
  );
}

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

/** The event type as displayed. A done for a turn where the Jev verdict is needs reply is shown as needs reply,
 * matching the "?" in the Garden and on the Perch (docs/design.md "The "?" for sessions waiting on you") */
export function eventKind(e: SessionEvent): SessionEvent["type"] {
  return e.type === "done" && e.ask?.status === "asking" ? "waiting" : e.type;
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
            const Icon = EVENT[kind].icon;
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
                // restarted, so it never chirped (see deriveDoneEvent in lib/sessions.ts). The whole card is
                // dimmed so it can be told apart from a done that chirped (no flashy badge)
                className={`event-card event-${kind}${e.muted ? " event-muted" : ""} ${focus.className ?? ""}`}
              >
                <span className="event-marks">
                  <Icon className={`event-icon tone-${EVENT[kind].tone}`} size={16} />
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

export function formatSince(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t("sinceSeconds", String(sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sinceMinutes", String(min));
  return t("sinceHoursMinutes", [
    String(Math.floor(min / 60)),
    String(min % 60),
  ]);
}

// Shown as relative time rather than absolute time (HH:MM). Using the same notation as formatSince on
// Perch rows keeps support for 43 locales without extra i18n keys.
// Re-renders happen via setEvents on every poll (3 seconds), so the display naturally keeps up
export function formatEventTime(at: number): string {
  return formatSince(Math.max(0, Date.now() - at));
}
