// Shoots the settings' "AI agent" card and the note shown when the agent changes a setting, in each state, for a UI
// check (docs/design.md "Settings by an AI agent (MCP)"). Headless, from a `vite build` output, with no dev server or
// port (setup and the build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/agent-shots \
//     node tools/agent-access-shot.mjs [scene ids...]
// The page's Tauri calls are answered as Rust answers them (mcp_start gives the command or the scene's error,
// mcp_renew_token a new command); a tool call the MCP server would hand over ("mcp-call") is sent to the page's own
// listener, so the change runs through the app's real tool layer and save functions. Each scene is driven through the
// screen. Env: WIDTHS (default 760,340,260), HEIGHT (default 900), ENGINE (chromium or webkit)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/agent-shots";
const WIDTHS = (process.env.WIDTHS ?? "760,340,260").split(",").map(Number);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const ORIGIN = "http://tomarigi.agent-shot";
mkdirSync(OUT, { recursive: true });

const FAKE_TOKEN = "0".repeat(64);
const command = (port, token = FAKE_TOKEN) =>
  `claude mcp add --scope user --transport http tomarigi http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;

const toggle = (page) => page.locator(".agent-access input[type=checkbox]");

/** Scenes: lang, what mcp_start answers (a command, or an error), and the steps on the screen */
const SCENES = [
  { id: "off", lang: "en", steps: async () => {} },
  { id: "off-ja", lang: "ja", steps: async () => {} },
  {
    id: "on-ja",
    lang: "ja",
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
    },
  },
  {
    id: "on-en",
    lang: "en",
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
    },
  },
  {
    id: "renewed-ja",
    lang: "ja",
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
      await page.getByRole("button", { name: "トークンを作り直す" }).click();
      await page.waitForSelector(".agent-access-command >> nth=1");
    },
  },
  {
    id: "port-in-use-ja",
    lang: "ja",
    start: "port-in-use",
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access .judge-status-error");
    },
  },
  {
    id: "port-invalid-ja",
    lang: "ja",
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
      await page.locator(".agent-access-port-input").fill("80");
      await page.locator(".agent-access-port-input").press("Enter");
      await page.waitForSelector(".agent-access .judge-status-error");
    },
  },
  {
    id: "no-key-store-en",
    lang: "en",
    start: "no-key-store",
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access .judge-status-error");
    },
  },
  {
    id: "changed-ja",
    lang: "ja",
    note: true,
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
      await page.evaluate(() => window.__mcpCall("set_sound", { read_aloud_volume: 70 }));
      await page.evaluate(() => window.__mcpCall("set_concierge_look", { look: "penguin" }));
      await page.waitForSelector(".agent-access-recent li >> nth=1");
      await page.waitForSelector(".agent-change-note");
    },
  },
];

const only = process.argv.slice(2);
const browser = await launch();
try {
  for (const scene of SCENES.filter((s) => only.length === 0 || only.includes(s.id))) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: HEIGHT },
        deviceScaleFactor: 2,
        locale: scene.lang === "ja" ? "ja-JP" : "en-US",
      });
      const page = await ctx.newPage();
      await routeMock(page, ORIGIN, DIST);
      await page.addInitScript(
        ([start, cmd]) => {
          const callbacks = new Map();
          let nextCallback = 1;
          const listeners = new Map();
          let renewed = 0;
          window.__mcpCall = (name, args) => {
            const id = listeners.get("mcp-call");
            if (id === undefined) throw new Error("no mcp-call listener");
            callbacks.get(id)({ event: "mcp-call", id: 0, payload: { id: Date.now(), name, arguments: args } });
          };
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
            transformCallback: (cb) => {
              const id = nextCallback++;
              callbacks.set(id, cb);
              return id;
            },
            unregisterCallback: (id) => callbacks.delete(id),
            invoke: (c, args) => {
              if (c === "log" || c === "mcp_reply" || c === "mcp_stop") return Promise.resolve();
              if (c === "plugin:event|listen") {
                listeners.set(args.event, args.handler);
                return Promise.resolve(args.handler);
              }
              if (c === "mcp_start") return start ? Promise.reject(start) : Promise.resolve(cmd.replace("{port}", args.port));
              if (c === "mcp_renew_token") {
                renewed += 1;
                return Promise.resolve(cmd.replace("{port}", args.port).replace(/0{64}/, String(renewed).repeat(64)));
              }
              return Promise.reject(new Error("no Tauri"));
            },
          };
        },
        [scene.start ?? null, command("{port}")],
      );
      await page.goto(`${ORIGIN}${mockPath("settings=1&scrollTo=agent-access")}`);
      await page.waitForSelector(".agent-access", { timeout: 15000 });
      await scene.steps(page);
      await page.waitForTimeout(400);
      // The window as the user sees it: the card from its heading, or the top of the window for the note
      if (!scene.note) await page.locator(".agent-access h2").evaluate((e) => e.scrollIntoView({ block: "start" }));
      const path = join(OUT, `${scene.id}-${w}.png`);
      await page.screenshot({ path });
      console.log(path);
      if (scene.note) {
        // After the note is gone
        await page.waitForSelector(".agent-change-note", { state: "detached", timeout: 10000 });
        await page.locator(".agent-access h2").evaluate((e) => e.scrollIntoView({ block: "start" }));
        const card = join(OUT, `${scene.id}-card-${w}.png`);
        await page.screenshot({ path: card });
        console.log(card);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
