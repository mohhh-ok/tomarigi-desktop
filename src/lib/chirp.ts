// Signals state transitions with bird chirps. No sound files; Web Audio synthesis only.
// Because of the browser autoplay policy, the AudioContext is created and resumed only inside
// a user gesture (primeAudio). Calls from anywhere else are silently ignored.

// Double chirp signaling that input is needed (waiting)
const ATTENTION_FREQ_FROM = 3400; // Hz, start frequency of each note
const ATTENTION_FREQ_TO = 2600; // Hz, end frequency of each note (sweeps high → low)
const ATTENTION_NOTE_MS = 75; // length of one note
const ATTENTION_GAP_MS = 70; // gap between the two notes
const ATTENTION_GAIN = 0.15;
const ATTENTION_TYPE: OscillatorType = "triangle";

// A soft single chirp on completion
const DONE_FREQ_FROM = 1300; // Hz
const DONE_FREQ_TO = 950; // Hz, falls gently
const DONE_DURATION_MS = 200;
const DONE_GAIN = 0.12;
const DONE_TYPE: OscillatorType = "sine";

const ATTACK_MS = 8; // fast attack
const FLOOR_GAIN = 0.0001; // floor, because exponentialRampToValueAtTime doesn't allow 0

let ctx: AudioContext | undefined;
// Master volume stage. Each note's GainNode (for the envelope) stays separate and isn't connected straight to destination;
// they are gathered here and then sent to destination. An independent setting equivalent to a game's "SE volume",
// like voiceVolume in lib/voice.ts (a separate axis from readout volume). masterGain has to be created when primeAudio
// creates ctx, so creation lives in primeAudio (keeping this module's AudioContext lifecycle
// in one place).
let masterGain: GainNode | undefined;
// In case setChirpVolume is called before primeAudio (the startup load in App.tsx can run
// before primeAudio), the latest value is kept here and applied when masterGain is created
let pendingVolume = 1;

/** Needs a user action. Creates the AudioContext and resumes it if suspended */
export function primeAudio(): void {
  if (typeof AudioContext === "undefined") return;
  if (!ctx) {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = pendingVolume;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
}

/**
 * Chirp volume. Same module-variable approach as setVoiceVolume in lib/voice.ts (see the comment
 * there). Kept as a simple setting that just writes masterGain.gain.value directly (each note's
 * envelope (exponentialRamp) stays in playTone — the master stage is just a volume knob,
 * not part of the decay curve). If called before primeAudio, the value is stashed in pendingVolume
 * and applied when masterGain is created.
 */
export function setChirpVolume(volume: number): void {
  pendingVolume = volume;
  if (masterGain) masterGain.gain.value = volume;
}

/** Plays one short sweep */
function playTone(
  audio: AudioContext,
  destination: AudioNode,
  startAt: number,
  durationMs: number,
  freqFrom: number,
  freqTo: number,
  peakGain: number,
  type: OscillatorType,
): void {
  const durationSec = durationMs / 1000;
  const attackSec = Math.min(ATTACK_MS / 1000, durationSec / 3);
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, startAt);
  osc.frequency.linearRampToValueAtTime(freqTo, startAt + durationSec);
  gain.gain.setValueAtTime(FLOOR_GAIN, startAt);
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + attackSec); // fast attack
  gain.gain.exponentialRampToValueAtTime(FLOOR_GAIN, startAt + durationSec); // short decay
  osc.connect(gain);
  gain.connect(destination); // each note → master volume stage → destination
  osc.start(startAt);
  osc.stop(startAt + durationSec + 0.02);
}

/** When the state changes to "input needed (waiting)" */
export function chirpWaiting(): void {
  // masterGain is created together with ctx in primeAudio, so it should exist if ctx is running.
  // Guard just in case for the types (do nothing if missing = same as the previous "silently ignore" behavior)
  if (!ctx || !masterGain || ctx.state !== "running") return;
  const now = ctx.currentTime;
  const noteSec = ATTENTION_NOTE_MS / 1000;
  const gapSec = ATTENTION_GAP_MS / 1000;
  playTone(
    ctx,
    masterGain,
    now,
    ATTENTION_NOTE_MS,
    ATTENTION_FREQ_FROM,
    ATTENTION_FREQ_TO,
    ATTENTION_GAIN,
    ATTENTION_TYPE,
  );
  playTone(
    ctx,
    masterGain,
    now + noteSec + gapSec,
    ATTENTION_NOTE_MS,
    ATTENTION_FREQ_FROM,
    ATTENTION_FREQ_TO,
    ATTENTION_GAIN,
    ATTENTION_TYPE,
  );
}

/** When the state changes to "finished a job" */
export function chirpDone(): void {
  if (!ctx || !masterGain || ctx.state !== "running") return;
  playTone(ctx, masterGain, ctx.currentTime, DONE_DURATION_MS, DONE_FREQ_FROM, DONE_FREQ_TO, DONE_GAIN, DONE_TYPE);
}
