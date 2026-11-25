// Shoots every section of the settings window (docs/design.md "Settings window") at its default and smallest size, in
// English and Japanese, for a UI check. Headless, from a `vite build` output, with no dev server or port (setup and the
// build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/settings-shots \
//     node tools/settings-window-shot.mjs [section ids...]
// The page is the mock's settings view (`?mock=1&view=settings&section=<id>`); outside the app the running projects
// come from the mock source and agent access is off. Each section is shot at its top and scrolled to its end (`-end`).
// Env: SIZES (default 760x560,560x420), LANGS (default en,ja)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/settings-shots";
const SIZES = (process.env.SIZES ?? "760x560,560x420").split(",").map((s) => s.split("x").map(Number));
const LANGS = (process.env.LANGS ?? "en,ja").split(",");
const SECTIONS = ["sound", "ai", "concierge", "folders", "icons", "window", "agent", "updates"];
const ORIGIN = "http://tomarigi.settings-shot";
mkdirSync(OUT, { recursive: true });

const only = process.argv.slice(2);
const browser = await launch();
try {
  for (const lang of LANGS) {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        deviceScaleFactor: 2,
        locale: lang === "ja" ? "ja-JP" : "en-US",
      });
      const page = await ctx.newPage();
      await routeMock(page, ORIGIN, DIST);
      for (const section of SECTIONS.filter((s) => only.length === 0 || only.includes(s))) {
        await page.goto(`${ORIGIN}${mockPath(`view=settings&section=${section}`)}`);
        await page.waitForSelector(".settings-nav-item.active", { timeout: 15000 });
        await page.waitForTimeout(300);
        const path = join(OUT, `${section}-${lang}-${w}x${h}.png`);
        await page.screenshot({ path });
        console.log(path);
        // The window scrolled to the end of the section, as far as the user can scroll
        await page.locator(".settings-content").evaluate((e) => e.scrollTo(0, e.scrollHeight));
        await page.waitForTimeout(150);
        const end = join(OUT, `${section}-${lang}-${w}x${h}-end.png`);
        await page.screenshot({ path: end });
        console.log(end);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
