// Shoots the settings window's "Settings file" section and the note the floating window shows when an edit of the
// settings file is taken, for a UI check (docs/design.md "Settings file"). Headless, from a `vite build` output, with no
// dev server or port (setup and the build: tools/README.md "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/settings-file-shots \
//     node tools/settings-file-shot.mjs [scene ids...]
// The page's calls to Rust are answered as settings_file.rs answers them. The note scene opens the floating window's page
// and sends it "settings-file-edited" as Rust's worker does, so the edit runs through the app's real checks
// (lib/settings-file.ts). Env: SIZES (default 760x560,560x420)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/settings-file-shots";
const SIZES = (process.env.SIZES ?? "760x560,560x420").split(",").map((s) => s.split("x").map(Number));
const ORIGIN = "http://tomarigi.settings-file-shot";
mkdirSync(OUT, { recursive: true });

const PATHS = {
  settings: "~/.tomarigi/settings.json",
  settingsAbsolute: "/Users/me/.tomarigi/settings.json",
  readme: "~/.tomarigi/README.md",
  log: "~/Library/Logs/tomarigi-desktop/app-log.txt",
};
const now = Date.now();
const RECENT = {
  ja: [
    { id: 3, at: now, text: "読み上げの声: システムの声 → VOICEVOX: 四国めたん（ノーマル）", problem: false },
    { id: 2, at: now, text: "音で知らせる › 音量: 100% → 40%", problem: false },
    { id: 1, at: now - 60_000, text: "声で読み上げる › 音量 (readAloudVolume): 140 は使えません。0 から 100 までの整数（パーセント）で書いてください。（前の値 60% のまま）", problem: true },
  ],
  en: [
    { id: 3, at: now, text: "Readout voice: System voice → VOICEVOX: Shikoku Metan (Normal)", problem: false },
    { id: 2, at: now, text: "Notify with sound › Volume: 100% → 40%", problem: false },
    { id: 1, at: now - 60_000, text: "Read aloud with voice › Volume (readAloudVolume): 140 can't be used. Write a whole number from 0 to 100 (percent). (kept the previous value, 60%)", problem: true },
  ],
};
const APPLIED = { chirps: true, chirpVolume: 100, readAloud: false, readAloudVolume: 100, readoutVoice: { source: "system" }, localAi: null, summaryProvider: null, windowMode: "floating", conciergeLook: "owl", iconSets: {}, watchedFolders: [], defaultFolderLabels: {} };

/** Scenes: lang, what the settings page gets (recent list, MCP note) or, for `note`, the edit sent to the floating window */
const SCENES = [];
for (const lang of ["ja", "en"]) {
  SCENES.push({ id: `section-${lang}`, lang, recent: [] });
  SCENES.push({ id: `section-list-${lang}`, lang, recent: RECENT[lang] });
  SCENES.push({ id: `section-mcp-${lang}`, lang, recent: [], mcpNote: true });
  SCENES.push({ id: `note-${lang}`, lang, note: { ...APPLIED, chirpVolume: 40, readAloudVolume: 140, conciergeLook: "penguin" } });
  SCENES.push({ id: `note-unreadable-${lang}`, lang, unreadable: [4, 13] });
}

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
      page.on("pageerror", (e) => e.message.includes("unregisterListener") || console.log(`[page error] ${e.message}`));
      await routeMock(page, ORIGIN, DIST);
      await page.addInitScript(
        ([label, recent, mcpNote, paths, applied]) => {
          const callbacks = new Map();
          let nextCallback = 1;
          const listeners = new Map();
          const send = (event, payload) => {
            const id = listeners.get(event);
            if (id !== undefined) callbacks.get(id)({ event, id: 0, payload });
          };
          const values = { ...applied };
          window.__hasListener = (event) => listeners.has(event);
          window.__send = send;
          if (mcpNote) {
            const open = indexedDB.open("tomarigi", 1);
            open.onupgradeneeded = () => open.result.createObjectStore("kv");
            open.onsuccess = () => open.result.transaction("kv", "readwrite").objectStore("kv").put("shown", "mcpRemovedNote");
          }
          // What Tauri sets in the app; lib/kv.ts sends the settings of the file to Rust only then
          window.isTauri = true;
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
            transformCallback: (cb) => {
              const id = nextCallback++;
              callbacks.set(id, cb);
              return id;
            },
            unregisterCallback: (id) => callbacks.delete(id),
            invoke: (c, args) => {
              if (c === "log" || c === "plugin:event|emit" || c === "settings_set" || c === "settings_file_fill") return Promise.resolve();
              if (c === "plugin:event|listen") {
                listeners.set(args.event, args.handler);
                return Promise.resolve(args.handler);
              }
              if (c === "plugin:event|emit_to") {
                if (args.event === "settings-runtime-request") {
                  setTimeout(() => send("settings-runtime", { running: [], brokenIds: [], settingsFile: recent }), 0);
                }
                return Promise.resolve();
              }
              if (c === "settings_file_paths") return Promise.resolve(paths);
              if (c === "settings_file_open") return Promise.resolve({ state: "ok", doc: values, line: null, column: null, applied: values });
              if (c === "settings_get") return Promise.resolve(values[args.field] ?? null);
              if (c === "settings_accept") {
                values[args.field] = args.value;
                return Promise.resolve();
              }
              if (c === "key_status") return Promise.resolve({ anthropic: false, openai: false });
              if (c === "default_roots") return Promise.resolve([]);
              if (c === "get_window_mode") return Promise.resolve("floating");
              return Promise.reject(new Error("no Tauri"));
            },
          };
        },
        [scene.note || scene.unreadable ? "main" : "settings", scene.recent ?? [], scene.mcpNote === true, PATHS, APPLIED],
      );
      await page.goto(`${ORIGIN}${mockPath(scene.note || scene.unreadable ? "" : "view=settings&section=settingsFile")}`);
      if (scene.unreadable) {
        await page.waitForFunction(() => window.__hasListener("settings-file-unreadable"), null, { timeout: 15000 });
        await page.evaluate((at) => window.__send("settings-file-unreadable", at), scene.unreadable);
        await page.waitForSelector(".settings-file-note", { timeout: 5000 });
      } else if (scene.note) {
        await page.waitForFunction(() => window.__hasListener("settings-file-edited"), null, { timeout: 15000 });
        await page.evaluate(([doc, before]) => window.__send("settings-file-edited", { doc, before }), [scene.note, APPLIED]);
        await page.waitForSelector(".settings-file-note", { timeout: 5000 });
      } else {
        await page.waitForSelector(".settings-file", { timeout: 15000 });
        if (scene.mcpNote) await page.waitForSelector(".settings-file-mcp", { timeout: 5000 });
        if (scene.recent?.length) await page.waitForSelector(".settings-file-recent li");
      }
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
