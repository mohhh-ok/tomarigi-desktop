import { Fragment, useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { hasQuestion, isAngry, needsAnswer } from "@/lib/jev";
import type { SessionView } from "@/lib/sessions";
import type { IconSetAssignments } from "@/lib/icon-set-store";
import { bubbleText, SpeechBubble } from "./bubble";
import { BIRD, BirdGlyph } from "./bird-glyph";
import { LiveDots, StatusParts } from "./bird-status";
import { focusProps } from "./focus";
import { formatSince } from "./format-time";
import { ICON_SETS, resolveIconSet } from "./icon-sets";
import { orderByWatchLinks, relativeLabel } from "./watch-links";

// The request excerpt on a Perch row is hidden entirely when narrower than this (so fragments like "「." aren't shown)
const SNIPPET_MIN_VISIBLE_EM = 2.5;

/** The request excerpt on a Perch row. Its width is set by .bird-row-snippet in styles/perch-row-layout.css; this only hides it
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
              {/* When width runs short, the shrink order is request excerpt → name → status (.bird-row-* in styles/perch-row-layout.css).
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
