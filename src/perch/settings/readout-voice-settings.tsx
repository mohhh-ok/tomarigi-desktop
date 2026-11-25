// The readout voice: the system's or a local TTS server's (docs/design.md "Readout voice (local TTS server)"). The
// server's card follows Local AI's (ai-key-settings.tsx): the same list rules, the same rule for when Save and the
// sample can be pressed, and one note per card
import { useEffect, useRef, useState } from "react";
import { t, uiLanguage } from "@/lib/i18n";
import { primeAudio } from "@/lib/chirp";
import { isValidBaseUrl, pickLocalModel } from "@/lib/local-judge";
import {
  baseUrlForKind,
  DEFAULT_TTS_BASE_URL,
  serverReadsLanguage,
  voicevoxCreditOf,
  type LocalTtsConfig,
  type ReadoutVoice,
  type TtsKind,
} from "@/lib/readout-voice";
import {
  classifyTestError,
  fetchIsVoicevoxEngine,
  fetchTtsModels,
  fetchTtsVoices,
  type TtsTestFailure,
  type TtsVoiceOption,
} from "@/lib/tts-server";
import { speechAvailable, type ReadoutTestResult } from "@/lib/voice";
import { BusyButton } from "./busy-button";
import { CancelEditButton, CardNote } from "./card-parts";

const TEST_FAILURE_TEXT: Record<TtsTestFailure | "audio", Parameters<typeof t>[0]> = {
  unreachable: "readoutTestUnreachable",
  "wrong-server": "readoutTestWrongServer",
  "no-voice": "readoutTestNoVoice",
  timeout: "readoutTestTimeout",
  server: "readoutTestServerError",
  audio: "readoutTestAudio",
};

// Servers of each kind, shown under the type as product names (the same in every language)
const KIND_EXAMPLES: Record<TtsKind, string> = {
  openai: "Kokoro-FastAPI, mlx-audio",
  voicevox: "VOICEVOX, AivisSpeech",
};

/** A readout slower than this falls back to the system voice (TTS_WAIT_MS in lib/readout-queue.ts) */
const READOUT_WAIT_MS = 5_000;

type TestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; ms: number }
  | { phase: "failure"; reason: TtsTestFailure | "audio" };

type List<T> = T[] | "loading" | "failed";

interface Lists {
  baseUrl: string;
  kind: TtsKind;
  voices: List<TtsVoiceOption>;
  models: List<string>;
  /** VOICEVOX-compatible: the server said it is VOICEVOX ENGINE itself */
  engine: boolean;
}

export function ReadoutVoiceSettings({
  open,
  voice,
  readAloud,
  onSource,
  onSave,
  onDelete,
  onTest,
}: {
  // Whether the settings screen is showing; lists are read only then
  open: boolean;
  voice: ReadoutVoice;
  // "Read aloud with voice" is on; while off, the card says readouts won't be heard (the sample still plays)
  readAloud: boolean;
  onSource: (source: ReadoutVoice["source"]) => void;
  onSave: (config: LocalTtsConfig) => void;
  onDelete: () => void;
  onTest: (config: LocalTtsConfig) => Promise<ReadoutTestResult>;
}) {
  return (
    <div className="readout-voice">
      <span className="readout-voice-label">{t("readoutVoiceLabel")}</span>
      <label className="voice-enable-row">
        <input
          type="radio"
          name="readout-voice"
          checked={voice.source === "system"}
          // Nothing to read with where the system has no speech engine (the note above says so)
          disabled={!speechAvailable()}
          onChange={() => onSource("system")}
        />
        {t("readoutVoiceSystem")}
      </label>
      <label className="voice-enable-row">
        <input
          type="radio"
          name="readout-voice"
          checked={voice.source === "local"}
          onChange={() => onSource("local")}
        />
        {t("readoutVoiceLocal")}
      </label>
      {voice.source === "local" && (
        <LocalTtsCard
          open={open}
          readAloud={readAloud}
          config={voice.local ?? null}
          onSave={onSave}
          onDelete={onDelete}
          onTest={onTest}
        />
      )}
    </div>
  );
}

function LocalTtsCard({
  open,
  readAloud,
  config,
  onSave,
  onDelete,
  onTest,
}: {
  open: boolean;
  readAloud: boolean;
  config: LocalTtsConfig | null;
  onSave: (config: LocalTtsConfig) => void;
  onDelete: () => void;
  onTest: (config: LocalTtsConfig) => Promise<ReadoutTestResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<TtsKind>(config?.kind ?? "openai");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? DEFAULT_TTS_BASE_URL[config?.kind ?? "openai"]);
  const [voiceValue, setVoiceValue] = useState(config?.voice ?? "");
  const [model, setModel] = useState(config?.model ?? "");
  const [lists, setLists] = useState<Lists | null>(null);
  const [test, setTest] = useState<{ key: string; state: TestState }>({ key: "", state: { phase: "idle" } });
  // The URL and kind whose lists were asked for last: an answer for older ones is dropped
  const requestedRef = useRef<string | null>(null);
  const current = useRef({ voiceValue, model });
  current.current = { voiceValue, model };

  const showForm = config === null || editing;
  const urlInvalid = !isValidBaseUrl(baseUrl);
  const needsModel = kind === "openai" && model.trim() === "";
  const needsVoice = voiceValue.trim() === "";
  const canRun = !urlInvalid && !needsModel && !needsVoice;

  const voiceOptions = Array.isArray(lists?.voices) ? lists.voices : undefined;
  const chosenOption = voiceOptions?.find((o) => o.value === voiceValue);
  const draft: LocalTtsConfig = {
    kind,
    baseUrl: baseUrl.trim(),
    voice: voiceValue.trim(),
    voiceLabel: chosenOption?.label ?? (config && voiceValue === config.voice ? config.voiceLabel : undefined),
    speaker: chosenOption?.speaker ?? (config && voiceValue === config.voice ? config.speaker : undefined),
    ...(kind === "openai" && { model: model.trim() }),
    voicevoxCredit:
      kind === "voicevox" &&
      (lists?.baseUrl === baseUrl && lists.kind === kind
        ? lists.engine
        : config?.baseUrl === baseUrl.trim() && config.voicevoxCredit === true),
  };
  const shown = showForm ? draft : config;
  const testKey = JSON.stringify(shown);
  const shownTest = test.key === testKey ? test.state : { phase: "idle" as const };

  const loadLists = (url: string, forKind: TtsKind) => {
    const key = `${forKind}|${url}`;
    requestedRef.current = key;
    if (!isValidBaseUrl(url)) {
      setLists(null);
      return;
    }
    setLists({ baseUrl: url, kind: forKind, voices: "loading", models: forKind === "openai" ? "loading" : [], engine: false });
    // The saved voice and model belong to the saved URL and kind only
    const saved = config && config.baseUrl === url.trim() && config.kind === forKind ? config : undefined;
    void Promise.all([
      fetchTtsVoices(forKind, url),
      forKind === "openai" ? fetchTtsModels(url) : Promise.resolve([] as string[]),
      forKind === "voicevox" ? fetchIsVoicevoxEngine(url) : Promise.resolve(false),
    ]).then(([voices, models, engine]) => {
      if (requestedRef.current !== key) return;
      let voiceList: List<TtsVoiceOption> = "failed";
      if (voices) {
        const picked = pickLocalModel(
          voices.map((v) => v.value),
          current.current.voiceValue || (saved?.voice ?? ""),
          saved?.voice,
        );
        voiceList = picked.options.map(
          (value) => voices.find((v) => v.value === value) ?? { value, label: saved?.voiceLabel ?? value, speaker: saved?.speaker },
        );
        setVoiceValue(picked.model);
      } else {
        setVoiceValue(saved?.voice ?? "");
      }
      let modelList: List<string> = forKind === "openai" ? "failed" : [];
      if (forKind === "openai") {
        if (models) {
          const picked = pickLocalModel(models, current.current.model || (saved?.model ?? ""), saved?.model);
          modelList = picked.options;
          setModel(picked.model);
        } else {
          setModel(saved?.model ?? "");
        }
      }
      setLists({ baseUrl: url, kind: forKind, voices: voiceList, models: modelList, engine });
    });
  };

  useEffect(() => {
    if (open && showForm) loadLists(baseUrl, kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showForm]);

  /** Another server's lists and choices aren't kept; they are read again for the new URL or kind */
  const clearChoices = () => {
    requestedRef.current = null;
    setLists(null);
    setVoiceValue("");
    setModel("");
  };

  const resetDraft = (to: LocalTtsConfig | null) => {
    requestedRef.current = null;
    setKind(to?.kind ?? "openai");
    setBaseUrl(to?.baseUrl ?? DEFAULT_TTS_BASE_URL[to?.kind ?? "openai"]);
    setVoiceValue(to?.voice ?? "");
    setModel(to?.model ?? "");
    setLists(null);
  };

  const save = () => {
    if (!canRun) return;
    onSave(draft);
    setEditing(false);
  };

  const runTest = () => {
    if (!shown) return;
    // Playback needs a user action: the click is one
    primeAudio();
    const key = testKey;
    setTest({ key, state: { phase: "testing" } });
    void onTest(shown).then((result) => {
      const state: TestState = result.ok
        ? { phase: "success", ms: result.ms }
        : { phase: "failure", reason: result.error === "audio" ? "audio" : classifyTestError(shown.kind, result.error).reason };
      setTest((prev) => (prev.key === key ? { key, state } : prev));
    });
  };

  const credit = shown ? voicevoxCreditOf(shown) : undefined;
  const jaOnly = (showForm ? kind : config?.kind) === "voicevox" && !serverReadsLanguage("voicevox", uiLanguage());
  const voicesListed = lists?.baseUrl === baseUrl && lists.kind === kind ? lists : null;
  const unreachableShown = shownTest.phase === "failure" && shownTest.reason === "unreachable";
  const listFailed =
    voicesListed !== null && (voicesListed.voices === "failed" || voicesListed.models === "failed");

  // Next to Save in the form, next to Change / Delete on the saved card: the actions of the card in one row
  const sampleButton = (
    <BusyButton
      label={t("readoutTestButton")}
      busyLabel={t("readoutTestingLabel")}
      busy={shownTest.phase === "testing"}
      disabled={showForm ? !canRun : false}
      onClick={runTest}
    />
  );

  return (
    <div className="ai-key-provider readout-voice-card">
      <p className="judge-description">{t(speechAvailable() ? "readoutFallbackNote" : "readoutFallbackNoSystem")}</p>
      {showForm ? (
        <>
          <div className="local-ai-fields">
            <label className="local-ai-field">
              <span className="local-ai-field-label">{t("readoutKindLabel")}</span>
              <select
                className="judge-key-input"
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as TtsKind;
                  const nextUrl = baseUrlForKind(baseUrl, kind, next);
                  setKind(next);
                  setBaseUrl(nextUrl);
                  clearChoices();
                  loadLists(nextUrl, next);
                }}
              >
                <option value="openai">{t("readoutKindOpenAi")}</option>
                <option value="voicevox">{t("readoutKindVoicevox")}</option>
              </select>
              <span className="readout-voice-examples">{KIND_EXAMPLES[kind]}</span>
              {jaOnly && <span className="readout-voice-warning">{t("readoutVoicevoxJaOnly")}</span>}
            </label>
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
                placeholder={DEFAULT_TTS_BASE_URL[kind]}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  if (lists !== null) clearChoices();
                }}
                onBlur={() => {
                  if (lists?.baseUrl !== baseUrl || lists.kind !== kind) loadLists(baseUrl, kind);
                }}
              />
              {urlInvalid && (
                <span className="judge-status judge-status-error local-ai-field-error" role="alert">
                  {t("localAiUrlInvalid")}
                </span>
              )}
            </label>
            {kind === "openai" && (
              <label className="local-ai-field">
                <span className="local-ai-field-label">{t("localAiModelLabel")}</span>
                <ListField
                  list={voicesListed?.models}
                  value={model}
                  options={(Array.isArray(voicesListed?.models) ? voicesListed.models : []).map((m) => ({ value: m, label: m }))}
                  placeholder={t("localAiModelLabel")}
                  onChange={setModel}
                />
              </label>
            )}
            <label className="local-ai-field">
              <span className="local-ai-field-label">{t("readoutVoiceNameLabel")}</span>
              <ListField
                list={voicesListed?.voices}
                value={voiceValue}
                options={voiceOptions ?? []}
                placeholder={t("readoutVoiceNameLabel")}
                onChange={setVoiceValue}
              />
              {credit && <span className="readout-voice-credit">{credit}</span>}
            </label>
          </div>
          {/* One note: the URL error already says what is wrong; a list that couldn't be read asks for the name, unless
              the sample already said the server can't be reached (the same cause, said once) */}
          {urlInvalid || unreachableShown ? null : listFailed ? (
            <CardNote text={t("readoutListFailed")}>
              <button className="small" onClick={() => loadLists(baseUrl, kind)}>
                {t("localAiReloadModels")}
              </button>
            </CardNote>
          ) : voicesListed?.voices === "loading" ? null : needsModel ? (
            <CardNote text={t("readoutNeedsModel")} />
          ) : (
            needsVoice && <CardNote text={t("readoutNeedsVoice")} />
          )}
          {/* Save applies the whole form, so it sits under it, not beside one field */}
          <div className="readout-voice-actions">
            <button className="small" onClick={save} disabled={!canRun}>
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
            {sampleButton}
          </div>
        </>
      ) : (
        <>
          <span className="judge-key-set local-ai-current readout-voice-current">
            <span className="local-ai-current-model">
              {config.voiceLabel ?? config.voice}
              {config.model ? ` · ${config.model}` : ""}
            </span>
            <span className="local-ai-current-url">
              {t(config.kind === "openai" ? "readoutKindOpenAi" : "readoutKindVoicevox")} · {config.baseUrl}
            </span>
            {credit && <span className="readout-voice-credit">{credit}</span>}
          </span>
          {jaOnly && <p className="readout-voice-warning">{t("readoutVoicevoxJaOnly")}</p>}
          <div className="readout-voice-actions">
          <button
            className="small"
            onClick={() => {
              resetDraft(config);
              setEditing(true);
            }}
          >
            {t("localAiChangeButton")}
          </button>
          <button
            className="small remove"
            onClick={() => {
              resetDraft(null);
              onDelete();
            }}
          >
            {t("byokDeleteButton")}
          </button>
          {sampleButton}
          </div>
        </>
      )}
      {shownTest.phase === "success" && (
        <p className="judge-status judge-status-ok">
          {/* The number and its unit stay on one line */}
          {t("readoutTestOk", (shownTest.ms / 1000).toFixed(1)).replace(/(\d) /, "$1\u00a0")}
          {shownTest.ms > READOUT_WAIT_MS && ` ${t("readoutTestSlow")}`}
        </p>
      )}
      {shownTest.phase === "failure" && (
        <p className="judge-status judge-status-error">{t(TEST_FAILURE_TEXT[shownTest.reason])}</p>
      )}
      {/* The sample plays either way; readouts are heard only with "Read aloud" on. Last in the card, apart from the
          server's own notes, so what was set is read first */}
      {!readAloud && <p className="readout-voice-warning readout-voice-read-aloud">{t("readoutNeedsReadAloud")}</p>}
    </div>
  );
}

/** A choice from the server's list, a disabled "loading" choice, or a text field when the list can't be read */
function ListField({
  list,
  value,
  options,
  placeholder,
  onChange,
}: {
  list: List<unknown> | undefined;
  value: string;
  options: { value: string; label: string }[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  if (Array.isArray(list) && options.length > 0) {
    return (
      <select className="judge-key-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (list === "loading") {
    return (
      <select className="judge-key-input" disabled>
        <option>{t("localAiModelsLoading")}</option>
      </select>
    );
  }
  return (
    <input
      className="judge-key-input"
      type="text"
      autoComplete="off"
      spellCheck={false}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
