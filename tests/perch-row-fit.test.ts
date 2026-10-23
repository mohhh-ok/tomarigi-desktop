// A Perch row shows the state on a second line only when the name and the state with its elapsed time don't fit on one
// line; the answer comes from the texts' own widths, so it is the same on one line or two (docs/design.md "Display names")
import { expect, test } from "bun:test";
import { needsTwoLines, toolFits, type RowFit } from "../src/perch/perch-row-fit.ts";

// The numbers of a row at a 340px window: a 278px row, the name 45px from its left edge, a 10px gap
const row = (more: Partial<RowFit>): RowFit => ({ rowWidth: 278, nameLeft: 45, nameWidth: 100, statusWidth: 72, gap: 10, toolWidth: 0, ...more });

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

test("a tool name is kept only when it fits whole after the state, on the line the state is on", () => {
  // blog · ついばみ中 · 9秒 ••• · Read at 300px: the state fits, the tool name doesn't
  const blog = row({ rowWidth: 238, nameWidth: 40, statusWidth: 113, toolWidth: 45 });
  expect(needsTwoLines(blog)).toBe(false);
  expect(toolFits(blog, false)).toBe(false);
  // At 340px it does
  expect(toolFits({ ...blog, rowWidth: 278 }, false)).toBe(true);
  // On two lines the second line starts under the name, so the name's width doesn't count
  const long = row({ rowWidth: 238, nameWidth: 229, statusWidth: 115, toolWidth: 40 });
  expect(needsTwoLines(long)).toBe(true);
  expect(toolFits(long, true)).toBe(true);
  expect(toolFits({ ...long, rowWidth: 190 }, true)).toBe(false);
});
