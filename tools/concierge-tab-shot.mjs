// Shoots the Concierge tab of the mock at given window widths, for a UI check of the tab's bubble (its suggestions and
// state lines, docs/design.md "Concierge"). Headless, from a `vite build` output, with no dev server or port
// (setup and the build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/shots \
//     node tools/concierge-tab-shot.mjs
// Env: WIDTHS (comma-separated CSS px, default 340,260), HEIGHT (default 560), QUERY (the mock's scene, default a
// session needing a reply, a finished one, a working one and a long name that wraps: preset=same-project), SHOT_LANG
// (ja or en, default ja), NAME (the files' prefix, default concierge), LABEL (drawn at the top left of each image, to tell
// shots apart side by side; none by default), REST=1 (shoot at rest, data-fade="rest"), CSS (a style sheet added to the
// page, to try a value before writing it in the app's CSS, e.g. CSS='.concierge-status-lines { --dot-nudge: 1px }').
// ENGINE=webkit shoots in Playwright's WebKit, the engine of the app's WebView (default chromium).
// Writes <OUT>/<NAME>-<width>.png at 2x and prints each path. Then, for each state line, prints how far its dot's ink
// (the pixels it paints) is, in its vertical center, from that of the lowercase x-height letters on the line's first
// line, and from that of its kanji and kana (dot minus text; plus is lower), in device px and CSS px, and writes the
// same to <OUT>/<NAME>-<width>-dots.txt with the font the Japanese is drawn in. Against the x-height letters, every line
// should be within ±0.5 device px in WebKit (README "concierge-tab-shot.mjs")
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/concierge-tab-shot";
const WIDTHS = (process.env.WIDTHS ?? "340,260").split(",").map(Number);
const HEIGHT = Number(process.env.HEIGHT ?? 560);
const QUERY = process.env.QUERY ?? "preset=same-project&tab=concierge&concierge=";
const LANG = process.env.SHOT_LANG === "en" ? "en" : "ja";
const NAME = process.env.NAME ?? "concierge";
const ORIGIN = "http://tomarigi.concierge-shot";
mkdirSync(OUT, { recursive: true });

const ENGINE = process.env.ENGINE ?? "chromium";
const browser = await launch(ENGINE);
try {
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: HEIGHT },
      deviceScaleFactor: 2,
      locale: LANG === "en" ? "en-US" : "ja-JP",
    });
    const page = await ctx.newPage();
    await routeMock(page, ORIGIN, DIST);
    await page.goto(`${ORIGIN}${mockPath(QUERY)}`);
    await page.waitForSelector(".garden-concierge-only .speech-bubble-below", { timeout: 15000 });
    if (process.env.CSS) await page.addStyleTag({ content: process.env.CSS });
    if (process.env.REST === "1") await page.evaluate(() => (document.documentElement.dataset.fade = "rest"));
    // The concierge flies in and the bubble fades in
    await page.waitForTimeout(2500);
    if (process.env.LABEL) {
      await page.evaluate((label) => {
        const tag = document.createElement("div");
        tag.textContent = label;
        Object.assign(tag.style, {
          position: "fixed", top: "2px", left: "2px", zIndex: "99999", padding: "1px 5px",
          background: "#000", color: "#fff", font: "600 10px system-ui", borderRadius: "2px",
        });
        document.body.appendChild(tag);
      }, process.env.LABEL);
    }
    const path = join(OUT, `${NAME}-${w}.png`);
    await page.screenshot({ path });
    console.log(path);
    const lines = await measureInk(page);
    const fmt = (v) => (v === null ? "   n/a" : v.toFixed(2).padStart(6));
    const dpx = (v) => `${fmt(v === null ? null : v * 2)}dpx ${fmt(v)}px`;
    const text = [
      `engine=${ENGINE} width=${w} dpr=2 bubble height=${await page.evaluate(() => document.querySelector(".garden-concierge-only .speech-bubble-below")?.getBoundingClientRect().height)}px ${await page.evaluate(() => `suggestions=${document.querySelectorAll(".concierge-status-suggestions .concierge-status-line").length} (lines tall: ${[...document.querySelectorAll(".concierge-status-suggestions .concierge-status-line")].map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight))).join(",")}) state lines=${document.querySelectorAll(".concierge-status-lines .concierge-status-line").length} more="${document.querySelector(".concierge-status-more")?.textContent ?? ""}"`)}  ${await fontReport(page)}`,
      "ink(dot) - ink(x-height letters), device px and CSS px | ink(dot) - ink(kanji/kana), device px and CSS px | box(dot) - box(first char) CSS px | the line's top in the page, CSS px | from the line's top, CSS px: ink centers of the dot, x-height letters, kanji/kana (which kanji/kana) | line",
      ...lines.map((d) => `${dpx(d.xhDiff)} | ja ${dpx(d.inkDiff)} | box ${fmt(d.boxDiff)}px | line top ${fmt(d.lineTop)} | from line top: dot ${fmt(d.dot)} xh ${fmt(d.xh)} ja ${fmt(d.ja)} (${d.chars}) | ${d.line}`),
    ].join("\n");
    writeFileSync(join(OUT, `${NAME}-${w}-dots.txt`), `${text}\n`);
    console.log(text);
    await ctx.close();
  }
} finally {
  await browser.close();
}

/**
 * Per state line: the vertical center of the dot's ink, of the ink of the x-height letters (a c e m n o r s u v w x z)
 * and of the kanji and kana (not small kana or ー) on the line's first line, from three shots of the page as it is: nothing on the lines drawn, only the dots, only the
 * text. Ink is what differs from the first. A row's coverage is its strongest pixel over the shape's strongest, so
 * anti-aliased edges count by how much they paint. Kanji and kana on a later line count shifted up by whole lines,
 * since every line has the same height. Also the old box measure
 */
async function measureInk(page) {
  const geometry = await page.evaluate(() => {
    const JA = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    const SMALL = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー・]/;
    const XH = /[acemnorsuvwxz]/;
    const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    return [...document.querySelectorAll(".concierge-status-lines .concierge-status-line")].map((line) => {
      const dot = line.querySelector(".concierge-status-dot")?.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(line).lineHeight);
      const ja = [];
      const xh = [];
      let first = null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode()); ) {
        for (let i = 0; i < node.data.length; i++) {
          const c = node.data[i];
          if (!c.trim()) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getClientRects()[0];
          if (!r) continue;
          first ??= r;
          if (JA.test(c) && !SMALL.test(c)) ja.push({ c, ...box(r) });
          else if (XH.test(c)) xh.push({ c, ...box(r) });
        }
      }
      return { line: line.textContent, dot: dot && box(dot), first: first && box(first), lineTop: line.getBoundingClientRect().top, lh, ja, xh };
    });
  });
  await page.addStyleTag({
    content: `html:is([data-ink="base"], [data-ink="dot"]) .concierge-status-lines :is(*, *::before, *::after) { color: transparent !important; text-decoration-color: transparent !important; }
html[data-ink="base"] .concierge-status-dot, html[data-ink="text"] .concierge-status-dot { visibility: hidden !important; }`,
  });
  const shots = {};
  for (const mode of ["base", "dot", "text"]) {
    await page.evaluate((m) => (document.documentElement.dataset.ink = m), mode);
    await page.waitForTimeout(100);
    shots[mode] = (await page.screenshot()).toString("base64");
  }
  await page.evaluate(() => delete document.documentElement.dataset.ink);
  return page.evaluate(
    async ([geometry, shots]) => {
      const pixels = async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height);
      };
      const base = await pixels(shots.base);
      const dotImg = await pixels(shots.dot);
      const textImg = await pixels(shots.text);
      const S = 2;
      // Rows y0..y1 (device px), over x ranges: each row's strongest difference from base
      const rows = (img, y0, y1, xs) => {
        const out = [];
        for (let y = y0; y < y1; y++) {
          let m = 0;
          for (const [x0, x1] of xs)
            for (let x = x0; x < x1; x++) {
              const i = (y * base.width + x) * 4;
              const d = Math.abs(img.data[i] - base.data[i]) + Math.abs(img.data[i + 1] - base.data[i + 1]) + Math.abs(img.data[i + 2] - base.data[i + 2]);
              if (d > m) m = d;
            }
          out.push(m);
        }
        return out;
      };
      // The ink's vertical center in device px from y0, with partly painted edge rows counting by their coverage
      const center = (r, y0) => {
        const max = Math.max(...r);
        if (max < 30) return null;
        const c = r.map((v) => Math.min(1, v / max));
        const top = c.findIndex((v) => v > 0.05);
        let bottom = c.length - 1;
        while (c[bottom] <= 0.05) bottom--;
        return y0 + (top + 1 - c[top] + bottom + c[bottom]) / 2;
      };
      const textCenter = (chars, g) => {
        if (!chars.length) return null;
        // Each char shifted to the first line by whole lines; rows over the first line's box
        const byLine = new Map();
        for (const ch of chars) {
          const k = Math.round((ch.top - g.first.top) / g.lh);
          (byLine.get(k) ?? byLine.set(k, []).get(k)).push(ch);
        }
        // The first line's box exactly: the text's ink fits in it, and a little more would take in the lines above and below
        const firstTop = Math.round(g.lineTop * S);
        const h = Math.round(g.lh * S);
        // The first line that has any
        const k0 = Math.min(...byLine.keys());
        const y0 = firstTop + Math.round(k0 * g.lh * S);
        const r = rows(textImg, y0, y0 + h, byLine.get(k0).map((ch) => [Math.floor(ch.left * S) + 1, Math.ceil(ch.right * S) - 1]));
        const cy = center(r, y0);
        return cy === null ? null : cy / S - k0 * g.lh;
      };
      const round = (v) => (v === null ? null : Math.round(v * 100) / 100);
      return geometry.map((g) => {
        if (!g.dot || !g.first) return { line: g.line, inkDiff: null, xhDiff: null, boxDiff: null };
        const y0 = Math.floor(g.dot.top * S) - 2 * S;
        const y1 = Math.ceil(g.dot.bottom * S) + 2 * S;
        const dc = center(rows(dotImg, y0, y1, [[Math.floor(g.dot.left * S) - S, Math.ceil(g.dot.right * S) + S]]), y0);
        const dotC = dc === null ? null : dc / S;
        const ja = textCenter(g.ja, g);
        const xh = textCenter(g.xh, g);
        return {
          line: g.line,
          inkDiff: round(dotC !== null && ja !== null ? dotC - ja : null),
          boxDiff: round((g.dot.top + g.dot.bottom) / 2 - (g.first.top + g.first.bottom) / 2),
          xhDiff: round(dotC !== null && xh !== null ? dotC - xh : null),
          dot: round(dotC === null ? null : dotC - g.lineTop),
          xh: round(xh === null ? null : xh - g.lineTop),
          ja: round(ja === null ? null : ja - g.lineTop),
          chars: g.ja.map((c) => c.c).join(""),
          lineTop: round(g.lineTop),
        };
      });
    },
    [geometry, shots],
  );
}

/**
 * The font the state lines' Japanese is drawn in, told by drawing 「完了中返事待ち」 on a canvas in the lines' font and in
 * candidate fonts and comparing pixels, and the lines' primary font's ascent and descent (canvas fontBoundingBox), which
 * set where the text sits in its line box, against the ink of 「完」
 */
function fontReport(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".concierge-status-lines .concierge-status-line");
    if (!el) return "font n/a";
    const cs = getComputedStyle(el);
    const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const draw = (f) => {
      // A document canvas: WebKit's OffscreenCanvas doesn't fall back to the system's Japanese font
      const c = Object.assign(document.createElement("canvas"), { width: 200, height: 40 });
      const g = c.getContext("2d");
      g.font = f;
      g.fillText("完了中返事待ち", 2, 28);
      return g.getImageData(0, 0, 200, 40).data;
    };
    const mine = draw(font);
    const candidates = ["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Hiragino Maru Gothic ProN", "PingFang SC", "Apple SD Gothic Neo"];
    // In WebKit no candidate matches (its system fallback isn't drawn the same as a named font): "unknown"
    const same = candidates.filter((n) => draw(`${cs.fontWeight} ${cs.fontSize} "${n}"`).every((v, i) => v === mine[i]));
    const g = document.createElement("canvas").getContext("2d");
    g.font = font;
    const m = g.measureText("完");
    const x = g.measureText("x");
    const f = (v) => v.toFixed(2);
    return `ja font=${same.join("/") || "unknown"} (${font}); primary ascent=${f(m.fontBoundingBoxAscent)} descent=${f(m.fontBoundingBoxDescent)} box center above baseline=${f((m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2)}px; 完 ink ${f(m.actualBoundingBoxAscent)}..-${f(m.actualBoundingBoxDescent)} center=${f((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2)}px; x ink center=${f((x.actualBoundingBoxAscent - x.actualBoundingBoxDescent) / 2)}px`;
  });
}
