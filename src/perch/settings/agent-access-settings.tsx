// "AI agent" on the settings screen (docs/design.md "Settings by an AI agent (MCP)"): the switch, the one command that
// registers the app with Claude Code, the port, renewing the token, and the changes the agent made in this run
import { useEffect, useRef, useState } from "react";
import { MdCheckCircle, MdContentCopy } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { AgentAccessStatus, AgentChangeEntry } from "../use-agent-access";

// The time of day in the UI language (Intl), so no message key is needed
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const REMOVE_COMMAND = "claude mcp remove --scope user tomarigi";

export function AgentAccessSettings({
  enabled,
  port,
  status,
  command,
  replaced,
  recent,
  onEnabled,
  onPort,
  onRenew,
}: {
  enabled: boolean;
  port: number;
  status: AgentAccessStatus;
  command: string | null;
  replaced: boolean;
  recent: AgentChangeEntry[];
  onEnabled: (enabled: boolean) => void;
  /** false when the port isn't one the field accepts */
  onPort: (port: number) => boolean;
  onRenew: () => void;
}) {
  const [portDraft, setPortDraft] = useState(String(port));
  const [portInvalid, setPortInvalid] = useState(false);
  useEffect(() => setPortDraft(String(port)), [port]);

  const commitPort = () => {
    const ok = onPort(Number(portDraft.trim()));
    setPortInvalid(!ok);
  };

  return (
    <section className="agent-access">
      <h2>{t("agentAccessHeading")}</h2>
      <label className="voice-enable-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        {t("agentAccessEnable")}
      </label>
      <p className="settings-note agent-access-description">{t("agentAccessDescription")}</p>
      {enabled && (
        <div className="agent-access-body">
          {command && (
            <>
              {/* In the order they are run: the old registration is removed before the new command */}
              {replaced && (
                <>
                  <p className="agent-access-hint">{t("agentAccessReplaceHint")}</p>
                  <CommandBlock command={REMOVE_COMMAND} />
                </>
              )}
              <p className="agent-access-hint">{t("agentAccessCommandHint")}</p>
              <CommandBlock command={command} main />
              <p className="settings-note agent-access-secret">{t("agentAccessSecretNote")}</p>
              <p className="settings-note agent-access-other">{t("agentAccessOtherAgents")}</p>
            </>
          )}
          <div className="agent-access-actions">
            <label className="agent-access-port">
              <span className="local-ai-field-label">{t("agentAccessPortLabel")}</span>
              <input
                className="judge-key-input agent-access-port-input"
                inputMode="numeric"
                aria-invalid={portInvalid || status === "port-in-use"}
                value={portDraft}
                onChange={(e) => {
                  setPortDraft(e.target.value);
                  setPortInvalid(false);
                }}
                onBlur={commitPort}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitPort();
                }}
              />
            </label>
            {status === "on" && (
              <button className="small" onClick={onRenew}>
                {t("agentAccessRenewButton")}
              </button>
            )}
          </div>
          {/* Every error of the card under the port row, where the port that may need changing is */}
          {portInvalid ? (
            <p className="judge-status judge-status-error" role="alert">
              {t("agentAccessPortInvalid")}
            </p>
          ) : status === "port-in-use" ? (
            <p className="judge-status judge-status-error" role="alert">
              {t("agentAccessPortInUse")}
            </p>
          ) : (
            status === "failed" && (
              <p className="judge-status judge-status-error" role="alert">
                {t("agentAccessStartFailed")}
              </p>
            )
          )}
        </div>
      )}
      {/* The switch goes back off when it can't be on here, so this shows under it */}
      {status === "no-key-store" && (
        <p className="judge-status judge-status-error agent-access-indent" role="alert">
          {t("agentAccessNoKeyStore")}
        </p>
      )}
      {recent.length > 0 && (
        <div className="agent-access-recent agent-access-indent">
          <h3>{t("agentAccessRecentHeading")}</h3>
          <ul>
            {recent.map((c) => (
              <li key={c.id}>
                <span className="agent-access-time">{clock(c.at)}</span>
                <span>
                  {c.setting}: {c.from} → {c.to}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** A command to paste in a terminal, with a copy button. The whole command shows (it wraps) so it can be read before
 * running it */
function CommandBlock({ command, main = false }: { command: string; main?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      console.warn("[tomarigi] failed to copy the command", error);
    }
  };
  return (
    <div className="agent-access-command">
      {/* One span per word, kept whole, so a line breaks between words and not inside a flag ("--header"); only a word
          longer than the line (the token) breaks inside */}
      <code>
        {command.split(" ").map((word, i) => (
          <span key={i}>
            {i > 0 && " "}
            <span className={word.length > 24 ? "agent-access-word-long" : "agent-access-word"}>{word}</span>
          </span>
        ))}
      </code>
      <button className={main ? "small agent-access-copy agent-access-copy-main" : "small agent-access-copy"} onClick={() => void copy()}>
        {copied ? <MdCheckCircle size={14} aria-hidden="true" /> : <MdContentCopy size={14} aria-hidden="true" />}
        {copied ? t("agentAccessCopied") : t("agentAccessCopyButton")}
      </button>
    </div>
  );
}
