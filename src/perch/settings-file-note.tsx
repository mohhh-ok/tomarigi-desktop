// The note shown for a few seconds when an edit of the settings file is taken (docs/design.md "Settings file"): what
// changed, from what to what, and what was refused and why. Several stack. The settings' "Settings file" section keeps
// the list of this launch, for the ones made while the window was hidden
import { MdClose } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { FileNoteLine } from "./use-settings-file";

// The close button: the note covers the tab row while it shows
export function SettingsFileNote({ notes, onDismiss }: { notes: FileNoteLine[]; onDismiss: () => void }) {
  if (notes.length === 0) return null;
  return (
    <div className="settings-file-note" role="status">
      <button className="settings-file-note-close" onClick={onDismiss} aria-label={t("settingsFileNoteDismiss")} title={t("settingsFileNoteDismiss")}>
        <MdClose size={16} />
      </button>
      <p className="settings-file-note-title">
        {t(notes.every((n) => n.unreadable) ? "settingsFileUnreadableTitle" : "settingsFileNoteTitle")}
      </p>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className={n.problem ? "settings-file-problem" : undefined}>
            {n.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
