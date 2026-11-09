// Shoots the Concierge tab of the mock at given window widths, for a UI check of the tab's bubble (its suggestions and
// state lines, docs/design.md "Concierge"). Headless, from a `vite build` output, with no dev server or port
// (setup and the build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/shots \
//     node tools/concierge-tab-shot.mjs
// Env: WIDTHS (comma-separated CSS px, default 340,260), HEIGHT (default 560), QUERY (the mock's scene, default a
// session needing a reply, a finished one, a working one and a long name that wraps: preset=same-project), SHOT_LANG
// (ja or en, default ja), NAME (the files' prefix, default concierge), LABEL (drawn at the top left of each image, to tell
// shots apart side by side; none by default), REST=1 (shoot at rest, data-fade="rest").
// Writes <OUT>/<NAME>-<width>.png at 2x and prints each path
import { join } from "node:path";
import { mkdirSync } from "node:fs";
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

const browser = await launch();
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
    await ctx.close();
  }
} finally {
  await browser.close();
}
