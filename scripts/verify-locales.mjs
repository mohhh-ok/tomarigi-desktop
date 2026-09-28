// Structural check of public/_locales/**/messages.json.
// 1. Every locale passes JSON.parse
// 2. Every locale's key set matches en (the anchor) exactly
// 3. The number of $NAME$ placeholder tokens matches en
//
// Usage: node scripts/verify-locales.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, "..", "public", "_locales");
const ANCHOR = "en";

function placeholderTokens(message) {
  // Count "$NAME$" form (Chrome i18n's proper named placeholders), not "$1" form.
  // $$ is an escaped $, so it's excluded.
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
      errors.push(`${locale}: messages.json does not exist`);
      continue;
    }
    const raw = fs.readFileSync(file, "utf8");
    try {
      parsed[locale] = JSON.parse(raw);
    } catch (e) {
      errors.push(`${locale}: JSON.parse failed — ${e.message}`);
    }
  }

  const anchor = parsed[ANCHOR];
  const anchorKeys = new Set(Object.keys(anchor));
  console.log(`Anchor (${ANCHOR}) key count: ${anchorKeys.size}`);

  for (const locale of locales) {
    const messages = parsed[locale];
    if (!messages) continue; // JSON.parse failure was already recorded above

    const keys = new Set(Object.keys(messages));
    const missing = [...anchorKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !anchorKeys.has(k));
    if (missing.length > 0) errors.push(`${locale}: missing keys — ${missing.join(", ")}`);
    if (extra.length > 0) errors.push(`${locale}: extra keys — ${extra.join(", ")}`);

    for (const key of anchorKeys) {
      if (!(key in messages)) continue; // already recorded as missing
      const anchorTokens = placeholderTokens(anchor[key].message);
      const tokens = placeholderTokens(messages[key].message);
      if (anchorTokens.size !== tokens.size) {
        errors.push(
          `${locale}.${key}: placeholder count mismatch (en=${anchorTokens.size} [${[...anchorTokens].join(",")}], ${locale}=${tokens.size} [${[...tokens].join(",")}])`,
        );
      } else {
        // Whether the token sets (names) match too. $COUNT$ / $HOURS$ / $MINUTES$ are designed
        // to use the same names in every language, so a different name is most likely an implementation mistake.
        const missingNames = [...anchorTokens].filter((t) => !tokens.has(t));
        if (missingNames.length > 0) {
          errors.push(`${locale}.${key}: placeholder name mismatch — expected ${missingNames.join(", ")}`);
        }
      }
      // Also check the consistency of the "placeholders" field itself (content: "$1" etc.)
      const anchorHasPlaceholders = !!anchor[key].placeholders;
      const hasPlaceholders = !!messages[key].placeholders;
      if (anchorHasPlaceholders !== hasPlaceholders) {
        errors.push(`${locale}.${key}: presence of the placeholders field differs from en`);
      } else if (anchorHasPlaceholders) {
        const anchorNames = Object.keys(anchor[key].placeholders).sort();
        const names = Object.keys(messages[key].placeholders).sort();
        if (JSON.stringify(anchorNames) !== JSON.stringify(names)) {
          errors.push(
            `${locale}.${key}: placeholders keys mismatch (en=${anchorNames.join(",")}, ${locale}=${names.join(",")})`,
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
