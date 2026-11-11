// The concierge's bubble in the Concierge tab without a provider (docs/design.md "Concierge", "Without a provider"):
// what the concierge needs, that the other tabs work without it, and a button to the settings' AI section. Inside the
// bubble's .fade-box, so the button takes clicks at rest too
import { t } from "@/lib/i18n";

export function ConciergeSetupNote({ onOpenAiSettings }: { onOpenAiSettings: () => void }) {
  return (
    <span className="concierge-setup">
      <span className="concierge-setup-needs">{t("conciergeSetupNeeds")}</span>
      <span className="concierge-setup-free">{t("conciergeSetupFree")}</span>
      <button
        type="button"
        className="small concierge-setup-button"
        // The bubble's own pointerdown would start a window drag
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpenAiSettings}
      >
        {t("conciergeSetupButton")}
      </button>
    </span>
  );
}
