// The note shown for a few seconds when the AI agent changes a setting (docs/design.md "Settings by an AI agent
// (MCP)"): what changed, from what to what. Several changes stack. The settings card keeps the list of this run's
// changes, for the ones made while the window was hidden
import { MdClose } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { AgentChangeEntry } from "./use-agent-access";

// The close button: the note covers the tab row while it shows
export function AgentChangeNote({ notes, onDismiss }: { notes: AgentChangeEntry[]; onDismiss: () => void }) {
  if (notes.length === 0) return null;
  return (
    <div className="agent-change-note" role="status">
      <button className="agent-change-note-close" onClick={onDismiss} aria-label={t("agentNoteDismiss")} title={t("agentNoteDismiss")}>
        <MdClose size={14} />
      </button>
      <p className="agent-change-note-title">{t("agentNoteTitle")}</p>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            {n.setting}: {n.from} → {n.to}
          </li>
        ))}
      </ul>
    </div>
  );
}
