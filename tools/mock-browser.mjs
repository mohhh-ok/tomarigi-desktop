// What the tools that run the mock in Playwright share (tools/bubble-hit.mjs, scripts/gallery/shoot.mjs): the browser,
// a `vite build` output served without a dev server or port, no calls out, the mock's address, and the Garden's saved
// positions written with the app's own code. Setup (Playwright, CHROME, DIST): tools/README.md "Playwright".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const { chromium, webkit } = await import(join(process.env.PLAYWRIGHT ?? "playwright", "index.mjs"));

/**
 * Headless Chromium; CHROME=<path> uses that binary instead of the one matching the Playwright version. engine "webkit"
 * (or ENGINE=webkit) launches Playwright's WebKit instead, the engine of the app's WebView on macOS (WKWebView)
 */
export const launch = (engine = process.env.ENGINE ?? "chromium") =>
  engine === "webkit" ? webkit.launch() : chromium.launch({ executablePath: process.env.CHROME });

/** The mock's path and query: the app reads mock=1 as the mock and panel=0 as no panel; query adds the scene's */
export const mockPath = (query) => `/?mock=1&panel=0&${query}`;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };

// The app's src/lib/garden-layout.ts, bundled for the browser (with idb), at this path under the page's origin
const GARDEN_LAYOUT = "/__tools/garden-layout.js";
let gardenLayoutJs;
const gardenLayout = () =>
  (gardenLayoutJs ??= execFileSync("bun", ["build", join(ROOT, "src/lib/garden-layout.ts"), "--target=browser", "--format=esm"], {
    encoding: "utf8",
  }));

/**
 * Routes a page's requests: to origin, from dist (a `vite build --outDir` directory; paths without a file get
 * index.html, as the dev server does) when given, else on to whatever serves origin; none to api.github.com (no update
 * checks while checking or shooting). Call it again after page.unrouteAll()
 */
export async function routeMock(page, origin, dist) {
  if (dist) {
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      let body;
      try {
        body = readFileSync(join(dist, path));
      } catch {
        body = readFileSync(join(dist, "index.html"));
      }
      return route.fulfill({ contentType: TYPES[extname(path)] ?? "text/html", body });
    });
  }
  // Registered after origin/**: Playwright tries the latest route first
  await page.route(`${origin}${GARDEN_LAYOUT}`, (route) => route.fulfill({ contentType: "text/javascript", body: gardenLayout() }));
  await page.route("https://api.github.com/**", (route) => route.abort());
}

/**
 * Saves the Garden's positions as a drag does, with the app's saveGardenPositions (src/lib/garden-layout.ts), in the
 * page's origin (routed by routeMock). Load the page again for the Garden to open with them
 */
export const saveGardenPositions = (page, origin, positions) =>
  page.evaluate(async ([url, positions]) => (await import(url)).saveGardenPositions(positions), [`${origin}${GARDEN_LAYOUT}`, positions]);
