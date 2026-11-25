import { t } from "@/lib/i18n";
import type { WindowMode } from "../window-mode";

/** Floating window / standard window (also from the menu bar menu; window-mode.ts) */
export function WindowModeSettings({ mode, onChange }: { mode: WindowMode; onChange: (mode: WindowMode) => void }) {
  return (
    <section className="window-mode">
      <h2>{t("windowModeHeading")}</h2>
      <label className="voice-enable-row">
        <input type="radio" name="window-mode" checked={mode === "floating"} onChange={() => onChange("floating")} />
        {t("windowModeFloating")}
      </label>
      <label className="voice-enable-row">
        <input type="radio" name="window-mode" checked={mode === "normal"} onChange={() => onChange("normal")} />
        {t("windowModeNormal")}
      </label>
    </section>
  );
}
