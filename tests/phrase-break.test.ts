// Phrase breaks for the concierge's bubble (docs/design.md "Concierge"; lib/phrase-break.ts): U+200B between the phrases
// of a text with no spaces between its words, so a line breaks only between phrases in WebKit as in Chromium
import { describe, expect, test } from "bun:test";
import { NO_BREAK_SPACE, PHRASE_BREAK, hasPhrases, phraseBreaks } from "../src/lib/phrase-break.ts";

const phrases = (text: string, uiLang = "") => phraseBreaks(text, uiLang).split(PHRASE_BREAK);

describe("phraseBreaks", () => {
  test.each([
    // [what, text, UI language, phrases]
    ["Japanese, the UI check's case", "いちばん長く待っているので先に返事を", "ja", ["いちばん長く", "待っているので", "先に", "返事を"]],
    ["Japanese under an English UI", "ビルドが通ったので次に進みます", "en-US", ["ビルドが", "通ったので", "次に", "進みます"]],
    // A space inside a phrase doesn't break it (U+00A0); one a phrase starts with still may
    ["Japanese with a path and English words", "app-x の設計書を docs/design.md に書いて push しました", "ja", ["app-x\u00a0の", "設計書を", " docs/design.md\u00a0に", "書いて", " push\u00a0しました"]],
    ["Japanese with a number and a word apart", "間を空けて 3 回までやり直し、README を更新しました", "ja", ["間を", "空けて", " 3\u00a0回まで", "やり直し、", "README\u00a0を", "更新しました"]],
    ["a cut line: no break before 「…」", "いちばん長く待っているので…", "ja", ["いちばん長く", "待っているので…"]],
    ["Simplified Chinese", "等待时间最长，所以请先回复", "zh-CN", ["等待", "时间", "最长，", "所以", "请", "先", "回复"]],
  ])("%s", (_what, text, lang, expected) => {
    expect(phrases(text, lang)).toEqual(expected);
    // Only breaks are added and spaces kept from breaking: the text drawn reads as the text
    expect(phraseBreaks(text, lang).replaceAll(PHRASE_BREAK, "").replaceAll(NO_BREAK_SPACE, " ")).toBe(text);
    expect(hasPhrases(text)).toBe(true);
  });

  test("Traditional Chinese by the UI language, Simplified otherwise", () => {
    const text = "等待時間最長，所以請先回覆";
    const hant = phraseBreaks(text, "zh-TW");
    expect(hant).toContain(PHRASE_BREAK);
    expect(hant.replaceAll(PHRASE_BREAK, "")).toBe(text);
    expect(phraseBreaks(text, "zh-Hant-HK")).toBe(hant);
  });

  test.each([
    ["English", "Fixed the links and pushed the branch"],
    ["Korean, which has spaces", "가장 오래 기다렸으니 먼저 답해 주세요"],
    ["no kana and no kanji", "Bash: bun test tests/concierge-status.test.ts"],
    ["a cut English line", "retries…"],
    ["empty", ""],
  ])("%s comes back as it is", (_what, text) => {
    expect(phraseBreaks(text, "ja")).toBe(text);
    expect(phraseBreaks(text, "en-US")).toBe(text);
    expect(hasPhrases(text)).toBe(false);
  });
});
