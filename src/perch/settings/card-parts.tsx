// Parts shared by the settings cards that are edited and saved: the AI keys, Local AI, and the local TTS server
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

/** Leaves the replace / change input and goes back to the saved state. Shared by the key rows, Local AI and the local TTS server */
export function CancelEditButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      className="small"
      onClick={(e) => {
        // Inside a label, a click would also focus the field
        e.preventDefault();
        onCancel();
      }}
    >
      {t("cancelButton")}
    </button>
  );
}

/** Why Save or the connection test can't be pressed yet: the one place of a card that says it, under its fields
 * (docs/design.md, Local AI). Shared by the key rows, Local AI and the local TTS server */
export function CardNote({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="ai-card-note">
      <p>{text}</p>
      {children}
    </div>
  );
}

