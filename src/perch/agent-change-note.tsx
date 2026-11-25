// The note shown for a few seconds when the AI agent changes a setting (docs/design.md "Settings by an AI agent
// (MCP)"): what changed, from what to what. Several changes stack. The settings card keeps the list of this run's
// changes, for the ones made while the window was hidden
import { t } from "@/lib/i18n";
import type { AgentChangeEntry } from "./use-agent-access";

export function AgentChangeNote({ notes }: { notes: AgentChangeEntry[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="agent-change-note" role="status">
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
