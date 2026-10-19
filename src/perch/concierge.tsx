// The concierge's look (docs/design.md "Concierge"): the image the user picked (owl or penguin), the same in every
// icon set so it reads as different from the session birds, the one line of advice above the Perch / Recent activity
// lists, and the choice of look in settings. The Garden's concierge bird is a GardenNode (garden.tsx) drawn with
// ConciergeGlyph
import type { CSSProperties } from "react";
import { t } from "@/lib/i18n";
import { CONCIERGE_LOOKS, type ConciergeAdvice, type ConciergeLook } from "@/lib/concierge";
import owlImg from "@/assets/concierge/owl.webp";
import penguinImg from "@/assets/concierge/penguin.webp";
import { SpeechBubble } from "./bubble";
import { focusProps } from "./focus";

/** Id of the concierge's node in the Garden. Saved positions are keyed by it like a session's id */
export const CONCIERGE_ID = "concierge";

const CONCIERGE_IMG: Record<ConciergeLook, string> = { owl: owlImg, penguin: penguinImg };

export function ConciergeGlyph({ look, size }: { look: ConciergeLook; size: number }) {
  return (
    <span className="bird-glyph concierge-glyph" style={{ "--glyph-size": `${size}px` } as CSSProperties}>
      <img className="bird-glyph-img" src={CONCIERGE_IMG[look]} width={size} height={size} alt="" draggable={false} />
    </span>
  );
}

/**
 * Perch and Recent activity: the advice above the list, laid out like a Perch row (the concierge and its name on the
 * first line, the advice on the second) so the full line fits. Clicking it jumps like the Garden's concierge
 */
export function ConciergeLine({
  advice,
  look,
  onFocus,
  canFocus,
}: {
  advice: ConciergeAdvice | null;
  look: ConciergeLook;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
}) {
  if (!advice) return null;
  const focus = advice.targetId ? focusProps(advice.targetId, onFocus, canFocus) : {};
  return (
    <div className={`concierge-line ${focus.className ?? ""}`} onClick={focus.onClick} title={t("conciergeTitle")}>
      <div className="bird-row-main">
        <ConciergeGlyph look={look} size={18} />
        <span className="name concierge-line-name">{t("conciergeName")}</span>
      </div>
      <SpeechBubble text={advice.line} placement="row" />
    </div>
  );
}

const LOOK_LABEL: Record<ConciergeLook, () => string> = {
  owl: () => t("conciergeLookOwl"),
  penguin: () => t("conciergeLookPenguin"),
};

/** Settings: which look the concierge has. Saved and applied right away, like the other settings */
export function ConciergeSettings({
  look,
  onChange,
}: {
  look: ConciergeLook;
  onChange: (look: ConciergeLook) => void;
}) {
  return (
    <section className="concierge-settings">
      <h2>{t("conciergeName")}</h2>
      <p className="settings-note">{t("conciergeSettingsNote")}</p>
      <div className="concierge-look-choices" role="radiogroup" aria-label={t("conciergeName")}>
        {CONCIERGE_LOOKS.map((option) => (
          <label key={option} className={option === look ? "concierge-look selected" : "concierge-look"}>
            <input
              type="radio"
              name="concierge-look"
              checked={option === look}
              onChange={() => onChange(option)}
            />
            <ConciergeGlyph look={option} size={40} />
            {LOOK_LABEL[option]()}
          </label>
        ))}
      </div>
    </section>
  );
}
