// 最後の応答文から、最後の 1 文を AI を使わずに切り出す(docs/design.md「鳥に直近のメッセージを短く要約した
// セリフを吹き出しで出す」)。Jev が返事待ちと判定したが要約用のキーが無い鳥の吹き出しに使う。多くは
// 「どれにしますか。」のような質問になる。入力は untrusted な応答文なので、表示用の文字列を作るだけにする

// 文の終わり。。？?！! のどれか(全角・半角)
const SENTENCE = /[^。？?！!\n]*[。？?！!]+/g;
// 行頭の箇条書き・番号・見出し・引用の記号
const LINE_MARKER = /^\s*(?:[-*+•・]|\d+[.)．]|#{1,6}|>)\s*/;

/**
 * 末尾の空行・コードブロック・箇条書きの記号を除き、。？?！! で終わる最後の文を返す。
 * そういう文が無ければ、最後の空でない行。何も残らなければ undefined
 */
export function lastSentence(text: string): string | undefined {
  // コードブロック(``` で囲まれた部分。閉じていない末尾のものも)を落とす
  const withoutCode = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  const lines = withoutCode
    .split("\n")
    .map((line) =>
      // 太字・コードの記号を先に落とす(先に箇条書きの記号を落とすと「**」の片方が残る)
      line
        .replace(/\*\*|__|`/g, "")
        .replace(LINE_MARKER, "")
        .trim(),
    )
    .filter((line) => line !== "");
  if (lines.length === 0) return undefined;
  const body = lines.join("\n");
  const sentences = body.match(SENTENCE);
  const last = sentences?.[sentences.length - 1]?.trim() || lines[lines.length - 1];
  return last || undefined;
}
