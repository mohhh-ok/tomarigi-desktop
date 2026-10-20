import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "@/lib/i18n";
import {
  DEFAULT_LOCAL_BASE_URL,
  type AiProvider,
  type AiSettingsProvider,
  type ApiKeyProvider,
  type LocalAiConfig,
} from "@/lib/api-keys";
import type { JudgeErrorKind } from "@/lib/judge";
import { fetchLocalModels, isValidBaseUrl, pickLocalModel } from "@/lib/local-judge";

// TypeSafe's official site (linked from the settings description)
const TYPESAFE_SITE_URL = "https://typesafe.ai";

// Display state of the connection test button. reason picks the failure line (TEST_FAILURE_TEXT); it isn't shown
// The key isn't only for judging, so the type name isn't limited to Judge either (JudgeErrorKind itself
// just reuses the existing name in lib/judge.ts)
export type ApiKeyTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success" }
  | { phase: "failure"; reason: JudgeErrorKind }
  | { phase: "no-key" };

/** All AI settings: the API keys and Local AI. The shared description is shown once here; per-provider differences
 * stay inside each row. */
export function AiKeySettings({
  open,
  keySet,
  storeAvailable,
  localAi,
  selectedProvider,
  testState,
  onSaveKey,
  onDeleteKey,
  onSaveLocal,
  onDeleteLocal,
  onTest,
  onSelect,
}: {
  // Whether the settings screen is showing (it stays mounted while hidden); Local reads the model list only then
  open: boolean;
  keySet: Record<ApiKeyProvider, boolean>;
  // false on a computer without a key store (Linux without Secret Service): says so instead of the key rows
  storeAvailable: boolean;
  // Local AI's base URL and model; null while not set up (docs/design.md "BYOK API keys", Local AI)
  localAi: LocalAiConfig | null;
  selectedProvider: AiProvider | null;
  testState: Record<AiSettingsProvider, ApiKeyTestState>;
  onSaveKey: (provider: ApiKeyProvider, draft: string) => Promise<boolean>;
  onDeleteKey: (provider: ApiKeyProvider) => void;
  onSaveLocal: (config: LocalAiConfig) => void;
  onDeleteLocal: () => void;
  onTest: (provider: AiSettingsProvider, localDraft?: LocalAiConfig) => void;
  onSelect: (provider: AiProvider) => void;
}) {
  // The choice of which one runs summaries and the concierge is shown only when more than one is set up
  const setUp: Record<AiProvider, boolean> = {
    anthropic: storeAvailable && keySet.anthropic,
    openai: storeAvailable && keySet.openai,
    local: localAi !== null,
  };
  const choosable = Object.values(setUp).filter(Boolean).length > 1;
  const keyRow = (provider: ApiKeyProvider) => (
    <ApiKeyProviderSettings
      key={provider}
      provider={provider}
      keySet={keySet[provider]}
      selected={selectedProvider === provider}
      testState={testState[provider]}
      onSaveKey={(draft) => onSaveKey(provider, draft)}
      onDeleteKey={() => onDeleteKey(provider)}
      onTest={() => onTest(provider)}
      onSelect={provider !== "typesafe" && choosable ? () => onSelect(provider) : undefined}
    />
  );
  return (
    <section className="ai-keys">
      <h2>{t("aiApiKeysHeading")}</h2>
      <p className="judge-description">{t("aiApiKeysDescription")}</p>
      {/* Without a key store there is nothing to save keys into, so a note replaces the key rows. Local has no key and
          stays */}
      {!storeAvailable && <p className="judge-description">{t("byokStoreUnavailable")}</p>}
      <div className="ai-key-provider-list">
        {storeAvailable && keyRow("anthropic")}
        {storeAvailable && keyRow("openai")}
        <LocalAiSettings
          open={open}
          config={localAi}
          selected={selectedProvider === "local"}
          testState={testState.local}
          onSave={onSaveLocal}
          onDelete={onDeleteLocal}
          onTest={(draft) => onTest("local", draft)}
          onSelect={choosable ? () => onSelect("local") : undefined}
        />
        {storeAvailable && keyRow("typesafe")}
      </div>
    </section>
  );
}

/** The radio that picks the provider for summaries and the concierge. Shared by the key rows and Local */
function ProviderChoice({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  return (
    <label className="ai-provider-choice">
      <input type="radio" name="summary-provider" checked={selected} onChange={onSelect} />
      {t("byokUseForSummaryLabel")}
    </label>
  );
}

/** Leaves the replace / change input and goes back to the saved state. Shared by the key rows and Local */
function CancelEditButton({ onCancel }: { onCancel: () => void }) {
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

/** What a failed connection test says, by why it failed: what happened and what to check, never the internal kind */
const TEST_FAILURE_TEXT: Record<JudgeErrorKind, Parameters<typeof t>[0]> = {
  auth: "byokTestFailedAuth",
  rate_limit: "byokTestFailedRateLimit",
  server: "byokTestFailedServer",
  network: "byokTestFailedNetwork",
  malformed: "byokTestFailedMalformed",
};

/** The connection test button and its result. Shared by the key rows and Local */
function ConnectionTest({
  enabled,
  testState,
  failureText,
  onTest,
}: {
  // Why it can't be pressed is said by the card, not here
  enabled: boolean;
  testState: ApiKeyTestState;
  // Replaces the generic failure line when a row has a clearer one
  failureText?: string;
  onTest: () => void;
}) {
  return (
    <>
      {/* Disabled when nothing is set up, to prevent an action that would only produce a no-key result, and while a
          test runs ("Testing…" under it says why) */}
      <button className="small" onClick={onTest} disabled={!enabled || testState.phase === "testing"}>
        {t("byokTestButton")}
      </button>
      {testState.phase === "testing" && <p className="judge-status judge-status-pending">{t("byokTestingLabel")}</p>}
      {testState.phase === "success" && <p className="judge-status judge-status-ok">{t("byokTestResultSuccess")}</p>}
      {testState.phase === "failure" && (
        <p className="judge-status judge-status-error">{failureText ?? t(TEST_FAILURE_TEXT[testState.reason])}</p>
      )}
      {testState.phase === "no-key" && <p className="judge-status judge-status-error">{t("byokNoKeyMessage")}</p>}
    </>
  );
}

/** tested's value for a test of the saved settings */
const SAVED = "saved";

/**
 * Local AI: an OpenAI-compatible server (Ollama, LM Studio, ...). The base URL and model are settings, not secrets, so
 * the saved values are shown. The model is picked from the server's list; when the list can't be read it is typed
 */
function LocalAiSettings({
  open,
  config,
  selected,
  testState,
  onSave,
  onDelete,
  onTest,
  onSelect,
}: {
  open: boolean;
  config: LocalAiConfig | null;
  selected: boolean;
  testState: ApiKeyTestState;
  onSave: (config: LocalAiConfig) => void;
  onDelete: () => void;
  // With the form open, the values typed so far are tested (before saving); otherwise the saved ones
  onTest: (draft?: LocalAiConfig) => void;
  onSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? DEFAULT_LOCAL_BASE_URL);
  const [model, setModel] = useState(config?.model ?? "");
  // The model list of the base URL it was read from: loading, the options, or failed (then the model is typed)
  const [models, setModels] = useState<{ baseUrl: string; ids: string[] | "loading" | "failed" } | null>(null);
  // The URL whose list was asked for last: an answer for an older URL that comes back later is dropped
  const requestedRef = useRef<string | null>(null);
  // The model in the field when an answer comes back
  const modelRef = useRef(model);
  modelRef.current = model;
  // Said under the URL field as soon as the URL is wrong; it's also why Save and the test can't be pressed
  const urlInvalid = !isValidBaseUrl(baseUrl);
  // One rule for Save and the connection test (docs/design.md, Local AI)
  const canRun = !urlInvalid && model.trim() !== "";
  const showForm = config === null || editing;
  // What the last test ran on: the base URL and model in the form, or "saved". A result for anything else (other values
  // in the form, or the saved ones once the form opens) isn't shown
  const [tested, setTested] = useState<string | null>(null);
  const draftKey = `${baseUrl.trim()}|${model.trim()}`;
  const shownTest: ApiKeyTestState = tested === (showForm ? draftKey : SAVED) ? testState : { phase: "idle" };

  const loadModels = (url: string) => {
    requestedRef.current = url;
    // An invalid URL isn't asked; the URL error says why when saving
    if (!isValidBaseUrl(url)) {
      setModels(null);
      return;
    }
    setModels({ baseUrl: url, ids: "loading" });
    // The saved model belongs to the saved URL only
    const saved = config && config.baseUrl === url.trim() ? config.model : undefined;
    void fetchLocalModels(url).then((ids) => {
      if (requestedRef.current !== url) return;
      if (!ids || ids.length === 0) {
        setModels({ baseUrl: url, ids: "failed" });
        // Typed by hand from here; another server's model isn't left in the field
        setModel(saved ?? "");
        return;
      }
      // Back on the saved URL after its model was cleared, the saved model comes back
      const picked = pickLocalModel(ids, modelRef.current || (saved ?? ""), saved);
      setModels({ baseUrl: url, ids: picked.options });
      setModel(picked.model);
    });
  };

  // The list is read when the form shows on the open settings screen; after that, when the URL field loses focus with a
  // new URL
  useEffect(() => {
    if (open && showForm) loadModels(baseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showForm]);

  /** Puts the form back to the saved values (or the defaults), dropping what was typed and any list on its way */
  const resetDraft = (to: LocalAiConfig | null) => {
    requestedRef.current = null;
    setBaseUrl(to?.baseUrl ?? DEFAULT_LOCAL_BASE_URL);
    setModel(to?.model ?? "");
    setModels(null);
    setTested(null);
  };

  const save = () => {
    if (!canRun) return;
    onSave({ baseUrl, model });
    setEditing(false);
  };

  const ids = models?.ids;
  return (
    <div className="ai-key-provider ai-key-provider-local">
      <h3>{t("localAiHeading")}</h3>
      <p className="judge-description">{t("localAiDescription")}</p>
      {showForm ? (
        <>
          <div className="local-ai-fields">
            <label className="local-ai-field">
              <span className="local-ai-field-label">{t("localAiBaseUrlLabel")}</span>
              <input
                className="judge-key-input"
                aria-invalid={urlInvalid}
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={baseUrl}
                placeholder={DEFAULT_LOCAL_BASE_URL}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  // Another server's list and model aren't kept: both are read again from the new URL when the field
                  // loses focus, so only a model of that server can be saved. An answer still on its way is dropped
                  if (models !== null) {
                    requestedRef.current = null;
                    setModels(null);
                    setModel("");
                  }
                }}
                onBlur={() => {
                  if (models?.baseUrl !== baseUrl) loadModels(baseUrl);
                }}
              />
              {urlInvalid && (
                <span className="judge-status judge-status-error local-ai-field-error" role="alert">
                  {t("localAiUrlInvalid")}
                </span>
              )}
            </label>
            <label className="local-ai-field">
              <span className="local-ai-field-label">{t("localAiModelLabel")}</span>
              {/* Save sits right of the model field, like the key rows' input and Save */}
              <span className="judge-key-row local-ai-model-row">
                {Array.isArray(ids) ? (
                  <select className="judge-key-input" value={model} onChange={(e) => setModel(e.target.value)}>
                    {ids.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                ) : ids === "loading" ? (
                  <select className="judge-key-input" disabled>
                    <option>{t("localAiModelsLoading")}</option>
                  </select>
                ) : (
                  <input
                    className="judge-key-input"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={model}
                    placeholder={t("localAiModelLabel")}
                    onChange={(e) => setModel(e.target.value)}
                  />
                )}
                <button
                  className="small"
                  onClick={(e) => {
                    // Inside the label, a click would also focus the field
                    e.preventDefault();
                    save();
                  }}
                  disabled={!canRun}
                >
                  {t("byokSaveButton")}
                </button>
                {config !== null && (
                  <CancelEditButton
                    onCancel={() => {
                      setEditing(false);
                      resetDraft(config);
                    }}
                  />
                )}
              </span>
            </label>
          </div>
          {/* The one place that says why Save and the test can't be pressed, besides the URL error (which already says
              it). A list that couldn't be read already asks for the model to be typed. While the list loads, the
              model field says so */}
          {urlInvalid ? null : ids === "failed" && models?.baseUrl === baseUrl ? (
            <div className="local-ai-note">
              <p>{t("localAiModelsFailed")}</p>
              <button className="small" onClick={() => loadModels(baseUrl)}>
                {t("localAiReloadModels")}
              </button>
            </div>
          ) : (
            ids !== "loading" &&
            !model.trim() && (
              <div className="local-ai-note">
                <p>{t("localAiNeedsModel")}</p>
              </div>
            )
          )}
        </>
      ) : (
        <div className="judge-key-row">
          <span className="judge-key-set local-ai-current">
            <span className="local-ai-current-model">{config.model}</span>
            <span className="local-ai-current-url">{config.baseUrl}</span>
          </span>
          <button
            className="small"
            onClick={() => {
              // Opens on the saved values; their last test result isn't carried into the form
              resetDraft(config);
              setEditing(true);
            }}
          >
            {t("localAiChangeButton")}
          </button>
          <button
            className="small remove"
            onClick={() => {
              // The form that opens after deleting starts from the defaults, not from an edit that was cancelled
              resetDraft(null);
              onDelete();
            }}
          >
            {t("byokDeleteButton")}
          </button>
        </div>
      )}
      {/* The choice is about the saved settings, so it isn't shown while they're being edited */}
      {config !== null && !showForm && onSelect && <ProviderChoice selected={selected} onSelect={onSelect} />}
      <ConnectionTest
        enabled={showForm ? canRun : true}
        testState={shownTest}
        // A server that can't be reached is the usual failure here (not started, or a wrong URL), so it says what to check
        failureText={shownTest.phase === "failure" && shownTest.reason === "network" ? t("localAiTestUnreachable") : undefined}
        onTest={() => {
          setTested(showForm ? draftKey : SAVED);
          onTest(showForm ? { baseUrl, model } : undefined);
        }}
      />
    </div>
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
  // Passed only for rows that can be chosen as the summary provider, while more than one is set up (TypeSafe is only for
  // the needs-reply check, not summaries)
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
            {keySet && (
              <CancelEditButton
                onCancel={() => {
                  setDraft("");
                  setSaveFailed(false);
                  setReplacing(false);
                }}
              />
            )}
          </>
        )}
      </div>
      {saveFailed && (
        <p className="judge-status judge-status-error" role="alert">
          {t("byokSaveFailedMessage")}
        </p>
      )}
      {/* Not while a replacement is being typed, the same as Local's change form */}
      {keySet && !replacing && onSelect && <ProviderChoice selected={selected} onSelect={onSelect} />}
      <ConnectionTest enabled={keySet} testState={testState} onTest={onTest} />
    </div>
  );
}
