// 状態遷移を鳥の鳴き声で知らせる。音源ファイルは使わず Web Audio 合成のみ。
// ブラウザの自動再生ポリシー対策で AudioContext はユーザージェスチャ内でのみ
// 生成・resume する(primeAudio)。それ以外の場所からの呼び出しは黙って無視する。

// 入力待ち(waiting)を知らせる2連チュン
const ATTENTION_FREQ_FROM = 3400; // Hz、各音の開始周波数
const ATTENTION_FREQ_TO = 2600; // Hz、各音の終了周波数(上→下にスイープ)
const ATTENTION_NOTE_MS = 75; // 1音の長さ
const ATTENTION_GAP_MS = 70; // 2音の間隔
const ATTENTION_GAIN = 0.15;
const ATTENTION_TYPE: OscillatorType = "triangle";

// 完了時の柔らかい一声
const DONE_FREQ_FROM = 1300; // Hz
const DONE_FREQ_TO = 950; // Hz、緩やかに下降
const DONE_DURATION_MS = 200;
const DONE_GAIN = 0.12;
const DONE_TYPE: OscillatorType = "sine";

const ATTACK_MS = 8; // アタックは速く
const FLOOR_GAIN = 0.0001; // exponentialRampToValueAtTime は 0 を許さないための下限

let ctx: AudioContext | undefined;
// マスター音量段。各音符の GainNode(エンベロープ用)は個別のまま destination に直結せず
// ここへ集約してから destination へ送る。lib/voice.ts の voiceVolume と同じ「ゲームの
// SE 音量」に相当する独立設定(読み上げの音量とは別軸)。primeAudio で ctx を作るタイミングで
// masterGain も作る必要があるため、生成は primeAudio 側に持たせる(このモジュールの
// AudioContext ライフサイクルを1箇所に閉じる)。
let masterGain: GainNode | undefined;
// setChirpVolume が primeAudio より先に呼ばれる場合(App.tsx の起動時ロードは
// primeAudio 前に走りうる)に備えて、最新値をここに保持し masterGain 生成時に反映する
let pendingVolume = 1;

/** 要ユーザー操作。AudioContext を生成し、suspended なら resume する */
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
 * 鳴き声(chirp)の音量。lib/voice.ts の setVoiceVolume と同じモジュール変数方式(コメントは
 * そちらを参照)。masterGain.gain.value を直接書き換えるだけの単純な設定にする(音符ごとの
 * エンベロープ(exponentialRamp)はそのまま playTone 側に残す — マスター段は単なる音量つまみで、
 * 減衰カーブの一部ではないため)。primeAudio 前に呼ばれた場合は pendingVolume に退避し、
 * masterGain 生成時に反映する。
 */
export function setChirpVolume(volume: number): void {
  pendingVolume = volume;
  if (masterGain) masterGain.gain.value = volume;
}

/** 短いスイープ音を1つ鳴らす */
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
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + attackSec); // 速いアタック
  gain.gain.exponentialRampToValueAtTime(FLOOR_GAIN, startAt + durationSec); // 短い減衰
  osc.connect(gain);
  gain.connect(destination); // 個々の音符 → マスター音量段 → destination
  osc.start(startAt);
  osc.stop(startAt + durationSec + 0.02);
}

/** 状態が「入力待ち(waiting)」に変わったとき */
export function chirpWaiting(): void {
  // masterGain は primeAudio 内で ctx と同時に作るので、ctx が running ならあるはず。
  // 型のため念のためガードする(無ければ何もしない=従来の「無音で無視」と同じ挙動)
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

/** 状態が「ひと仕事おえた」に変わったとき */
export function chirpDone(): void {
  if (!ctx || !masterGain || ctx.state !== "running") return;
  playTone(ctx, masterGain, ctx.currentTime, DONE_DURATION_MS, DONE_FREQ_FROM, DONE_FREQ_TO, DONE_GAIN, DONE_TYPE);
}
