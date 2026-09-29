import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "@/lib/i18n";
import type { AiProvider, ApiKeyProvider } from "@/lib/fsa";
import type { JudgeErrorKind } from "@/lib/judge";

// TypeSafe's official site (linked from the settings description)
const TYPESAFE_SITE_URL = "https://typesafe.ai";

// Display state of the connection test button. reason is a technical identifier (kind) embedded as is into
// $REASON$ of byokTestResultFailure, and is not localized (treated like an HTTP status).
// The key isn't only for judging, so the type name isn't limited to Judge either (JudgeErrorKind itself
// just reuses the existing name in lib/judge.ts)
export type ApiKeyTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success" }
  | { phase: "failure"; reason: JudgeErrorKind }
  | { phase: "no-key" };

/** All API key settings. The shared description is shown once here; per-provider differences stay inside each row. */
export function AiKeySettings({
  keySet,
  selectedProvider,
  testState,
  onSaveKey,
  onDeleteKey,
  onTest,
  onSelect,
}: {
  keySet: Record<ApiKeyProvider, boolean>;
  selectedProvider: AiProvider | null;
  testState: Record<ApiKeyProvider, ApiKeyTestState>;
  onSaveKey: (provider: ApiKeyProvider, draft: string) => Promise<boolean>;
  onDeleteKey: (provider: ApiKeyProvider) => void;
  onTest: (provider: ApiKeyProvider) => void;
  onSelect: (provider: AiProvider) => void;
}) {
  return (
    <section className="ai-keys">
      <h2>{t("aiApiKeysHeading")}</h2>
      <p className="judge-description">{t("aiApiKeysDescription")}</p>
      <div className="ai-key-provider-list">
        {(["anthropic", "openai", "typesafe"] as const).map((provider) => (
          <ApiKeyProviderSettings
            key={provider}
            provider={provider}
            keySet={keySet[provider]}
            selected={selectedProvider === provider}
            testState={testState[provider]}
            onSaveKey={(draft) => onSaveKey(provider, draft)}
            onDeleteKey={() => onDeleteKey(provider)}
            onTest={() => onTest(provider)}
            onSelect={provider === "typesafe" ? undefined : () => onSelect(provider)}
          />
        ))}
      </div>
    </section>
  );
}

function ApiKeyProviderSettings({
  provider,
  keySet,
  selected,
  testState,
  onSaveKey,
  onDeleteKey,
  onTest,
  onSelect,
}: {
  provider: ApiKeyProvider;
  keySet: boolean;
  selected: boolean;
  testState: ApiKeyTestState;
  onSaveKey: (draft: string) => Promise<boolean>;
  onDeleteKey: () => void;
  onTest: () => void;
  // Passed only for rows that can be chosen as the summary provider (TypeSafe is only for the needs-reply check, not summaries)
  onSelect?: () => void;
}) {
  // Temporary state held only by the key input before saving. Cleared and discarded after saving (no plaintext left behind)
  const [draft, setDraft] = useState("");
  // Whether the input for replacing a saved key is open. The key value isn't shown; you just enter a new one and save
  const [replacing, setReplacing] = useState(false);
  // Whether the last save failed. On failure the input is kept and the failure is shown on this row
  const [saveFailed, setSaveFailed] = useState(false);
  const heading =
    provider === "typesafe"
      ? t("typeSafeApiKeyHeading")
      : provider === "openai"
        ? t("openAiApiKeyHeading")
        : t("aiApiKeyHeading");

  return (
    <div className={`ai-key-provider ai-key-provider-${provider}`}>
      <h3>{heading}</h3>
      {provider === "typesafe" && (
        <p className="judge-description">
          {t("typeSafeApiKeyDescription")} {t("typeSafeUserMessageNote")}{" "}
          {/* Link to the official site so users can see how to get a key. Opens in the external browser, not inside the WebView */}
          <a
            href={TYPESAFE_SITE_URL}
            className="external-link"
            onClick={(e) => {
              e.preventDefault();
              void openUrl(TYPESAFE_SITE_URL).catch(() => window.open(TYPESAFE_SITE_URL, "_blank"));
            }}
          >
            {t("typeSafeSiteLink")}
          </a>
        </p>
      )}
      <div className="judge-key-row">
        {keySet && !replacing ? (
          <>
            <span className="judge-key-set">{t("byokApiKeySetLabel")}</span>
            <button className="small" onClick={() => setReplacing(true)}>
              {t("byokReplaceButton")}
            </button>
            <button className="small remove" onClick={onDeleteKey}>
              {t("byokDeleteButton")}
            </button>
          </>
        ) : (
          <>
            <input
              className="judge-key-input"
              type="password"
              autoComplete="off"
              value={draft}
              placeholder={heading}
              aria-label={heading}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="small"
              onClick={() => {
                void onSaveKey(draft).then((saved) => {
                  setSaveFailed(!saved && draft.trim() !== "");
                  if (!saved) return;
                  setDraft("");
                  setReplacing(false);
                });
              }}
            >
              {t("byokSaveButton")}
            </button>
          </>
        )}
      </div>
      {saveFailed && (
        <p className="judge-status judge-status-error" role="alert">
          {t("byokSaveFailedMessage")}
        </p>
      )}
      {keySet && onSelect && (
        <label className="ai-provider-choice">
          <input
            type="radio"
            name="summary-provider"
            checked={selected}
            onChange={onSelect}
          />
          {t("byokUseForSummaryLabel")}
        </label>
      )}
      {/* Disabled when no key is set, to prevent an action that would only produce a no-key result */}
      <button className="small" onClick={onTest} disabled={!keySet}>
        {t("byokTestButton")}
      </button>
      {testState.phase === "testing" && (
        <p className="judge-status">{t("byokTestingLabel")}</p>
      )}
      {testState.phase === "success" && (
        <p className="judge-status judge-status-ok">
          {t("byokTestResultSuccess")}
        </p>
      )}
      {testState.phase === "failure" && (
        <p className="judge-status judge-status-error">
          {t("byokTestResultFailure", testState.reason)}
        </p>
      )}
      {testState.phase === "no-key" && (
        <p className="judge-status judge-status-error">
          {t("byokNoKeyMessage")}
        </p>
      )}
    </div>
  );
}
