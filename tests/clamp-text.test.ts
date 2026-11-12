// Cutting a state line's text to fit (docs/design.md "Concierge": each state line shows at most 2 lines and ends with
// 「…」 when cut; src/lib/clamp-text.ts). Whether a text fits is the page's to say; here it is a width in characters
import { describe, expect, test } from "bun:test";
import { clampText, ELLIPSIS, linesIn } from "../src/lib/clamp-text.ts";

const upTo = (n: number) => (s: string) => Array.from(s).length <= n;

describe("clampText", () => {
  test("a text that fits is kept whole, with no 「…」", () => {
    expect(clampText("短い文", upTo(10))).toBe("短い文");
    expect(clampText("ちょうど", upTo(4))).toBe("ちょうど");
  });

  test("a text too long is cut to the longest start that fits with 「…」 after it", () => {
    const question = "~/Dev/playground には GitHub のリモートがなく、手元にしか無い物があります。消し方をどうしますか？";
    const out = clampText(question, upTo(20));
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(Array.from(out).length).toBe(20);
    expect(question.startsWith(out.slice(0, -1))).toBe(true);
  });

  test("the spaces before the cut are dropped, so 「…」 follows a word", () => {
    expect(clampText("Publish the post now?", upTo(13))).toBe("Publish the…");
  });

  test("English is cut at a word's start, not inside the word", () => {
    // 「retries thre…」 was what a UI check found at 260px
    expect(clampText("the job now retries three times", upTo(20))).toBe("the job now retries…");
    expect(clampText("don't stop", upTo(4))).toBe("don…");
    // One word longer than the room: cut inside it, since there is nothing before it
    expect(clampText("supercalifragilistic", upTo(6))).toBe("super…");
  });

  test("kanji and kana are cut anywhere, a Latin word among them at its start", () => {
    expect(clampText("手元にしか無い物があります", upTo(6))).toBe("手元にしか…");
    expect(clampText("には GitHub のリモート", upTo(7))).toBe("には…");
    expect(clampText("のリモートがなくGitHub", upTo(11))).toBe("のリモートがなく…");
  });

  test("a cut never splits an emoji or a letter with its mark", () => {
    expect(clampText("ab👨‍👩‍👧cd", upTo(3))).toBe("ab…");
    expect(clampText("ab👨‍👩‍👧cd", (s) => s.length <= 11)).toBe("ab👨‍👩‍👧…");
    expect(clampText("café au lait", upTo(6))).toBe("café…");
  });

  test("when nothing fits (a name too long on its own), 「…」 alone", () => {
    expect(clampText("text", () => false)).toBe(ELLIPSIS);
  });

  test("a long text costs a few measurements, not one per character", () => {
    let calls = 0;
    clampText("あ".repeat(400), (s) => {
      calls += 1;
      return s.length <= 50;
    });
    expect(calls).toBeLessThanOrEqual(11);
  });
});

describe("linesIn", () => {
  test("a box's height in lines, rounded so a fraction of a px doesn't count as a line", () => {
    expect(linesIn(14, 14)).toBe(1);
    expect(linesIn(28, 14)).toBe(2);
    expect(linesIn(28.4, 14)).toBe(2);
    expect(linesIn(42, 14)).toBe(3);
    expect(linesIn(14, 0)).toBe(0);
  });
});
