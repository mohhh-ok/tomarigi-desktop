// Shoots the README / download page gallery (docs/design.md "Gallery images") into docs/images/.
// The mock (?mock=1&panel=0&preset=gallery...) is put in a frame over a desktop with a terminal (stage.mjs), English and
// Japanese, at 2540x1520 (762x456 CSS px at 3.33x).
// Needs `bun run dev:web` (port 4842), cwebp, and Playwright, which isn't a dependency of this repo:
//   mkdir -p /tmp/pw && (cd /tmp/pw && bun add playwright && bunx playwright install chromium-headless-shell)
//   PLAYWRIGHT=/tmp/pw/node_modules/playwright node scripts/gallery/shoot.mjs [scene ids...]
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stage } from "./stage.mjs";

const { chromium } = await import(join(process.env.PLAYWRIGHT ?? "playwright", "index.mjs"));
const IMAGES = new URL("../../docs/images/", import.meta.url).pathname;
const only = process.argv.slice(2);
// Windows are sized so the birds fit without overlapping (the app would grow the window; a browser frame can't). Keep every
// window inside the right 500 of the 762 width: the download page shows only that part of the images
// (moh-tech-net, public/tomarigi/desktop/index.html)
const SCENES = [
  { id: "1-on-top", preset: "gallery-on-top", win: { w: 480, h: 284, left: 262, top: 172 }, fade: true },
  { id: "2-garden", preset: "gallery", win: { w: 480, h: 420 } },
  { id: "3-needs-reply", preset: "gallery-asking", win: { w: 480, h: 420 } },
  { id: "4-bubble", preset: "gallery-bubble", win: { w: 480, h: 420 } },
];
const STAGE_URL = "http://localhost:4842/__stage.html";
const work = mkdtempSync(join(tmpdir(), "tomarigi-gallery-"));
// CHROME: a Chromium binary to use instead of the one matching the Playwright version
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const lang of ["en", "ja"]) {
    const ctx = await browser.newContext({ viewport: { width: 762, height: 456 }, deviceScaleFactor: 2540 / 762, locale: lang === "ja" ? "ja-JP" : "en-US" });
    const page = await ctx.newPage();
    for (const sc of SCENES) {
      if (only.length && !only.includes(sc.id)) continue;
      const html = stage({ lang, url: `/?mock=1&panel=0&preset=${sc.preset}`, win: sc.win, fade: sc.fade });
      // Served from the dev server's origin: a cross-origin frame was drawn at 1x and scaled up
      await page.unrouteAll();
      await page.route(STAGE_URL, (r) => r.fulfill({ contentType: "text/html", body: html }));
      await page.goto(STAGE_URL);
      const frame = page.frames().find((f) => f.url().includes("mock=1"));
      await frame.waitForSelector(".garden-node", { timeout: 15000 });
      // Fade until hovered at rest (set by the Rust side in the app)
      if (sc.fade) await frame.evaluate(() => (document.documentElement.dataset.fade = "rest"));
      // Birds fly in when the garden opens
      await page.waitForTimeout(3000);
      const png = join(work, `${sc.id}-${lang}.png`);
      await page.screenshot({ path: png });
      execFileSync("cwebp", ["-quiet", "-q", "86", png, "-o", join(IMAGES, `gallery-${sc.id}-${lang}.webp`)]);
      console.log(`gallery-${sc.id}-${lang}.webp`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
