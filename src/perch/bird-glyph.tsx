import type { CSSProperties } from "react";
import { t } from "@/lib/i18n";
import type { BirdState } from "@/lib/sessions";
import type { IconSetId } from "@/lib/icon-set-store";
import { DEFAULT_ICON_SET, ICON_SETS } from "./icon-sets";

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

/** Shared component that shows a BirdState as a WebP sprite instead of an emoji.
 * alt is empty — callers always put the state label text next to it, so it can be treated as decorative.
 * flip is the horizontal mirror for the garden (if everyone faces the same way it looks stuffed, so it is
 * split half and half based on the id).
 * set is the icon set assigned to the project (DEFAULT_ICON_SET = birds when unspecified).
 * asking means waiting on the user's reply (needsAnswer in lib/jev.ts). Overlays the "?" badge, shared by
 * all icon sets, at the top right. angry overlays the anger mark (isAngry in lib/jev.ts) at the top left; both can
 * show at once. The Garden and the Perch both render through this component */
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
  // Only working gets the "charging aura" effect class (.bird-working-fx in styles/perch-rows.css).
  // flip used to mirror directly with style.transform: scaleX(-1), but while working the CSS animation
  // (sway/peck) owns the same transform property, so it goes through a custom property (--glyph-flip)
  // instead. Both .bird-glyph-img in styles/perch-rows.css (at rest) and each working keyframes (during animation)
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
export function BirdBadge({ kind, inline = false }: { kind: "ask" | "anger"; inline?: boolean }) {
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
