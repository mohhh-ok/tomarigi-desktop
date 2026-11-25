// Shoots the settings window's "AI agent" section and the note the floating window shows when the agent changes a
// setting, in each state, for a UI check (docs/design.md "Settings by an AI agent (MCP)", "Settings window"). Headless,
// from a `vite build` output, with no dev server or port (setup and the build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/agent-shots \
//     node tools/agent-access-shot.mjs [scene ids...]
// The settings page (`view=settings&section=agent`) shows what the floating window sends it (settings-runtime.ts): each
// scene gives that state, answered when the page asks for it. The note scene opens the floating window's page instead
// and hands it a tool call as the MCP server would ("mcp-call"), so the change runs through the app's real tool layer
// and save functions. Env: SIZES (default 760x560,560x420), ENGINE (chromium or webkit)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/agent-shots";
const SIZES = (process.env.SIZES ?? "760x560,560x420").split(",").map((s) => s.split("x").map(Number));
const ORIGIN = "http://tomarigi.agent-shot";
mkdirSync(OUT, { recursive: true });

const FAKE_TOKEN = "0".repeat(64);
const command = (port, token = FAKE_TOKEN) =>
  `claude mcp add --scope user --transport http tomarigi http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`;

const ON = { status: "on", command: command(4844), replaced: false, recent: [] };
const now = Date.now();

const toggle = (page) => page.locator(".agent-access input[type=checkbox]");

/** Scenes: lang, the floating window's state (runtime) and the steps on the screen; `note` shoots the floating window */
const SCENES = [
  { id: "off", lang: "en", steps: async () => {} },
  { id: "off-ja", lang: "ja", steps: async () => {} },
  {
    id: "on-ja",
    lang: "ja",
    runtime: ON,
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
    },
  },
  {
    id: "on-en",
    lang: "en",
    runtime: ON,
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
    },
  },
  {
    id: "renewed-ja",
    lang: "ja",
    runtime: { ...ON, command: command(4844, "1".repeat(64)), replaced: true },
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-command");
    },
  },
  {
    id: "port-in-use-ja",
    lang: "ja",
    runtime: { status: "port-in-use", command: null, replaced: false, recent: [] },
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access .judge-status-error");
    },
  },
  {
    id: "port-invalid-ja",
    lang: "ja",
    runtime: ON,
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
    // The floating window turned the switch back off and says why
    runtime: { status: "no-key-store", command: null, replaced: false, recent: [] },
    steps: async (page) => {
      await page.waitForSelector(".agent-access .judge-status-error");
    },
  },
  {
    id: "changed-ja",
    lang: "ja",
    runtime: {
      ...ON,
      recent: [
        { id: 2, at: now, setting: "コンシェルジュ", from: "フクロウ", to: "ペンギン" },
        { id: 1, at: now, setting: "読み上げの音量", from: "100%", to: "70%" },
      ],
    },
    steps: async (page) => {
      await toggle(page).check();
      await page.waitForSelector(".agent-access-recent li >> nth=1");
    },
  },
  {
    id: "note-ja",
    lang: "ja",
    note: true,
    steps: async (page) => {
      await page.waitForFunction(() => window.__hasListener("mcp-call"));
      await page.evaluate(() => window.__mcpCall("set_sound", { read_aloud_volume: 70 }));
      await page.evaluate(() => window.__mcpCall("set_concierge_look", { look: "penguin" }));
      await page.waitForSelector(".agent-change-note");
    },
  },
];

const only = process.argv.slice(2);
const browser = await launch();
try {
  for (const scene of SCENES.filter((s) => only.length === 0 || only.includes(s.id))) {
    for (const [w, h] of SIZES) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        deviceScaleFactor: 2,
        locale: scene.lang === "ja" ? "ja-JP" : "en-US",
      });
      const page = await ctx.newPage();
      if (process.env.DEBUG) page.on("console", (m) => console.log(`[page] ${m.text()}`));
      // The fake has no event plugin internals, so unlistening on unmount throws; that isn't the page's error
      page.on("pageerror", (e) => e.message.includes("unregisterListener") || console.log(`[page error] ${e.message}`));
      await routeMock(page, ORIGIN, DIST);
      await page.addInitScript(
        ([label, runtime, start, cmd]) => {
          const callbacks = new Map();
          let nextCallback = 1;
          const listeners = new Map();
          const send = (event, payload) => {
            const id = listeners.get(event);
            if (id !== undefined) callbacks.get(id)({ event, id: 0, payload });
          };
          window.__hasListener = (event) => listeners.has(event);
          window.__mcpCall = (name, args) => {
            if (!listeners.has("mcp-call")) throw new Error("no mcp-call listener");
            send("mcp-call", { id: Date.now(), name, arguments: args });
          };
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
            transformCallback: (cb) => {
              const id = nextCallback++;
              callbacks.set(id, cb);
              return id;
            },
            unregisterCallback: (id) => callbacks.delete(id),
            invoke: (c, args) => {
              if (c === "log" || c === "mcp_reply" || c === "mcp_stop" || c === "plugin:event|emit") return Promise.resolve();
              if (c === "plugin:event|listen") {
                listeners.set(args.event, args.handler);
                return Promise.resolve(args.handler);
              }
              if (c === "plugin:event|emit_to") {
                // The settings page asks the floating window for its state
                if (args.event === "settings-runtime-request") setTimeout(() => send("settings-runtime", { running: [], brokenIds: [], agent: runtime }), 0);
                return Promise.resolve();
              }
              if (c === "mcp_start") return start ? Promise.reject(start) : Promise.resolve(cmd.replace("{port}", args.port));
              return Promise.reject(new Error("no Tauri"));
            },
          };
        },
        [
          scene.note ? "main" : "settings",
          scene.runtime ?? { status: "off", command: null, replaced: false, recent: [] },
          null,
          command("{port}"),
        ],
      );
      await page.goto(`${ORIGIN}${mockPath(scene.note ? "" : "view=settings&section=agent")}`);
      await page.waitForSelector(scene.note ? ".page" : ".agent-access", { timeout: 15000 });
      await scene.steps(page);
      await page.waitForTimeout(400);
      const path = join(OUT, `${scene.id}-${w}x${h}.png`);
      await page.screenshot({ path });
      console.log(path);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
