import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setChirpVolume } from "@/lib/chirp";
import {
  deleteAiProvider,
  deleteApiKey,
  initApiKeys,
  loadAiProvider,
  loadApiKeyStatus,
  loadChirpVolume,
  loadMuted,
  loadVoiceEnabled,
  loadVoiceVolume,
  resolveAiProvider,
  saveAiProvider,
  saveApiKey,
  saveChirpVolume,
  saveMuted,
  saveVoiceEnabled,
  saveVoiceVolume,
  type AiProvider,
  type ApiKeyProvider,
} from "@/lib/fsa";
import {
  loadIconSetAssignments,
  saveIconSetAssignments,
  type IconSetAssignments,
  type IconSetId,
} from "@/lib/icon-set-store";
import { testJudgeConnection } from "@/lib/judge";
import { testOpenAiConnection } from "@/lib/openai-judge";
import { testTypeSafeConnection } from "@/lib/jev";
import { cancelSpeech, setVoiceVolume } from "@/lib/voice";
import { DEFAULT_ICON_SET } from "./icon-sets";
import type { ApiKeyTestState } from "./settings/ai-key-settings";

/** The settings in the settings view (sound, readout, API keys, icon sets): their state, loading, and saving.
 * App.tsx awaits loadSettings() inside its startup load, after the watched folders and before the first scan */
export function useSettings() {
  const [muted, setMuted] = useState(false);
  const [chirpVolume, setChirpVolumeState] = useState(1);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceVolume, setVoiceVolumeState] = useState(1);
  // API keys are a setting shared by the done readout summary (speakDoneEvent) and the connection test, so the name isn't limited to judge
  const [aiKeySet, setAiKeySet] = useState<Record<ApiKeyProvider, boolean>>({
    anthropic: false,
    openai: false,
    typesafe: false,
  });
  const [aiKeyTestState, setAiKeyTestState] = useState<Record<ApiKeyProvider, ApiKeyTestState>>({
    anthropic: { phase: "idle" },
    openai: { phase: "idle" },
    typesafe: { phase: "idle" },
  });
  const [aiProvider, setAiProvider] = useState<AiProvider | null>(null);
  // Per-project icon set assignments (issue #14). A slug → {set, label} map.
  // Perch/Garden/IconSetSettings look up this map via resolveIconSet (lib/icon-set-store.ts)
  // and fall back to DEFAULT_ICON_SET when there is no assignment
  const [iconSetAssignments, setIconSetAssignments] = useState<IconSetAssignments>({});
  const mutedRef = useRef(muted);
  const voiceEnabledRef = useRef(voiceEnabled);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  const loadSettings = useCallback(async () => {
    setMuted(await loadMuted());
    const cVolume = await loadChirpVolume();
    setChirpVolumeState(cVolume);
    setChirpVolume(cVolume);
    setVoiceEnabled(await loadVoiceEnabled());
    const volume = await loadVoiceVolume();
    setVoiceVolumeState(volume);
    setVoiceVolume(volume);
    // Rust holds the keys (docs/design.md "BYOK API keys"). After migrating keys an earlier version left in IndexedDB
    // (the keychain version) and handing over from dev's IndexedDB, it only asks whether each key is saved
    try {
      await initApiKeys();
    } catch (e) {
      console.warn("[tomarigi] failed to initialize API keys", e);
    }
    const [keyStatus, preferredProvider] = await Promise.all([loadApiKeyStatus(), loadAiProvider()]);
    // Log whether each key is saved (a boolean only). Key values are never received or printed
    void invoke("log", {
      line: `[keys] status anthropic=${keyStatus.anthropic} openai=${keyStatus.openai} typesafe=${keyStatus.typesafe}`,
    });
    const resolvedProvider = resolveAiProvider(preferredProvider, keyStatus.anthropic, keyStatus.openai);
    setAiKeySet(keyStatus);
    setAiProvider(resolvedProvider ?? null);
    // Inconsistencies from old data or from deleting the key in use are normalized once to the available side.
    if (resolvedProvider && resolvedProvider !== preferredProvider) {
      await saveAiProvider(resolvedProvider);
    }
    setIconSetAssignments(await loadIconSetAssignments());
  }, []);

  const toggleMuted = useCallback(() => {
    const next = !muted;
    setMuted(next);
    void saveMuted(next);
  }, [muted]);

  const toggleVoiceEnabled = useCallback(() => {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    void saveVoiceEnabled(next);
    // OFF is an "I want quiet" action, so speech that is playing or queued stops immediately too
    if (!next) cancelSpeech();
  }, [voiceEnabled]);

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
    // The summary provider auto-selects the first key saved. If one is already selected, saving a second doesn't switch it.
    // TypeSafe isn't used for summaries, so it is excluded
    if (provider !== "typesafe" && !aiProvider) {
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
      const nextProvider = resolveAiProvider(
        undefined,
        nextKeySet.anthropic,
        nextKeySet.openai,
      );
      setAiProvider(nextProvider ?? null);
      if (nextProvider) await saveAiProvider(nextProvider);
      else await deleteAiProvider();
    }
  }, [aiKeySet, aiProvider]);

  const selectAiProvider = useCallback(async (provider: AiProvider) => {
    await saveAiProvider(provider);
    setAiProvider(provider);
  }, []);

  const runAiKeyTest = useCallback(async (provider: ApiKeyProvider) => {
    if (!(await loadApiKeyStatus())[provider]) {
      setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "no-key" } }));
      return;
    }
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "testing" } }));
    const result = await (provider === "typesafe"
      ? testTypeSafeConnection()
      : provider === "openai"
        ? testOpenAiConnection()
        : testJudgeConnection());
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

  return {
    muted,
    mutedRef,
    chirpVolume,
    voiceEnabled,
    voiceEnabledRef,
    voiceVolume,
    aiKeySet,
    aiKeyTestState,
    aiProvider,
    iconSetAssignments,
    loadSettings,
    toggleMuted,
    toggleVoiceEnabled,
    changeVoiceVolume,
    changeChirpVolume,
    saveAiKey,
    removeAiKey,
    selectAiProvider,
    runAiKeyTest,
    assignIconSet,
  };
}
