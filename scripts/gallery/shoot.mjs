// Shoots the README / download page gallery (docs/design.md "Gallery images") into docs/images/.
// The mock (?mock=1&panel=0&preset=gallery-...) is put in a frame over a desktop with a terminal (stage.mjs), English and
// Japanese, at 3.33x (2540 / 762) CSS px. Perch and Recent activity use the default 762x570 stage (2540x1900); the
// garden's stage is the terminal window on a desktop wallpaper, which the download page shows whole.
// Needs `bun run dev:web` (port 4842), cwebp, and Playwright, which isn't a dependency of this repo:
//   mkdir -p /tmp/pw && (cd /tmp/pw && bun add playwright && bunx playwright install chromium-headless-shell)
//   PLAYWRIGHT=/tmp/pw/node_modules/playwright node scripts/gallery/shoot.mjs [scene ids...]
// OUT=<directory> writes the images there instead of docs/images (trial shots).
// DIST=<a `vite build --outDir` directory> serves that build through Playwright instead, without the dev server or a port
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { STAGE, stage } from "./stage.mjs";

const { chromium } = await import(join(process.env.PLAYWRIGHT ?? "playwright", "index.mjs"));
const IMAGES = process.env.OUT ?? new URL("../../docs/images/", import.meta.url).pathname;
const only = process.argv.slice(2);
// One image per message (docs/design.md "Gallery images"). The garden window is at rest, over the terminal's text and
// past its lower right corner onto the wallpaper, and the download page (moh-tech-net, public/tomarigi/desktop/index.html) shows
// the image whole. Perch
// and Recent activity are never faded; their windows are tall enough to show every row
const SCENES = [
  // The garden's birds are put at saved (dragged) positions, left to right the "?", the working one, and the done one,
  // in as little width as the garden allows so the download page can show them large: the garden keeps each bird's
  // footprint (180px, a bubble's room) 12px from the next (src/lib/garden-place.ts). They run toward the terminal's lower
  // right corner: the "?" and the working bird over the blog session's plan (stage.mjs), the working one beside the "?"
  // since the "?" bird's bubble takes the room below it, and the done bird past the terminal's right edge on the
  // wallpaper, its bubble crossing the edge. The wallpaper is narrow enough that the bubbles' text reads where the page
  // shows the image about 680px wide
  {
    id: "1-garden",
    query: "preset=gallery-garden",
    // The garden is the window less 46px across and 112px down (handle and tabs): 502 x 193
    // The handle sits in the empty band under the user's ask (askGap), over no text, which puts the birds by the plan's
    // middle lines (the handle's distance above the birds is the app's)
    win: { w: 548, h: 305, left: 83, top: 116 },
    size: { w: 620, h: 450, term: { left: 14, top: 14, w: 470, h: 400 }, cmdGap: 10, askGap: 42, wall: true },
    fade: true,
    ready: ".garden-node",
    positions: { "gallery/plan": { x: 18.7, y: 0 }, "gallery/working": { x: 42.6, y: 31 }, "gallery/finished": { x: 81.3, y: 100 } },
  },
  { id: "2-perch", query: "preset=gallery-perch&tab=perch", win: { w: 480, h: 540 }, ready: ".perch .bird" },
  { id: "3-activity", query: "preset=gallery-activity&tab=events", win: { w: 480, h: 540 }, ready: ".event-card" },
];
const ORIGIN = process.env.DIST ? "http://tomarigi.gallery" : "http://localhost:4842";
const STAGE_URL = `${ORIGIN}/__stage.html`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };
// Answers every request to ORIGIN from DIST; paths without a file get index.html, as the dev server does
const serveDist = (route) => {
  const path = new URL(route.request().url()).pathname;
  let body;
  try {
    body = readFileSync(join(process.env.DIST, path));
  } catch {
    body = readFileSync(join(process.env.DIST, "index.html"));
  }
  return route.fulfill({ contentType: TYPES[extname(path)] ?? "text/html", body });
};
const work = mkdtempSync(join(tmpdir(), "tomarigi-gallery-"));
// CHROME: a Chromium binary to use instead of the one matching the Playwright version
const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const lang of ["en", "ja"]) {
    const ctx = await browser.newContext({ viewport: { width: STAGE.w, height: STAGE.h }, deviceScaleFactor: 2540 / STAGE.w, locale: lang === "ja" ? "ja-JP" : "en-US" });
    const page = await ctx.newPage();
    for (const sc of SCENES) {
      if (only.length && !only.includes(sc.id)) continue;
      const size = sc.size ?? STAGE;
      const html = stage({ lang, url: `/?mock=1&panel=0&${sc.query}`, win: sc.win, fade: sc.fade, size });
      await page.setViewportSize({ width: size.w, height: size.h });
      // Served from the dev server's origin: a cross-origin frame was drawn at 1x and scaled up
      await page.unrouteAll();
      if (process.env.DIST) await page.route(`${ORIGIN}/**`, serveDist);
      // No update checks or other calls out while shooting
      await page.route("https://api.github.com/**", (r) => r.abort());
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
