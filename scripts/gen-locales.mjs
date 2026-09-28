// public/_locales/<locale>/messages.json を生成するスクリプト。
// 43言語ぶんのJSONを手書きするとキー集合や placeholder がロケール間でずれる事故が
// 起きやすいため、翻訳文言は scripts/locales/*.mjs に機能グループ別で集約し、
// このファイルでは各グループを読み込んで一つのテーブルへマージするだけにしている。
//
// 使い方: node scripts/gen-locales.mjs
// 新しい文言キーを追加するときは、対応するグループファイル (scripts/locales/*.mjs) に
// 43ロケール分の訳を書き、必要ならこのファイルの KEYS に追記する(順序は messages.json の
// フィールド順を左右するので、既存の順序を崩さない)。verify-locales.mjs が漏れを検出する。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import bird from "./locales/bird.mjs";
import event from "./locales/event.mjs";
import perch from "./locales/perch.mjs";
import time from "./locales/time.mjs";
import setup from "./locales/setup.mjs";
import root from "./locales/root.mjs";
import sound from "./locales/sound.mjs";
import byok from "./locales/byok.mjs";
import voice from "./locales/voice.mjs";
import meta from "./locales/meta.mjs";
import iconset from "./locales/iconset.mjs";
import desktop from "./locales/desktop.mjs";
import window from "./locales/window.mjs";
import ask from "./locales/ask.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "_locales");

// グループを1つのテーブルにマージ。同じキーが2つのグループに現れたら事故なので落とす。
const GROUPS = { bird, event, perch, time, setup, root, sound, byok, voice, meta, iconset, desktop, window, ask };

const MERGED = {};
for (const [groupName, table] of Object.entries(GROUPS)) {
  for (const [key, byLocale] of Object.entries(table)) {
    if (Object.prototype.hasOwnProperty.call(MERGED, key)) {
      throw new Error(`duplicate key "${key}" (later group: ${groupName})`);
    }
    MERGED[key] = byLocale;
  }
}

// KEYS: messages.json のフィールド順を決める。既存の messages.json との差分を出さないため、
// リファクタ前の順序を厳密に保存している。新規キーは末尾に追記していく。
export const KEYS = [
  "extDescription",
  "birdWorkingLabel",
  "birdDozingLabel",
  "loadingLabel",
  "setupIntro",
  "setupPickPrefix",
  "setupPickMiddle",
  "setupPickSuffix",
  "setupButton",
  "duplicateRootMessage",
  "saveFailedMessage",
  "reauthFailedMessage",
  "emptyNoSessions",
  "emptyNeedsReauth",
  "emptyNoEvents",
  "summonButton",
  "pipNote",
  "rootsHeading",
  "badgeNeedsReauth",
  "badgeUnreadable",
  "reauthButton",
  "editLabelButton",
  "removeButtonAria",
  "addRootButton",
  "rootLabelPlaceholder",
  "muteButtonAria",
  "unmuteButtonAria",
  "sinceSeconds",
  "sinceMinutes",
  "sinceHoursMinutes",
  "eventFeedHeading",
  "eventStartedLabel",
  "eventDoneLabel",
  "eventClosedLabel",
  "eventMutedTitle",
  "byokApiKeyLabel",
  "byokApiKeySetLabel",
  "byokSaveButton",
  "byokDeleteButton",
  "byokTestButton",
  "byokTestingLabel",
  "byokTestResultSuccess",
  "byokTestResultFailure",
  "byokNoKeyMessage",
  "tabPerchLabel",
  "tabGardenLabel",
  "tabSettingsLabel",
  "voiceEnableLabel",
  "eventWaitingVoice",
  "aiApiKeyHeading",
  "voiceVolumeLabel",
  "soundEnableLabel",
  "iconSetHeading",
  "iconSetBirds",
  "iconSetGnome",
  "iconSetCat",
  "iconSetRobot",
  "iconSetFrog",
  "iconSetEmpty",
  "iconSetToggleAria",
  "copyPathButton",
  "closeButtonAria",
  "openAiApiKeyHeading",
  "byokUseForSummaryLabel",
  "aiApiKeysHeading",
  "aiApiKeysDescription",
  "rootDefaultBadge",
  "windowModeHeading",
  "windowModeFloating",
  "windowModeNormal",
  "birdWaitingLabel",
  "askingBadgeTitle",
  "typeSafeApiKeyHeading",
  "typeSafeApiKeyDescription",
  "bubblePlanApproval",
  "birdWatchingLabel",
  "watchingPeersTitle",
  "byokReplaceButton",
  "byokSaveFailedMessage",
  "typeSafeSiteLink",
  "quotedSnippet",
];

// KEYS とグループファイルの整合性チェック(片方に無いキーがあれば即エラー)。
{
  const inKeys = new Set(KEYS);
  const inGroups = new Set(Object.keys(MERGED));
  for (const k of inKeys) {
    if (!inGroups.has(k)) throw new Error(`KEYS has "${k}" but no group defines it`);
  }
  for (const k of inGroups) {
    if (!inKeys.has(k)) throw new Error(`group defines "${k}" but KEYS does not list it`);
  }
}

// キー名 → placeholder名 → 位置引数。全ロケール共通(文言の言語に依存しない)。
export const PLACEHOLDERS = {
  sinceSeconds: { count: "$1" },
  sinceMinutes: { count: "$1" },
  sinceHoursMinutes: { hours: "$1", minutes: "$2" },
  byokTestResultFailure: { reason: "$1" },
  eventWaitingVoice: { project: "$1" },
  quotedSnippet: { snippet: "$1" },
};

// default_locale。英語が未対応言語ユーザーへのフォールバック。
export const DEFAULT_LOCALE = "en";

// ロケール一覧は meta グループの extDescription が全ロケール揃っている前提で導出する
// (グループファイル間で不整合があれば buildMessagesJson が個別ロケールで例外を投げる)。
const LOCALES = Object.keys(MERGED[KEYS[0]]);

// TRANSLATIONS: locale → key → text。ロケール逆引きのビューを既存API互換で公開する。
export const TRANSLATIONS = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    Object.fromEntries(KEYS.map((key) => [key, MERGED[key][locale]])),
  ]),
);

function buildMessagesJson(locale) {
  const messages = TRANSLATIONS[locale];
  if (!messages) throw new Error(`no translations for locale "${locale}"`);
  const out = {};
  for (const key of KEYS) {
    const text = messages[key];
    if (typeof text !== "string") {
      throw new Error(`locale "${locale}" is missing key "${key}"`);
    }
    const entry = { message: text };
    if (PLACEHOLDERS[key]) {
      entry.placeholders = Object.fromEntries(
        Object.entries(PLACEHOLDERS[key]).map(([name, content]) => [name, { content }]),
      );
    }
    out[key] = entry;
  }
  return out;
}

// 文言のソースオブトゥルースは scripts/locales/*.mjs のみ。public/_locales/ 配下の
// messages.json は全ロケール生成物なので直接編集しない(編集はグループファイルに入れて gen:locales)。
function main() {
  const locales = Object.keys(TRANSLATIONS);
  for (const locale of locales) {
    const json = buildMessagesJson(locale);
    const dir = path.join(OUT_DIR, locale);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "messages.json"), JSON.stringify(json, null, 2) + "\n");
  }
  console.log(`Generated ${locales.length} locales: ${locales.join(", ")}`);
}

// ESM: このファイルが直接実行されたときだけ生成する(gen-locales.test.mjs等からの
// import では実行しない)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
