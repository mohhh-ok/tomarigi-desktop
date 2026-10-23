// A Perch row shows the state on a second line only when the name and the state with its elapsed time don't fit on one
// line; the answer comes from the texts' own widths, so it is the same on one line or two (docs/design.md "Display names")
import { expect, test } from "bun:test";
import { needsTwoLines, type RowFit } from "../src/perch/perch-row-fit.ts";

// The numbers of a row at a 340px window: a 278px row, the name 45px from its left edge, a 10px gap
const row = (more: Partial<RowFit>): RowFit => ({ rowWidth: 278, nameLeft: 45, nameWidth: 100, statusWidth: 72, gap: 10, ...more });

test("a short name and its state fit on one line", () => {
  expect(needsTwoLines(row({ nameWidth: 106, statusWidth: 55 }))).toBe(false); // billionclips 2 · 完了 · 2分
});

test("a long name and its state don't", () => {
  expect(needsTwoLines(row({ nameWidth: 229, statusWidth: 115 }))).toBe(true); // tomarigi-desktop-advice-links · ついばみ中 · 4秒 •••
});

test("exactly the row's width still fits; a pixel more doesn't", () => {
  expect(needsTwoLines(row({ nameWidth: 151, statusWidth: 72 }))).toBe(false);
  expect(needsTwoLines(row({ nameWidth: 152, statusWidth: 72 }))).toBe(true);
});

test("a fraction of a pixel over counts as not fitting, so the name is never cut by it", () => {
  expect(needsTwoLines(row({ nameWidth: 151.2, statusWidth: 72 }))).toBe(true);
  expect(needsTwoLines(row({ rowWidth: 277.6, nameWidth: 151, statusWidth: 72 }))).toBe(true);
});

test("the same widths give the same answer for a narrower row", () => {
  expect(needsTwoLines(row({ rowWidth: 198, nameWidth: 90, statusWidth: 79 }))).toBe(true); // billionclips · 返事待ち · 1分 at 260px
  expect(needsTwoLines(row({ rowWidth: 258, nameWidth: 90, statusWidth: 79 }))).toBe(false);
});
