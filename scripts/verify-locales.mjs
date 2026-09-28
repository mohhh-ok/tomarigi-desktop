// public/_locales/**/messages.json の構造検証。
// 1. 全ロケールが JSON.parse を通ること
// 2. 全ロケールのキー集合が en(アンカー)と完全一致すること
// 3. $NAME$ 形式の placeholder トークン数が en と一致すること
//
// 使い方: node scripts/verify-locales.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "public", "_locales");
const ANCHOR = "en";

function placeholderTokens(message) {
  // "$1" 形式ではなく "$NAME$" 形式(Chrome i18n の正式な named placeholder)を数える。
  // $$ はエスケープされた $ なので除外。
  const matches = message.match(/\$[A-Z][A-Z0-9_]*\$/g) ?? [];
  return new Set(matches);
}

function main() {
  const errors = [];
  const locales = fs
    .readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log(`Found ${locales.length} locale directories: ${locales.join(", ")}`);

  if (!locales.includes(ANCHOR)) {
    console.error(`FATAL: anchor locale "${ANCHOR}" not found`);
    process.exit(1);
  }

  const parsed = {};
  for (const locale of locales) {
    const file = path.join(LOCALES_DIR, locale, "messages.json");
    if (!fs.existsSync(file)) {
      errors.push(`${locale}: messages.json が存在しない`);
      continue;
    }
    const raw = fs.readFileSync(file, "utf8");
    try {
      parsed[locale] = JSON.parse(raw);
    } catch (e) {
      errors.push(`${locale}: JSON.parse 失敗 — ${e.message}`);
    }
  }

  const anchor = parsed[ANCHOR];
  const anchorKeys = new Set(Object.keys(anchor));
  console.log(`Anchor (${ANCHOR}) key count: ${anchorKeys.size}`);

  for (const locale of locales) {
    const messages = parsed[locale];
    if (!messages) continue; // 上でJSON.parse失敗を記録済み

    const keys = new Set(Object.keys(messages));
    const missing = [...anchorKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !anchorKeys.has(k));
    if (missing.length > 0) errors.push(`${locale}: キー不足 — ${missing.join(", ")}`);
    if (extra.length > 0) errors.push(`${locale}: 余分なキー — ${extra.join(", ")}`);

    for (const key of anchorKeys) {
      if (!(key in messages)) continue; // 既にmissingとして記録済み
      const anchorTokens = placeholderTokens(anchor[key].message);
      const tokens = placeholderTokens(messages[key].message);
      if (anchorTokens.size !== tokens.size) {
        errors.push(
          `${locale}.${key}: placeholder数不一致 (en=${anchorTokens.size} [${[...anchorTokens].join(",")}], ${locale}=${tokens.size} [${[...tokens].join(",")}])`,
        );
      } else {
        // トークン集合(名前)まで一致しているか。$COUNT$ / $HOURS$ / $MINUTES$ は
        // 全言語で同じ名前を使う設計なので、名前が違えば実装ミスの可能性が高い。
        const missingNames = [...anchorTokens].filter((t) => !tokens.has(t));
        if (missingNames.length > 0) {
          errors.push(`${locale}.${key}: placeholder名不一致 — 期待 ${missingNames.join(", ")}`);
        }
      }
      // "placeholders" フィールド自体の整合性(content: "$1"等)も確認
      const anchorHasPlaceholders = !!anchor[key].placeholders;
      const hasPlaceholders = !!messages[key].placeholders;
      if (anchorHasPlaceholders !== hasPlaceholders) {
        errors.push(`${locale}.${key}: placeholders フィールドの有無が en と不一致`);
      } else if (anchorHasPlaceholders) {
        const anchorNames = Object.keys(anchor[key].placeholders).sort();
        const names = Object.keys(messages[key].placeholders).sort();
        if (JSON.stringify(anchorNames) !== JSON.stringify(names)) {
          errors.push(
            `${locale}.${key}: placeholders キー不一致 (en=${anchorNames.join(",")}, ${locale}=${names.join(",")})`,
          );
        }
      }
    }
  }

  console.log("");
  if (errors.length === 0) {
    console.log(`OK: ${locales.length} locales, all keys and placeholders match "${ANCHOR}".`);
    process.exit(0);
  } else {
    console.error(`FAILED: ${errors.length} problem(s) found:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

main();
