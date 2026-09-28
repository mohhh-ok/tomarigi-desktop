// Extracts the last sentence of the last reply without AI (docs/design.md "Speech bubbles").
// Used for the bubble of birds that Jev judged as needing a reply but that have no summary key. Most
// are questions like "Which one should I go with?". The input is an untrusted reply, so this only builds a string for display

// End of a sentence: one of 。？?！! (full-width or half-width)
const SENTENCE = /[^。？?！!\n]*[。？?！!]+/g;
// Bullet, number, heading, and quote markers at the start of a line
const LINE_MARKER = /^\s*(?:[-*+•・]|\d+[.)．]|#{1,6}|>)\s*/;

/**
 * Removes trailing blank lines, code blocks, and bullet markers, and returns the last sentence ending in 。？?！!.
 * If there's no such sentence, the last non-empty line. undefined if nothing is left
 */
export function lastSentence(text: string): string | undefined {
  // Drop code blocks (parts enclosed in ```, including an unclosed one at the end)
  const withoutCode = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  const lines = withoutCode
    .split("\n")
    .map((line) =>
      // Drop bold/code markers first (dropping bullet markers first leaves one side of "**")
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
