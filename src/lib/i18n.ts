// i18n。tomarigi(Chrome 拡張)では拡張コンテキストなら browser.i18n に委譲し、それ以外は
// public/_locales/<locale>/messages.json を fetch して Chrome の getMessage 意味論を再実装していた。
// デスクトップ版は拡張コンテキストが無いので常に後者(_locales は scripts/gen-locales.mjs の生成物)。
//
// 呼び出し順の制約: ICON_SET_LABEL(src/perch/icon-sets.ts)や BIRD/EVENT(src/perch/stage.tsx)は
// モジュール評価時に t() を呼んで辞書を作る。これらが import される前に initI18n() の await が
// 完了している必要がある(src/perch/main.tsx 参照)。

import type en from "../../public/_locales/en/messages.json";

type MessagePlaceholder = { content: string; description?: string };
type MessageEntry = { message: string; placeholders?: Record<string, MessagePlaceholder> };
type MessageDict = Record<string, MessageEntry>;

// キーは生成済み en/messages.json のキー集合に縛る(タイポしたキー名をコンパイル時に弾く)
export type MessageName = keyof typeof en;

// 辞書。initI18n() が読み込み完了後にここへセットする。initI18n() 未呼び出し/全ロケール失敗の間は
// 空のままで、t() は Chrome と同じ "" を返すだけになる
let fallbackDict: MessageDict = {};

/**
 * Chrome の browser.i18n.getMessage と同じ意味論で解決する。substitutions は $1 形式(1-indexed)で
 * placeholders 経由に対応する(単体 string は [それ] として扱う)。
 * キーが辞書に無ければ Chrome と同じく "" を返す。
 *
 * key を MessageName(生成済みリテラル union)に縛っているのは意図的な仕様からの逸脱。
 * 素朴に string を受けると、この関数の中でキャストが要るだけでなく、~60箇所ある
 * 呼び出し側の型チェック(タイポしたキー名をコンパイル時に弾く)が丸ごと失われる
 * (verify:locales は辞書同士の整合しか見ず、コード側の参照は見ない)。
 */
export function t(key: MessageName, substitutions?: string | string[]): string {
  return resolveFallback(key, substitutions);
}

/** browser.i18n.getUILanguage の代替。 */
export function uiLanguage(): string {
  return navigator.language;
}

/**
 * 辞書を読み込む。navigator.language から候補ロケールを作り、順に
 * fetch("./_locales/<candidate>/messages.json") して最初に成功したものを使う
 * (相対パスは index.html 基準。vite が public/_locales を dist 直下へコピーする)。
 * 全滅した場合は "en" を明示的にもう一段試し、それも失敗すれば空辞書のまま続行する
 * (throw しない — t() が "" を返すだけの縮退動作にする)。
 */
export async function initI18n(): Promise<void> {
  for (const candidate of localeCandidates(navigator.language)) {
    const dict = await tryFetchDict(candidate);
    if (dict) {
      fallbackDict = dict;
      return;
    }
  }
  const en = await tryFetchDict("en");
  if (en) fallbackDict = en;
}

// "ja-JP" → ["ja_JP", "ja", "en"] のように、詳細ロケール→言語→英語の順で候補を作る。
// Chrome の _locales ディレクトリ名はハイフンではなくアンダースコア区切り
// (public/_locales/pt_BR 等)なので変換する。重複は候補順を保ったまま除去する
// (例: "en-US" → "en_US", "en" ではなく "en_US", "en" のまま。末尾の "en" は
// 常に保険として含める)
function localeCandidates(lang: string): string[] {
  const normalized = lang.replaceAll("-", "_");
  const primary = normalized.split("_")[0];
  return [...new Set([normalized, primary, "en"])];
}

async function tryFetchDict(locale: string): Promise<MessageDict | null> {
  try {
    const res = await fetch(`./_locales/${locale}/messages.json`);
    if (!res.ok) return null;
    return (await res.json()) as MessageDict;
  } catch {
    return null;
  }
}

// $NAME$(大文字小文字を区別しない) または $$ にマッチする。名前は Chrome の仕様どおり
// ASCII 英数字とアンダースコアのみ
const PLACEHOLDER_RE = /\$\$|\$([A-Za-z0-9_]+)\$/g;

function resolveFallback(key: string, substitutions?: string | string[]): string {
  const entry = fallbackDict[key];
  if (!entry) return ""; // Chrome も未知キーは "" を返す(verify:locales が全キー存在を保証)
  const subs = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  const placeholders = entry.placeholders ?? {};
  return entry.message.replace(PLACEHOLDER_RE, (whole, name?: string) => {
    if (name === undefined) return "$"; // $$ 分岐
    const ph = placeholders[name.toLowerCase()];
    if (!ph) return whole; // 対応する placeholder 定義が無ければ手を加えず残す
    const m = /^\$(\d+)$/.exec(ph.content);
    if (!m) return whole; // content が $1 形式でなければ手を加えず残す
    const idx = Number(m[1]) - 1;
    return subs[idx] ?? "";
  });
}
