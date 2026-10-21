// Shoots the README / download page gallery (docs/design.md "Gallery images") into docs/images/.
// The mock (?mock=1&panel=0&preset=gallery-...) is put in a frame over a desktop with a terminal (stage.mjs), English and
// Japanese, at 2540x1900 (762x570 CSS px at 3.33x).
// Needs `bun run dev:web` (port 4842), cwebp, and Playwright, which isn't a dependency of this repo:
//   mkdir -p /tmp/pw && (cd /tmp/pw && bun add playwright && bunx playwright install chromium-headless-shell)
//   PLAYWRIGHT=/tmp/pw/node_modules/playwright node scripts/gallery/shoot.mjs [scene ids...]
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGE, stage } from "./stage.mjs";

const { chromium } = await import(join(process.env.PLAYWRIGHT ?? "playwright", "index.mjs"));
const IMAGES = new URL("../../docs/images/", import.meta.url).pathname;
const only = process.argv.slice(2);
// One image per message (docs/design.md "Gallery images"). The garden window is at rest, at the left over the terminal's
// text, and the download page (moh-tech-net, public/tomarigi/desktop/index.html) crops to the handle, the birds, and the
// text around them. Perch and Recent activity are never faded; their windows are tall enough to show every row
const SCENES = [
  // The garden's birds are put at saved (dragged) positions, in a row with room between them: left to right the "?", the
  // working one, and the done one. The grid would put them where their ids happen to land, two of them touching
  {
    id: "1-garden",
    query: "preset=gallery-garden",
    // Wide enough for three birds' footprints (a bubble's 180px each, 12px apart) side by side
    win: { w: 615, h: 300, left: 140, top: 300 },
    fade: true,
    ready: ".garden-node",
    positions: { "gallery/plan": { x: 16, y: 0 }, "gallery/working": { x: 50, y: 0 }, "gallery/finished": { x: 84, y: 0 } },
  },
  { id: "2-perch", query: "preset=gallery-perch&tab=perch", win: { w: 480, h: 540 }, ready: ".perch .bird" },
  { id: "3-activity", query: "preset=gallery-activity&tab=events", win: { w: 480, h: 540 }, ready: ".event-card" },
];
const STAGE_URL = "http://localhost:4842/__stage.html";
const work = mkdtempSync(join(tmpdir(), "tomarigi-gallery-"));
// CHROME: a Chromium binary to use instead of the one matching the Playwright version
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const lang of ["en", "ja"]) {
    const ctx = await browser.newContext({ viewport: { width: STAGE.w, height: STAGE.h }, deviceScaleFactor: 2540 / STAGE.w, locale: lang === "ja" ? "ja-JP" : "en-US" });
    const page = await ctx.newPage();
    for (const sc of SCENES) {
      if (only.length && !only.includes(sc.id)) continue;
      const html = stage({ lang, url: `/?mock=1&panel=0&${sc.query}`, win: sc.win, fade: sc.fade });
      // Served from the dev server's origin: a cross-origin frame was drawn at 1x and scaled up
      await page.unrouteAll();
      await page.route(STAGE_URL, (r) => r.fulfill({ contentType: "text/html", body: html }));
      await page.goto(STAGE_URL);
      if (sc.positions) {
        // The same IndexedDB entry as a drag saves (src/lib/garden-layout.ts), then load the stage again to use it
        await page.evaluate(
          (positions) =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open("tomarigi", 1);
              open.onupgradeneeded = () => open.result.createObjectStore("kv");
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const tx = open.result.transaction("kv", "readwrite");
                tx.objectStore("kv").put(positions, "gardenPositions");
                tx.oncomplete = () => (open.result.close(), resolve());
                tx.onerror = () => reject(tx.error);
              };
            }),
          sc.positions,
        );
        await page.goto(STAGE_URL);
      }
      const frame = page.frames().find((f) => f.url().includes("mock=1"));
      await frame.waitForSelector(sc.ready, { timeout: 15000 });
      // Fade until hovered at rest (set by the Rust side in the app)
      if (sc.fade) await frame.evaluate(() => (document.documentElement.dataset.fade = "rest"));
      // Birds fly in when the garden opens; rows fade in
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
