import { t } from "@/lib/i18n";
import type { BirdState, SessionView } from "@/lib/sessions";
import { BIRD } from "./bird-glyph";
import { formatSince } from "./format-time";

/**
 * State label. If this session needs a reply (asking), use the needs-reply word even when done or dozing
 * (the word matches the badge). If watching (the peer is working), use the watching word. Even if the peer
 * is asking, a watching bird stays watching
 */
function birdLabel(state: BirdState, asking: boolean, watching = false): string {
  if (asking) return BIRD.waiting.label;
  if (watching) return t("birdWatchingLabel");
  return BIRD[state].label;
}

/** Pulsing dots shown only while working. Makes "rows that are moving" recognizable at a glance.
 * Exported for the chick rows on the Perch (perch-list.tsx) */
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
        {/* During the grace period (within 5 minutes after the peer stopped; watching is 0) it still shows "watching"
            (lib/watching.ts) */}
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
