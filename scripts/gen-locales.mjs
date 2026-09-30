// Script that generates public/_locales/<locale>/messages.json.
// Writing JSON for 43 languages by hand easily leads to accidents where key sets or placeholders drift
// between locales, so translated strings are gathered by feature group in scripts/locales/*.mjs,
// and this file only loads each group and merges them into one table.
//
// Usage: node scripts/gen-locales.mjs
// When adding a new string key, write translations for all 43 locales in the matching group file (scripts/locales/*.mjs),
// and if needed append it to KEYS in this file (the order determines the field order of messages.json,
// so don't break the existing order). verify-locales.mjs detects omissions.

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

// Merge the groups into one table. The same key appearing in two groups is an accident, so fail.
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

// KEYS: decides the field order of messages.json. To avoid diffs against the existing messages.json,
// the order from before the refactor is preserved exactly. New keys are appended at the end.
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
  "angerBadgeTitle",
  "typeSafeApiKeyHeading",
  "typeSafeApiKeyDescription",
  "typeSafeUserMessageNote",
  "bubblePlanApproval",
  "birdWatchingLabel",
  "watchingPeersTitle",
  "byokReplaceButton",
  "byokSaveFailedMessage",
  "typeSafeSiteLink",
  "quotedSnippet",
  "settingsBackButton",
  "hideWindowButtonLabel",
];

// Consistency check between KEYS and the group files (error immediately if a key is missing on either side).
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

// key name → placeholder name → positional argument. Shared by all locales (doesn't depend on the language of the text).
export const PLACEHOLDERS = {
  sinceSeconds: { count: "$1" },
  sinceMinutes: { count: "$1" },
  sinceHoursMinutes: { hours: "$1", minutes: "$2" },
  byokTestResultFailure: { reason: "$1" },
  eventWaitingVoice: { project: "$1" },
  quotedSnippet: { snippet: "$1" },
};

// default_locale. English is the fallback for users of unsupported languages.
export const DEFAULT_LOCALE = "en";

// The locale list is derived assuming meta's extDescription exists for every locale
// (if the group files are inconsistent, buildMessagesJson throws for the individual locale).
const LOCALES = Object.keys(MERGED[KEYS[0]]);

// TRANSLATIONS: locale → key → text. Exposes a per-locale view, compatible with the existing API.
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

// The only source of truth for strings is scripts/locales/*.mjs. messages.json under public/_locales/
// is generated for every locale, so don't edit it directly (put edits in the group files and run gen:locales).
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

// ESM: generate only when this file is run directly (not when imported from
// gen-locales.test.mjs etc.).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
