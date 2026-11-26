import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setChirpVolume } from "@/lib/chirp";
import {
  KEY_CHIRP_VOLUME,
  KEY_CONCIERGE_LOOK,
  KEY_MUTED,
  KEY_VOICE_ENABLED,
  KEY_VOICE_VOLUME,
  loadChirpVolume,
  loadMuted,
  loadVoiceEnabled,
  loadVoiceVolume,
  saveChirpVolume,
  saveMuted,
  saveVoiceEnabled,
  saveVoiceVolume,
  loadConciergeLook,
  saveConciergeLook,
} from "@/lib/settings-store";
import { DEFAULT_CONCIERGE_LOOK, type ConciergeLook } from "@/lib/concierge";
import {
  anyAiProviderSetUp,
  deleteAiProvider,
  deleteApiKey,
  deleteLocalAiConfig,
  deleteRetiredKey,
  initApiKeys,
  KEY_AI_PROVIDER,
  KEY_LOCAL_AI,
  loadAiProvider,
  loadApiKeyBackend,
  loadApiKeyStatus,
  loadLocalAiConfig,
  loadRetiredKeysSaved,
  resolveAiProvider,
  saveAiProvider,
  saveApiKey,
  saveLocalAiConfig,
  type AiProvider,
  type AiSettingsProvider,
  type ApiKeyProvider,
  type LocalAiConfig,
  type RetiredKeyProvider,
} from "@/lib/api-keys";
import {
  KEY_ICON_SET_ASSIGNMENTS,
  loadIconSetAssignments,
  saveIconSetAssignments,
  type IconSetAssignments,
  type IconSetId,
} from "@/lib/icon-set-store";
import { testJudgeConnection } from "@/lib/judge";
import { testOpenAiConnection } from "@/lib/openai-judge";
import { testLocalConnection } from "@/lib/local-judge";
import { cancelSpeech, setReadoutVoice, setVoiceVolume, testReadoutVoice, type ReadoutTestResult } from "@/lib/voice";
import {
  KEY_READOUT_VOICE,
  loadReadoutVoice,
  saveReadoutVoice,
  SYSTEM_VOICE,
  type LocalTtsConfig,
  type ReadoutVoice,
} from "@/lib/readout-voice";
import { t } from "@/lib/i18n";
import { API_KEYS_SETTING, onSettingsChanged } from "@/lib/settings-sync";
import { listenVoiceMenu, reportVoiceMenu } from "./voice-menu";
import { DEFAULT_ICON_SET } from "./icon-sets";
import type { ApiKeyTestState } from "./settings/ai-key-settings";

/** The settings in the settings view (sound, readout, API keys, icon sets): their state, loading, and saving.
 * App.tsx awaits loadSettings() inside its startup load, after the watched folders and before the first scan */
/** "owner" is the floating window, which runs what the settings drive (the startup imports, the menu bar's "Read aloud",
 * stopping speech); "settings" is the settings window, which only shows and saves them (docs/design.md "Settings window") */
export type SettingsRole = "owner" | "settings";

export function useSettings(role: SettingsRole) {
  const [muted, setMuted] = useState(false);
  const [chirpVolume, setChirpVolumeState] = useState(1);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceVolume, setVoiceVolumeState] = useState(1);
  // API keys are a setting shared by the done readout summary (speakDoneEvent) and the connection test, so the name isn't limited to judge
  // false on a computer without a key store (Linux without Secret Service); the settings say keys can't be saved
  const [keyStoreAvailable, setKeyStoreAvailable] = useState(true);
  const [aiKeySet, setAiKeySet] = useState<Record<ApiKeyProvider, boolean>>({
    anthropic: false,
    openai: false,
  });
  // Retired providers (TypeSafe) whose key is still saved; the settings show a row with only Delete for each
  const [retiredKeys, setRetiredKeys] = useState<RetiredKeyProvider[]>([]);
  // Local AI's base URL and model (docs/design.md "BYOK API keys", Local AI); null while not set up
  const [localAi, setLocalAi] = useState<LocalAiConfig | null>(null);
  const [aiKeyTestState, setAiKeyTestState] = useState<Record<AiSettingsProvider, ApiKeyTestState>>({
    anthropic: { phase: "idle" },
    openai: { phase: "idle" },
    local: { phase: "idle" },
  });
  const [aiProvider, setAiProvider] = useState<AiProvider | null>(null);
  // Per-project icon set assignments (issue #14). A slug → {set, label} map.
  // Perch/Garden/IconSetSettings look up this map via resolveIconSet (lib/icon-set-store.ts)
  // and fall back to DEFAULT_ICON_SET when there is no assignment
  const [iconSetAssignments, setIconSetAssignments] = useState<IconSetAssignments>({});
  // The concierge's look (docs/design.md "Concierge"), the same in every icon set
  const [conciergeLook, setConciergeLook] = useState<ConciergeLook>(DEFAULT_CONCIERGE_LOOK);
  // System voice or a local TTS server (docs/design.md "Readout voice (local TTS server)")
  const [readoutVoice, setReadoutVoiceState] = useState<ReadoutVoice>(SYSTEM_VOICE);
  const readoutVoiceRef = useRef(readoutVoice);
  const mutedRef = useRef(muted);
  const voiceEnabledRef = useRef(voiceEnabled);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  const loadSound = useCallback(async () => {
    const m = await loadMuted();
    mutedRef.current = m;
    setMuted(m);
    const cVolume = await loadChirpVolume();
    setChirpVolumeState(cVolume);
    setChirpVolume(cVolume);
  }, []);

  /** "Read aloud", its volume and the voice. Applied to this window's module values too (lib/voice.ts), so a sample
   * played in the settings window uses them. Only the owner reports to the menu bar item and stops speech */
  const loadReadout = useCallback(async () => {
    const voice = await loadVoiceEnabled();
    const wasOn = voiceEnabledRef.current;
    voiceEnabledRef.current = voice;
    setVoiceEnabled(voice);
    const volume = await loadVoiceVolume();
    setVoiceVolumeState(volume);
    setVoiceVolume(volume);
    const readout = await loadReadoutVoice();
    readoutVoiceRef.current = readout;
    setReadoutVoiceState(readout);
    setReadoutVoice(readout);
    if (role === "owner") {
      // Where the system has no speech engine, the menu item's "available" depends on the voice just set
      reportVoiceMenu(voice);
      if (wasOn && !voice) cancelSpeech();
    }
  }, [role]);

  const loadAi = useCallback(async () => {
    const [keyStatus, retired, preferredProvider, keyBackend, local] = await Promise.all([
      loadApiKeyStatus(),
      loadRetiredKeysSaved(),
      loadAiProvider(),
      loadApiKeyBackend(),
      loadLocalAiConfig(),
    ]);
    setKeyStoreAvailable(keyBackend !== "unavailable");
    const resolvedProvider = resolveAiProvider(preferredProvider, {
      anthropic: keyStatus.anthropic,
      openai: keyStatus.openai,
      local: local !== undefined,
    });
    setAiKeySet(keyStatus);
    setRetiredKeys(retired);
    setLocalAi(local ?? null);
    setAiProvider(resolvedProvider ?? null);
    return { keyStatus, retired, local, preferredProvider, resolvedProvider };
  }, []);

  const loadLooks = useCallback(async () => {
    setIconSetAssignments(await loadIconSetAssignments());
    setConciergeLook(await loadConciergeLook());
  }, []);

  const loadSettings = useCallback(async () => {
    if (role === "settings") {
      await Promise.all([loadSound(), loadReadout(), loadAi(), loadLooks()]);
      return;
    }
    await loadSound();
    // For verification: TOMARIGI_LOCAL_TTS sets the local readout voice, turns "Read aloud" on, and logs its test (README)
    const ttsImport = await invoke<string[] | null>("local_tts_import").catch(() => null);
    if (ttsImport && (ttsImport[0] === "openai" || ttsImport[0] === "voicevox")) {
      const [kind, baseUrl, voice, model] = ttsImport;
      const local: LocalTtsConfig = { kind, baseUrl, voice, ...(kind === "openai" && { model }), voicevoxCredit: false };
      await saveReadoutVoice({ source: "local", local });
      await saveVoiceEnabled(true);
      void invoke("log", { line: `[voice] imported local kind=${kind} voice=${voice}` }).catch(() => {});
      await loadReadout();
      // Without a click there is no AudioContext, so the sample's playback fails (error=audio); the request still runs
      void testReadoutVoice(local, t(kind === "voicevox" ? "readoutTestSampleJa" : "readoutTestSample"));
    } else {
      await loadReadout();
    }
    // Rust holds the keys (docs/design.md "BYOK API keys"). After migrating keys an earlier version left in IndexedDB
    // (the keychain version) and handing over from dev's IndexedDB, it only asks whether each key is saved
    try {
      await initApiKeys();
    } catch (e) {
      console.warn("[tomarigi] failed to initialize API keys", e);
    }
    // For verification: TOMARIGI_LOCAL_AI sets up Local and chooses it, then logs the connection test (README)
    const imported = await invoke<[string, string] | null>("local_ai_import").catch(() => null);
    if (imported) {
      const [baseUrl, model] = imported;
      await saveLocalAiConfig({ baseUrl, model });
      await saveAiProvider("local");
      const test = await testLocalConnection();
      void invoke("log", {
        line: `[keys] imported local model=${model} test=${test.ok ? "ok" : `${test.kind} ${test.message ?? ""}`}`,
      }).catch(() => {});
    }
    const { keyStatus, retired, local, preferredProvider, resolvedProvider } = await loadAi();
    // Log whether each key is saved (a boolean only). Key values are never received or printed
    void invoke("log", {
      line: `[keys] status anthropic=${keyStatus.anthropic} openai=${keyStatus.openai} local=${local !== undefined} retired=${retired.join(",") || "-"}`,
    });
    // Inconsistencies from old data or from deleting the key in use are normalized once to the available side.
    if (resolvedProvider && resolvedProvider !== preferredProvider) {
      await saveAiProvider(resolvedProvider);
    }
    await loadLooks();
  }, [role, loadSound, loadReadout, loadAi, loadLooks]);

  // A save in another window (the settings window, or the floating window's mute button, the menu bar's "Read aloud"
  // and an edit of the settings file) reloads what changed (docs/design.md "Settings window")
  useEffect(
    () =>
      onSettingsChanged(
        [
          KEY_MUTED,
          KEY_CHIRP_VOLUME,
          KEY_VOICE_ENABLED,
          KEY_VOICE_VOLUME,
          KEY_READOUT_VOICE,
          API_KEYS_SETTING,
          KEY_AI_PROVIDER,
          KEY_LOCAL_AI,
          KEY_ICON_SET_ASSIGNMENTS,
          KEY_CONCIERGE_LOOK,
        ],
        (key) => {
          if (key === KEY_MUTED || key === KEY_CHIRP_VOLUME) void loadSound();
          else if (key === KEY_VOICE_ENABLED || key === KEY_VOICE_VOLUME || key === KEY_READOUT_VOICE) void loadReadout();
          else if (key === API_KEYS_SETTING || key === KEY_AI_PROVIDER || key === KEY_LOCAL_AI) {
            void loadAi();
            setAiKeyTestState({ anthropic: { phase: "idle" }, openai: { phase: "idle" }, local: { phase: "idle" } });
          } else void loadLooks();
        },
      ),
    [loadSound, loadReadout, loadAi, loadLooks],
  );

  const changeMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMuted(next);
    void saveMuted(next);
  }, []);

  const toggleMuted = useCallback(() => changeMuted(!mutedRef.current), [changeMuted]);

  // From the settings checkbox and from the menu bar menu's "Read aloud" item (voice-menu.ts), so both show the same value.
  // voiceEnabledRef is set here too: the menu item works while the window is hidden, and the next readout must see the
  // new value even before React renders again
  const changeVoiceEnabled = useCallback((next: boolean) => {
    voiceEnabledRef.current = next;
    setVoiceEnabled(next);
    void saveVoiceEnabled(next);
    if (role === "owner") reportVoiceMenu(next);
    // OFF is an "I want quiet" action, so speech that is playing or queued stops immediately too (in the floating
    // window through its reload)
    if (!next) cancelSpeech();
  }, [role]);

  const toggleVoiceEnabled = useCallback(() => changeVoiceEnabled(!voiceEnabledRef.current), [changeVoiceEnabled]);

  useEffect(() => (role === "owner" ? listenVoiceMenu(changeVoiceEnabled) : undefined), [role, changeVoiceEnabled]);

  // Slider (input shown as 0–100, internal value 0–1). The module variable in lib/voice.ts is read at the
  // "moment" of speaking, so here it is enough to apply it with setVoiceVolume right along with the state
  // update (the volume changes from the next utterance)
  const changeVoiceVolume = useCallback((next: number) => {
    setVoiceVolumeState(next);
    setVoiceVolume(next);
    void saveVoiceVolume(next);
  }, []);

  // Volume for chirps. Like masterGain in lib/chirp.ts it uses a module variable, so changes are applied
  // immediately with setChirpVolume (the preview buttons go through the same path, so a preview right after
  // moving the slider reflects it immediately)
  const changeChirpVolume = useCallback((next: number) => {
    setChirpVolumeState(next);
    setChirpVolume(next);
    void saveChirpVolume(next);
  }, []);

  const applyReadoutVoice = useCallback(async (next: ReadoutVoice) => {
    readoutVoiceRef.current = next;
    setReadoutVoiceState(next);
    setReadoutVoice(next);
    // The menu item's "available" depends on the voice where the system has none
    if (role === "owner") reportVoiceMenu(voiceEnabledRef.current);
    await saveReadoutVoice(next);
  }, [role]);

  /** "System voice" / "Local server". The local config is kept either way */
  const changeReadoutSource = useCallback(
    (source: ReadoutVoice["source"]) => {
      void applyReadoutVoice({ ...readoutVoiceRef.current, source });
      void invoke("log", { line: `[voice] source=${source}` }).catch(() => {});
    },
    [applyReadoutVoice],
  );

  const saveLocalTts = useCallback(
    (local: LocalTtsConfig) => {
      void applyReadoutVoice({ source: "local", local });
      void invoke("log", { line: `[voice] saved local kind=${local.kind}` }).catch(() => {});
    },
    [applyReadoutVoice],
  );

  const removeLocalTts = useCallback(() => {
    void applyReadoutVoice({ source: readoutVoiceRef.current.source });
    void invoke("log", { line: "[voice] deleted local" }).catch(() => {});
  }, [applyReadoutVoice]);

  const runTtsTest = useCallback(
    (config: LocalTtsConfig): Promise<ReadoutTestResult> =>
      testReadoutVoice(config, t(config.kind === "voicevox" ? "readoutTestSampleJa" : "readoutTestSample")),
    [],
  );

  /** After saving, the draft isn't kept anywhere (no plaintext key left in state) */
  // true if saved. On failure (can't write to the keychain, etc.) it returns false so the settings row shows the failure
  const saveAiKey = useCallback(async (provider: ApiKeyProvider, draft: string): Promise<boolean> => {
    const trimmed = draft.trim();
    if (!trimmed) return false;
    try {
      await saveApiKey(provider, trimmed);
    } catch (e) {
      void invoke("log", { line: `[keys] save failed ${provider}: ${String(e).slice(0, 120)}` }).catch(() => {});
      return false;
    }
    setAiKeySet((current) => ({ ...current, [provider]: true }));
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "idle" } }));
    // The summary provider auto-selects the first one set up. If one is already selected, saving a second doesn't switch it
    if (!aiProvider) {
      await saveAiProvider(provider);
      setAiProvider(provider);
    }
    return true;
  }, [aiProvider]);

  const removeAiKey = useCallback(async (provider: ApiKeyProvider) => {
    await deleteApiKey(provider);
    const nextKeySet = { ...aiKeySet, [provider]: false };
    setAiKeySet(nextKeySet);
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "idle" } }));
    if (aiProvider === provider) {
      const nextProvider = resolveAiProvider(undefined, {
        anthropic: nextKeySet.anthropic,
        openai: nextKeySet.openai,
        local: localAi !== null,
      });
      setAiProvider(nextProvider ?? null);
      if (nextProvider) await saveAiProvider(nextProvider);
      else await deleteAiProvider();
    }
  }, [aiKeySet, aiProvider, localAi]);

  /** Deletes a retired provider's key (docs/design.md "BYOK API keys": TypeSafe (Jev) is no longer used) */
  const removeRetiredKey = useCallback(async (provider: RetiredKeyProvider) => {
    await deleteRetiredKey(provider);
    setRetiredKeys(await loadRetiredKeysSaved());
  }, []);

  /** Saves Local's base URL and model (replacing works the same way) */
  const saveLocalAi = useCallback(async (config: LocalAiConfig) => {
    await saveLocalAiConfig(config);
    setLocalAi({ baseUrl: config.baseUrl.trim(), model: config.model.trim() });
    setAiKeyTestState((current) => ({ ...current, local: { phase: "idle" } }));
    void invoke("log", { line: `[keys] saved local model=${config.model.trim()}` }).catch(() => {});
    if (!aiProvider) {
      await saveAiProvider("local");
      setAiProvider("local");
    }
  }, [aiProvider]);

  const removeLocalAi = useCallback(async () => {
    await deleteLocalAiConfig();
    setLocalAi(null);
    setAiKeyTestState((current) => ({ ...current, local: { phase: "idle" } }));
    void invoke("log", { line: "[keys] deleted local" }).catch(() => {});
    if (aiProvider === "local") {
      const nextProvider = resolveAiProvider(undefined, {
        anthropic: aiKeySet.anthropic,
        openai: aiKeySet.openai,
        local: false,
      });
      setAiProvider(nextProvider ?? null);
      if (nextProvider) await saveAiProvider(nextProvider);
      else await deleteAiProvider();
    }
  }, [aiKeySet, aiProvider]);

  const selectAiProvider = useCallback(async (provider: AiProvider) => {
    await saveAiProvider(provider);
    setAiProvider(provider);
  }, []);

  // localDraft: Local's base URL and model as typed, tested before saving
  const runAiKeyTest = useCallback(async (provider: AiSettingsProvider, localDraft?: LocalAiConfig) => {
    if (provider === "local") {
      setAiKeyTestState((current) => ({ ...current, local: { phase: "testing" } }));
      const result = await testLocalConnection(localDraft);
      void invoke("log", { line: `[keys] test local ${result.ok ? "ok" : `error=${result.kind}`}` }).catch(() => {});
      setAiKeyTestState((current) => ({
        ...current,
        local: result.ok ? { phase: "success" } : { phase: "failure", reason: result.kind },
      }));
      return;
    }
    if (!(await loadApiKeyStatus())[provider]) {
      setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "no-key" } }));
      return;
    }
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "testing" } }));
    const result = await (provider === "openai" ? testOpenAiConnection() : testJudgeConnection());
    setAiKeyTestState((current) => ({
      ...current,
      [provider]: result.ok ? { phase: "success" } : { phase: "failure", reason: result.kind },
    }));
  }, []);

  /** Changes the assignment for one project. If set is DEFAULT_ICON_SET (birds), the entry itself is
   * deleted (the semantics "choosing birds = no assignment"; see lib/icon-set-store.ts). Otherwise it
   * upserts {set, label} (label is a snapshot of the display name at the time of selection).
   * Changes are saved and applied to state immediately (same as other settings) */
  const assignIconSet = useCallback(
    (slug: string, label: string, set: IconSetId) => {
      const next = { ...iconSetAssignments };
      if (set === DEFAULT_ICON_SET) {
        delete next[slug];
      } else {
        next[slug] = { set, label };
      }
      setIconSetAssignments(next);
      void saveIconSetAssignments(next);
    },
    [iconSetAssignments],
  );

  const changeConciergeLook = useCallback((next: ConciergeLook) => {
    setConciergeLook(next);
    void saveConciergeLook(next);
  }, []);

  return {
    muted,
    mutedRef,
    chirpVolume,
    voiceEnabled,
    voiceEnabledRef,
    voiceVolume,
    readoutVoice,
    changeReadoutSource,
    saveLocalTts,
    removeLocalTts,
    runTtsTest,
    aiKeySet,
    retiredKeys,
    keyStoreAvailable,
    aiKeyTestState,
    aiProvider,
    localAi,
    // Speech bubbles and the concierge are shown only while one of OpenAI / Anthropic / Local is set up
    summarySetUp: anyAiProviderSetUp({ anthropic: aiKeySet.anthropic, openai: aiKeySet.openai, local: localAi !== null }),
    iconSetAssignments,
    loadSettings,
    toggleMuted,
    changeMuted,
    toggleVoiceEnabled,
    changeVoiceEnabled,
    changeVoiceVolume,
    changeChirpVolume,
    saveAiKey,
    removeAiKey,
    removeRetiredKey,
    saveLocalAi,
    removeLocalAi,
    selectAiProvider,
    runAiKeyTest,
    assignIconSet,
    conciergeLook,
    changeConciergeLook,
  };
}
