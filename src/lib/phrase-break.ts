// Phrase breaks for the concierge's bubble (docs/design.md "Concierge", the detailed design under "a Japanese line in the
// bubble ... doesn't break inside a phrase"): a text with no spaces between its words (Japanese, Chinese) gets U+200B
// between its phrases, found by BudouX, and `word-break: keep-all` on the part that holds it (styles/concierge.css,
// [data-phrased]) then breaks a line only there and at spaces, in WebKit as in Chromium. A space inside a phrase next to a
// kana or kanji (「README を」, 「 3 回まで」) becomes U+00A0, so it doesn't break the phrase either; one between English words
// stays a space, so an English run in a Japanese line still wraps between its words. keep-all is only on such parts, since
// in WebKit it also stops the break after a hyphen in English. Only for what is drawn: speech, logs, and hooks get the
// text without them
import { Parser, jaModel, zhHansModel, zhHantModel } from "budoux";

export const PHRASE_BREAK = "\u200b";
export const NO_BREAK_SPACE = "\u00a0";
const ELLIPSIS = "…";

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const TRADITIONAL_UI = /^zh-(tw|hk|mo|hant)\b/i;

let parsers: { ja: Parser; zhHans: Parser; zhHant: Parser } | undefined;
const parser = (model: "ja" | "zhHans" | "zhHant") => {
  parsers ??= { ja: new Parser(jaModel), zhHans: new Parser(zhHansModel), zhHant: new Parser(zhHantModel) };
  return parsers[model];
};

const modelOf = (text: string, uiLang: string) =>
  KANA.test(text) ? "ja" : HAN.test(text) ? (TRADITIONAL_UI.test(uiLang) ? "zhHant" : "zhHans") : null;

/** Whether `text` is one phraseBreaks breaks into phrases (Japanese, Chinese): the part drawing it gets keep-all */
export const hasPhrases = (text: string) => modelOf(text, "") !== null;

// A kana or kanji (with what is written with them, like 「ー」 and 「々」): a space next to one is inside a Japanese or
// Chinese phrase
const CJK = /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Han}]/u;
const SPACES = /([ \t]+)/;

/**
 * A phrase with the spaces inside it that touch a kana or kanji kept from breaking (U+00A0). Not those it starts or ends
 * with (a break between phrases may fall there), nor those between English words, numbers or signs (BudouX puts a run of
 * English and the particle after it in one phrase; kept whole, the run would break inside a word once wider than the line).
 * Split rather than matched with a lookbehind, which WebKit before Safari 16.4 can't parse
 */
const keepWhole = (phrase: string) =>
  phrase
    .split(SPACES)
    .map((part, i, parts) => {
      // Odd parts are the spaces; the first and last parts are words, empty when the phrase starts or ends with a space
      if (i % 2 === 0) return part;
      const before = parts[i - 1] ?? "";
      const after = parts[i + 1] ?? "";
      if (!before || !after) return part;
      return CJK.test(before[before.length - 1]) || CJK.test(after[0]) ? NO_BREAK_SPACE.repeat(part.length) : part;
    })
    .join("");

/**
 * `text` with U+200B between its phrases. The model is chosen by the text, not by the UI language, since a session's text
 * can be Japanese under an English UI: kana in it → Japanese; Han without kana → Chinese, Traditional when `uiLang` is
 * zh-TW / zh-HK / zh-MO / zh-Hant, else Simplified; anything else (English, Korean, which has spaces) comes back as it is.
 * A space inside a phrase next to a kana or kanji becomes U+00A0. A trailing 「…」 (a cut state line) gets no break before it, so it never starts
 * a line alone
 */
export function phraseBreaks(text: string, uiLang = ""): string {
  const model = modelOf(text, uiLang);
  if (!model) return text;
  const cut = text.endsWith(ELLIPSIS);
  const body = cut ? text.slice(0, -ELLIPSIS.length) : text;
  return parser(model).parse(body).map(keepWhole).join(PHRASE_BREAK) + (cut ? ELLIPSIS : "");
}
