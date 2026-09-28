// イベントを音声で読み上げる(chirp.ts の音合成とは別レイヤー: こちらは文章)。
// chrome.tts は使わない(製品の permissions: [] 設計を崩すため) — 拡張ページ内で
// 無権限で使える window.speechSynthesis のみを使う。
// 複数イベント同時発生時の直列化は speechSynthesis のネイティブキューに任せ、
// ここでは1件ずつ発話をキューへ積むだけにする。

import { t, uiLanguage } from "./i18n";
import { loadActiveAiProvider } from "./fsa";
import { summarizeDoneEvent } from "./summarize";
import type { SessionEvent } from "./sessions";

// 読み上げテンプレート文の i18n キー名(scripts/locales/voice.mjs)。t()(lib/i18n.ts)の
// キー引数はプレーンな string で足りるが、VOICE_KEY が持つ値をこのキー1つに限定する
// ドキュメントとしてリテラル型のまま残す
type VoiceMessageName = "eventWaitingVoice";

// イベント種別 → 読み上げテンプレート文の i18n キー。キーが無い種別は読み上げない
// (started はセッション開始のたびに鳴ってうるさいため対象外。done はテンプレ文を使わず
// プロジェクト名+プロンプトのみ読む → speakEvent 内で個別分岐。closed はユーザー自身の
// 明示的操作(/clear・ターミナル終了・中断)でしか発生せず、自分で閉じたものを読み上げても
// 情報量が無いため対象外)
const VOICE_KEY: Partial<Record<SessionEvent["type"], VoiceMessageName>> = {
  waiting: "eventWaitingVoice",
};

// snippet は長いことがあるため、聞き取りやすい長さで打ち切る(仕様: 100文字程度)
const SNIPPET_MAX_CHARS = 100;

// 読み上げ音量(SpeechSynthesisUtterance.volume、0〜1)。モジュールレベルの変数として持つ
// 理由: speakDoneEvent は要約取得の await を挟んでから発話するため、呼び出し時点で音量を
// 引数として渡す設計だと await 中に設定画面で音量を変えても古い値のまま発話されてしまう。
// setVoiceVolume で更新された「発話する瞬間の最新値」を enqueueUtterance が毎回読みに行く
// ことで、待ち時間中の変更も反映される。デフォルトは 1(loadVoiceVolume と同じ既定フル)。
let voiceVolume = 1;

/** 設定画面(App.tsx)から呼ぶ。範囲外の値は呼び出し側(loadVoiceVolume)で弾かれている前提。 */
export function setVoiceVolume(volume: number): void {
  voiceVolume = volume;
}

/**
 * snippet を読み上げ用に整形する。表示用の整形(formatSnippet)は画面で読む前提の記号を
 * 含んでおり、音声エンジンが逐語読みして雑音になるため発話直前に落とす。表示側は一切
 * 変更しない。
 */
function sanitizeSnippetForSpeech(raw: string): string {
  let text = raw.slice(0, SNIPPET_MAX_CHARS);
  // formatSnippet が打ち切り時に付ける表示用の省略記号「…」。音声エンジンが
  // 「てんてんてん」等と読み上げてしまうため発話には乗せない
  const truncated = text.endsWith("…");
  if (truncated) text = text.slice(0, -1);
  // markdown 記号の除去: バッククォート・強調のアスタリスク2連以上・見出しの先頭 #。
  // 単独の "*" や文中の "#" は誤除去の懸念があるため触らない
  text = text.replace(/`/g, "").replace(/\*{2,}/g, "").replace(/^#+\s*/, "");
  // 打ち切りで寸断された末尾の単語断片(「the a」等)を落とす。スペースが無い(CJK)場合に
  // 適用すると全文が消えるため対象外。truncated でない場合に適用すると、完結した末尾の
  // 単語(「fix the bug」の「bug」等)まで誤って削ってしまうため、両条件を満たす時だけ行う。
  // 削除対象は ASCII/ラテン語の単語断片のみに限定する(\S+ だと日英混在snippetで
  // 「git diff を見てレビュー」のような末尾の日本語部分が丸ごと消えてしまう)。断片か
  // どうかはこの層では区別できないため、無意味な音節になりやすい ASCII 断片だけを
  // 対象にする。CJK は1文字でも意味を持つため触らない
  if (truncated && text.includes(" ")) {
    text = text.replace(/[A-Za-z0-9'’-]+$/, "");
  }
  // 末尾に残った句読点・記号の塊(ユーザー自身が書いた末尾の「...」、断片除去後に残る
  // 「src/」の「/」等)を落として整える
  text = text.replace(/[\s.…,;:/\-]+$/, "").trim();
  return text;
}

/**
 * project 文字列を読み上げ用に整形する。表示用の記号を発話直前に落とす点は
 * sanitizeSnippetForSpeech と同じ設計。
 */
function sanitizeProjectForSpeech(raw: string): string {
  // ひなイベントの project は "親 · ひな名" と表示用の中黒(U+00B7)で連結されている
  // (lib/sessions.ts の chickProject)。音声エンジンが中黒を逐語読みするため発話では
  // 読点相当の ", " に置き換える
  let text = raw.replace(/ · /g, ", ");
  // ひな名は agent-<id>.meta.json の description にフォールバックすることがあり
  // (resolveChickMeta)、そこには表示用の省略記号「…」や "..." や markdown の
  // バッククォートが入りうる。発話に乗せると「てんてんてん」等の雑音になるため
  // 空白1つに潰す/除去する。単発・2連のドットは "app.v2" のような正当なドットのため
  // 対象外(3個以上のみ)。
  text = text.replace(/…+/g, " ").replace(/\.{3,}/g, " ").replace(/`/g, "");
  return text.replace(/\s+/g, " ").trim();
}

// speakEvent と speakDoneEvent の両方が使う発話プリミティブ。utterance を分けて
// speechSynthesis のネイティブキューに積み、発話間の間で句切る(理由は speakEvent の
// コメント参照)
function enqueueUtterance(text: string, lang: string): void {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.volume = voiceVolume;
  speechSynthesis.speak(utterance);
}

/**
 * イベント1件を読み上げる。テンプレート文($PROJECT$ を chrome.i18n の substitution で
 * 埋め込み) + snippet があれば続けて読む。
 *
 * 制約: このページが一度もユーザー操作を受けていない間(設定ONのままタブを開き直した
 * 直後など)は、自動再生ポリシーにより speak() が not-allowed で無音に失敗しうる。
 * これは鳴き声(chirp の primeAudio が pointerdown を待つ)と同じ制約で、初回クリック
 * 以降は sticky activation により発話できる。ここでは失敗を握りつぶす(chirp と同じ挙動)。
 *
 * done イベントは、要約読み上げ(speakDoneEvent)が使えない/失敗したときの従来動作
 * (プロジェクト名+snippet)としても使う。二重発話を避けるため、done の要約読み上げが
 * 一度でも成立した経路ではこの関数を呼ばない設計にすること(speakDoneEvent 参照)。
 */
export function speakEvent(event: SessionEvent): void {
  if (typeof speechSynthesis === "undefined") return;
  const snippet = event.snippet ? sanitizeSnippetForSpeech(event.snippet) : undefined;
  const project = sanitizeProjectForSpeech(event.project);
  // 区切り記号は使わない — "." に限らずどの記号もエンジン依存で「ドット」等と逐語読み
  // されうる(実害: done の読み上げでプロジェクト名直後に不審な読みが入る報告あり)。
  // 追加の i18n キーを増やさない方針(formatEventTime と同じ)は維持する。
  const lang = uiLanguage();
  if (event.type === "done") {
    // done はテンプレ文("〜完了しました"等)がうるさいので読まず、プロジェクト名+
    // プロンプトのみ読む(snippet が無ければプロジェクト名のみ)
    enqueueUtterance(project, lang);
  } else {
    const key = VOICE_KEY[event.type];
    if (!key) return;
    enqueueUtterance(t(key, project), lang);
  }
  if (snippet) enqueueUtterance(snippet, lang);
}

/**
 * assistantText(そのターンの assistant 最終応答本文)の最後の1文を Intl.Segmenter
 * (granularity: "sentence")で切り出す。言語別の手書き正規表現分岐は書かない方針のため
 * Chromium 組み込みの Intl.Segmenter に委ねる。切り出した文には sanitizeSnippetForSpeech
 * と同じサニタイズ(markdown記号除去・100文字超の打ち切り・末尾記号除去)を適用し、
 * 空白のみ・空になった場合は undefined を返す(呼び出し側は snippet フォールバックに
 * 落とす)。
 */
function extractLastSentence(text: string, lang: string): string | undefined {
  // 末尾の改行(コードフェンス後の空行・段落区切りの "\n\n" 等、assistant のmarkdown出力に
  // 頻出)を先に落とす。UAX#29 の文分割は改行だけの区間も1セグメントとして切り出すため、
  // trim せずに渡すと最終セグメントが空白のみになり、実質毎回 snippet フォールバックに
  // 落ちてしまう(実害を単体テストで確認済み)。
  const trimmed = text.trim();
  const segmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
  const segments = Array.from(segmenter.segment(trimmed), (s) => s.segment);
  const last = segments.length > 0 ? segments[segments.length - 1] : "";
  const sanitized = sanitizeSnippetForSpeech(last);
  return sanitized || undefined;
}

/**
 * done のAI要約読み上げが使えない/使わないときの共通フォールバック。
 * event.assistantText の最終文が取れればプロジェクト名+最終文を読み、取れなければ
 * (assistantText が無い・最終文が空白のみ等) speakEvent(event) の従来動作(プロジェクト名+
 * snippet=ユーザープロンプト)に落とす。フォールバックは常にこの関数1回の呼び出しに一本化
 * してあり、speakEvent と併用して二重発話することはない。
 */
function speakDoneFallback(event: SessionEvent, lang: string): void {
  if (typeof speechSynthesis === "undefined") return;
  const lastSentence = event.assistantText ? extractLastSentence(event.assistantText, lang) : undefined;
  if (!lastSentence) {
    speakEvent(event);
    return;
  }
  const project = sanitizeProjectForSpeech(event.project);
  enqueueUtterance(project, lang);
  enqueueUtterance(lastSentence, lang);
}

// 要約取得のタイムアウト。BYOK 呼び出しが詰まって done の読み上げそのものが遅延・欠落する
// のを避けるため、超えたら諦めて従来動作にフォールバックする
const SUMMARY_TIMEOUT_MS = 5_000;

/** withTimeout の内部専用マーカー。verdict の型と衝突しない一意なシンボルにする */
const TIMED_OUT = Symbol("summary-timeout");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // runJudge(lib/judge.ts)は例外を投げない設計(エラーは JudgeResult.ok=false で返る)だが、
    // 呼び出し前の loadAiApiKey 等が reject する可能性に備えて catch も付ける
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMED_OUT);
      },
    );
  });
}

/**
 * done イベントを読み上げる。OpenAI または Anthropic の API キーがあり、かつこのターンの
 * アシスタント応答本文(event.assistantText)が取れているときだけAI要約(lib/summarize.ts)を
 * 「プロジェクト名 → 要約」の順で読む。それ以外(キー無し・API エラー・タイムアウト・
 * 空の verdict)は speakDoneFallback にフォールバックする — assistantText の最終文が取れれば
 * プロジェクト名+最終文、取れなければ speakEvent(event) の従来動作(プロジェクト名+snippet)を
 * 読む。フォールバック経路は常に speakDoneFallback 呼び出し1回だけに一本化してあるので、
 * 要約読み上げと従来動作が二重に鳴ることはない。
 *
 * 要約読み上げはキーの有無だけで独立にゲートする(判定機能=旧 LLM 判定は廃止済みで、
 * このキーは要約読み上げと接続テストのみで使う)。
 *
 * 呼び出し側(App.tsx)は読み上げ ON かつミュートされていない done イベントでのみこの関数を
 * 呼ぶこと(判定は voiceEnabled/muted 双方とも speakEvent と同じゲートを共有する)。
 *
 * stillEnabled: 要約取得の待ち時間(最大 SUMMARY_TIMEOUT_MS)の間に読み上げトグルが OFF に
 * なった場合、素通しで待ち後に発話してしまうと toggleVoiceEnabled の cancelSpeech() が
 * 「OFF は即座に静かにする」ために立てた保証を破ってしまう(先に cancelSpeech() でキューを
 * 空にした直後、この待ちが解決してキューへ積み直す形の漏れになる)。await の後ろで発話する
 * 直前に毎回これを呼び、false ならそのターンの発話(フォールバックも要約も)を一切行わない。
 * 呼び出し側は voiceEnabledRef.current 相当の最新値を返す関数を渡すこと。
 */
export async function speakDoneEvent(
  event: SessionEvent,
  stillEnabled: () => boolean,
): Promise<void> {
  const lang = uiLanguage();
  if (!event.assistantText) {
    speakDoneFallback(event, lang);
    return;
  }
  if (typeof speechSynthesis === "undefined") return; // 要約 API を呼ぶ前に無音環境を弾く

  const provider = await loadActiveAiProvider();
  if (!stillEnabled()) return;
  if (!provider) {
    speakDoneFallback(event, lang);
    return;
  }

  const result = await withTimeout(
    summarizeDoneEvent(provider, {
      ui_language: lang,
      prompt: event.snippet,
      assistant_text: event.assistantText,
    }),
    SUMMARY_TIMEOUT_MS,
  );
  if (!stillEnabled()) return;

  if (result === TIMED_OUT || !result.ok) {
    speakDoneFallback(event, lang);
    return;
  }
  const summary =
    typeof result.verdict.summary === "string" ? sanitizeSummaryForSpeech(result.verdict.summary) : "";
  if (!summary) {
    speakDoneFallback(event, lang);
    return;
  }

  const project = sanitizeProjectForSpeech(event.project);
  enqueueUtterance(project, lang);
  enqueueUtterance(summary, lang);
}

// 要約読み上げ専用のサニタイズ。sanitizeSnippetForSpeech と同じ記号除去(バッククォート・
// 強調のアスタリスク2連以上・見出しの#・末尾の句読点)を流用しつつ、snippet 特有の「表示用
// 省略記号の除去」「打ち切り断片除去」は行わない(要約は打ち切りではなく LLM が完結させた
// 1文である前提のため)。プロンプトで50文字以内を指示しているが、指示違反時の安全弁として
// SNIPPET_MAX_CHARS と同じ上限で切る
function sanitizeSummaryForSpeech(raw: string): string {
  let text = raw.slice(0, SNIPPET_MAX_CHARS);
  text = text.replace(/`/g, "").replace(/\*{2,}/g, "").replace(/^#+\s*/, "");
  text = text.replace(/[\s.…,;:/\-]+$/, "").trim();
  return text;
}

/** 再生中・キュー済みの発話をすべて止める(読み上げトグル OFF 用) */
export function cancelSpeech(): void {
  if (typeof speechSynthesis === "undefined") return;
  speechSynthesis.cancel();
}
