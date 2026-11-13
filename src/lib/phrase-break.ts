// Phrase breaks for the concierge's bubble (docs/design.md "Concierge", the detailed design under "a Japanese line in the
// bubble ... doesn't break inside a phrase"): a text with no spaces between its words (Japanese, Chinese) gets U+200B
// between its phrases, found by BudouX, and the bubble's `word-break: keep-all` (styles/concierge.css) then breaks a line
// only there, in WebKit as in Chromium. Only for what is drawn: speech, logs, and hooks get the text without it
import { Parser, jaModel, zhHansModel, zhHantModel } from "budoux";

export const PHRASE_BREAK = "​";
const ELLIPSIS = "…";

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const TRADITIONAL_UI = /^zh-(tw|hk|mo|hant)\b/i;

let parsers: { ja: Parser; zhHans: Parser; zhHant: Parser } | undefined;
const parser = (model: "ja" | "zhHans" | "zhHant") => {
  parsers ??= { ja: new Parser(jaModel), zhHans: new Parser(zhHansModel), zhHant: new Parser(zhHantModel) };
  return parsers[model];
};

/**
 * `text` with U+200B between its phrases. The model is chosen by the text, not by the UI language, since a session's text
 * can be Japanese under an English UI: kana in it → Japanese; Han without kana → Chinese, Traditional when `uiLang` is
 * zh-TW / zh-HK / zh-MO / zh-Hant, else Simplified; anything else (English, Korean, which has spaces) comes back as it is.
 * A trailing 「…」 (a cut state line) gets no break before it, so it never starts a line alone
 */
export function phraseBreaks(text: string, uiLang = ""): string {
  const model = KANA.test(text) ? "ja" : HAN.test(text) ? (TRADITIONAL_UI.test(uiLang) ? "zhHant" : "zhHans") : null;
  if (!model) return text;
  const cut = text.endsWith(ELLIPSIS);
  const body = cut ? text.slice(0, -ELLIPSIS.length) : text;
  return parser(model).parse(body).join(PHRASE_BREAK) + (cut ? ELLIPSIS : "");
}
