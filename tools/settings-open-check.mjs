// Checks that the floating window's ⚙ and Cmd+, (Ctrl+, off macOS) ask the app to open the settings window, and that
// Cmd+, in the settings window does too (docs/design/settings-window.md "Settings window"). Headless, from a `vite build` output, with no
// dev server or port (setup and the build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/settings-open-check.mjs
// The page's Tauri calls are recorded; each check passes when `open_settings` was called. Exits 1 when one fails
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const ORIGIN = "http://tomarigi.settings-open";

async function openPage(browser, label, query) {
  const ctx = await browser.newContext({ viewport: { width: 340, height: 480 }, locale: "en-US" });
  const page = await ctx.newPage();
  await routeMock(page, ORIGIN, DIST);
  await page.addInitScript((label) => {
    window.__invoked = [];
    let next = 1;
    const callbacks = new Map();
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
      transformCallback: (cb) => {
        const id = next++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id) => callbacks.delete(id),
      invoke: (c, args) => {
        window.__invoked.push({ c, args });
        if (c === "log" || c.startsWith("plugin:event|") || c === "open_settings") return Promise.resolve(c === "plugin:event|listen" ? 1 : undefined);
        return Promise.reject(new Error("no Tauri"));
      },
    };
  }, label);
  page.on("pageerror", () => {});
  await page.goto(`${ORIGIN}${mockPath(query)}`);
  // The page takes Cmd on a Mac user agent and Ctrl elsewhere, as the app does
  const mod = (await page.evaluate(() => navigator.userAgent.includes("Mac"))) ? "Meta" : "Control";
  return { ctx, page, mod };
}

const opened = (page) => page.evaluate(() => window.__invoked.filter((i) => i.c === "open_settings").map((i) => i.args ?? null));

const results = [];
const browser = await launch();
try {
  {
    const { ctx, page, mod } = await openPage(browser, "main", "");
    await page.waitForSelector(".header-controls button[aria-label='Settings']", { timeout: 15000 });
    await page.click(".header-controls button[aria-label='Settings']");
    await page.waitForTimeout(200);
    results.push(["floating window: ⚙", (await opened(page)).length === 1]);
    await page.keyboard.press(`${mod}+Comma`);
    await page.waitForTimeout(200);
    results.push([`floating window: ${mod}+,`, (await opened(page)).length === 2]);
    await ctx.close();
  }
  {
    const { ctx, page, mod } = await openPage(browser, "settings", "view=settings&section=sound");
    await page.waitForSelector(".settings-nav-item.active", { timeout: 15000 });
    await page.keyboard.press(`${mod}+Comma`);
    await page.waitForTimeout(200);
    results.push([`settings window: ${mod}+,`, (await opened(page)).length === 1]);
    await ctx.close();
  }
} finally {
  await browser.close();
}
for (const [name, ok] of results) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
