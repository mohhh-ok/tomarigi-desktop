import { useCallback } from "react";
import { MdVolumeUp } from "react-icons/md";
import { t } from "@/lib/i18n";
import { chirpDone, chirpWaiting, primeAudio } from "@/lib/chirp";
import { readoutAvailable, speechAvailable, type ReadoutTestResult } from "@/lib/voice";
import type { LocalTtsConfig, ReadoutVoice } from "@/lib/readout-voice";
import { EVENT, EventIcon } from "../event-kind";
import { ReadoutVoiceSettings } from "./readout-voice-settings";

/** Notify with sound (its volume and previews), read aloud (its volume) and the readout voice.
 * The two notification toggles share one pattern: "parent checkbox + sub-rows directly below".
 * "Notify with sound" is the inverse of muted, the same state as the floating window's mute button.
 * The chirp volume is independent of the readout volume (the same idea as separate SE/BGM volumes in games) */
export function SoundSettings({
  open,
  muted,
  chirpVolume,
  voiceEnabled,
  voiceVolume,
  readoutVoice,
  onToggleMuted,
  onChirpVolume,
  onToggleVoice,
  onVoiceVolume,
  onReadoutSource,
  onSaveLocalTts,
  onDeleteLocalTts,
  onTestTts,
}: {
  open: boolean;
  muted: boolean;
  chirpVolume: number;
  voiceEnabled: boolean;
  voiceVolume: number;
  readoutVoice: ReadoutVoice;
  onToggleMuted: () => void;
  onChirpVolume: (volume: number) => void;
  onToggleVoice: () => void;
  onVoiceVolume: (volume: number) => void;
  onReadoutSource: (source: ReadoutVoice["source"]) => void;
  onSaveLocalTts: (config: LocalTtsConfig) => void;
  onDeleteLocalTts: () => void;
  onTestTts: (config: LocalTtsConfig) => Promise<ReadoutTestResult>;
}) {
  // Readout is off where nothing can speak: no speechSynthesis and no local TTS server chosen
  const canSpeak = readoutAvailable();
  const systemCanSpeak = speechAvailable();
  // Preview the chirps one by one (played in a row, you can't tell which sound is which state)
  const preview = useCallback((chirp: () => void) => {
    primeAudio();
    chirp();
  }, []);
  return (
    <div className="voice-controls">
      <label className="voice-enable-row">
        <input type="checkbox" checked={!muted} onChange={onToggleMuted} />
        {t("soundEnableLabel")}
      </label>
      {/* Not disabled while muted: "set the volume while previewing, then turn it on" */}
      <label className="settings-subrow volume-row">
        {t("voiceVolumeLabel")}
        <input
          type="range"
          className="volume-slider"
          min={0}
          max={100}
          value={Math.round(chirpVolume * 100)}
          onChange={(e) => onChirpVolume(Number(e.target.value) / 100)}
        />
        <span className="volume-value">{Math.round(chirpVolume * 100)}%</span>
      </label>
      {/* Previewing is "listening to decide whether to turn it on", so it isn't disabled while muted.
          Sounds fire on events, so the labels come from the event side (state labels wouldn't match) */}
      <div className="settings-subrow sound-preview-row">
        <button className="small" onClick={() => preview(chirpDone)}>
          <MdVolumeUp size={14} className="preview-mic" />
          <EventIcon kind="done" size={18} /> {EVENT.done.label}
        </button>
        <button className="small" onClick={() => preview(chirpWaiting)}>
          <MdVolumeUp size={14} className="preview-mic" />
          <EventIcon kind="waiting" size={18} /> {EVENT.waiting.label}
        </button>
      </div>
      <label className="voice-enable-row">
        <input type="checkbox" checked={voiceEnabled && canSpeak} disabled={!canSpeak} onChange={onToggleVoice} />
        {t("voiceEnableLabel")}
      </label>
      {!systemCanSpeak && <p className="settings-subrow settings-note">{t("voiceUnavailable")}</p>}
      {/* The volume is kept while "Read aloud" is off; it is only disabled then, its value doesn't change */}
      <label className="settings-subrow volume-row">
        {t("voiceVolumeLabel")}
        <input
          type="range"
          className="volume-slider"
          min={0}
          max={100}
          value={Math.round(voiceVolume * 100)}
          disabled={!voiceEnabled || !canSpeak}
          onChange={(e) => onVoiceVolume(Number(e.target.value) / 100)}
        />
        <span className="volume-value">{Math.round(voiceVolume * 100)}%</span>
      </label>
      {/* Not dimmed while "Read aloud" is off: the sample can be played before turning it on, and where the system has
          no speech engine, choosing a local server is what lets it be turned on */}
      <ReadoutVoiceSettings
        open={open}
        voice={readoutVoice}
        readAloud={voiceEnabled}
        onSource={onReadoutSource}
        onSave={onSaveLocalTts}
        onDelete={onDeleteLocalTts}
        onTest={onTestTts}
      />
    </div>
  );
}
