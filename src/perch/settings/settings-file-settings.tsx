// "Settings file" on the settings screen (docs/design.md "Settings file", Detailed design (g)): where the file is, a
// button that shows it in the file manager, the instruction to paste into an AI agent, and what this launch took from
// the file. While it applies, the note that the MCP server was removed, with the command that unregisters it
import { useEffect, useRef, useState } from "react";
import { MdCheckCircle, MdClose, MdContentCopy, MdFolderOpen } from "react-icons/md";
import { t, type MessageName } from "@/lib/i18n";
import type { FileNoteLine } from "../use-settings-file";

export interface SettingsFilePaths {
  settings: string;
  settingsAbsolute: string;
  readme: string;
  log: string;
}

const REMOVE_COMMAND = "claude mcp remove --scope user tomarigi";
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const REVEAL: MessageName = navigator.userAgent.includes("Mac")
  ? "settingsFileRevealMac"
  : navigator.userAgent.includes("Windows")
    ? "settingsFileRevealWindows"
    : "settingsFileRevealLinux";

export function SettingsFileSettings({
  paths,
  recent,
  mcpNote,
  onCloseMcpNote,
  onReveal,
}: {
  paths: SettingsFilePaths | null;
  recent: FileNoteLine[];
  mcpNote: boolean;
  onCloseMcpNote: () => void;
  onReveal: (path: string) => void;
}) {
  return (
    <section className="settings-file">
      <h2>{t("settingsFileHeading")}</h2>
      {mcpNote && (
        <div className="settings-file-mcp" role="status">
          <button className="settings-file-mcp-close" onClick={onCloseMcpNote} aria-label={t("settingsFileCloseNote")} title={t("settingsFileCloseNote")}>
            <MdClose size={16} />
          </button>
          <p className="settings-file-mcp-title">{t("settingsFileMcpRemoved")}</p>
          <p className="settings-note">{t("settingsFileMcpRemovedWhy")}</p>
          <p className="settings-note">{t("settingsFileMcpRemoveHint")}</p>
          <CodeBlock text={REMOVE_COMMAND} label={t("settingsFileCopyCommand")} />
          <p className="settings-note">{t("settingsFileMcpRemoveOther")}</p>
        </div>
      )}
      <p className="settings-note">{t("settingsFileDescription")}</p>
      {paths && (
        <>
          <div className="settings-file-path">
            <code>{paths.settings}</code>
            <div className="settings-file-path-actions">
              <CopyButton text={paths.settings} label={t("settingsFileCopyPath")} />
              <button className="small settings-file-copy" onClick={() => onReveal(paths.settingsAbsolute)}>
                <MdFolderOpen size={14} aria-hidden="true" />
                {t(REVEAL)}
              </button>
            </div>
          </div>
          <h3>{t("settingsFileAgentHeading")}</h3>
          <p className="settings-note">{t("settingsFileAgentHint")}</p>
          <CodeBlock text={t("settingsFileInstructions", paths.readme)} label={t("settingsFileCopyInstructions")} main />
        </>
      )}
      {recent.length > 0 && (
        <div className="settings-file-recent">
          <h3>{t("settingsFileRecentHeading")}</h3>
          <ul>
            {recent.map((c) => (
              <li key={c.id} className={c.problem ? "settings-file-problem" : undefined}>
                <span className="settings-file-time">{clock(c.at)}</span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Text to paste somewhere, shown whole (it wraps) so it can be read before it is used, with its copy button */
function CodeBlock({ text, label, main = false }: { text: string; label: string; main?: boolean }) {
  return (
    <div className="settings-file-code">
      <code>{text}</code>
      <CopyButton text={text} label={label} main={main} />
    </div>
  );
}

function CopyButton({ text, label, main = false }: { text: string; label: string; main?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      console.warn("[tomarigi] failed to copy", error);
    }
  };
  return (
    <button className={main ? "small settings-file-copy settings-file-copy-main" : "small settings-file-copy"} onClick={() => void copy()}>
      {copied ? <MdCheckCircle size={14} aria-hidden="true" /> : <MdContentCopy size={14} aria-hidden="true" />}
      {copied ? t("settingsFileCopied") : label}
    </button>
  );
}
