// Shoots the settings' "Readout voice" in each of its states, for a UI check (docs/design/readout-voice.md "Readout voice (local TTS
// server)"). Headless, from a `vite build` output, with no dev server or port (setup and the build: tools/README.md
// "Playwright"):
//   DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/readout-shots \
//     node tools/readout-voice-shot.mjs [scene ids...]
// The page's Tauri calls are answered as the real servers answered them: tts_list from tests/fixtures/tts/ (captured
// from Kokoro-FastAPI, VOICEVOX ENGINE and AivisSpeech Engine), tts_speech with a short WAV or the scene's error. Other
// calls fail, as in a browser. Each scene is driven through the screen (clicks and typing), so what is shot is what a
// user gets to. Env: WIDTHS (default 760,340,260), HEIGHT (default 900), ENGINE (chromium or webkit, default chromium)
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, mockPath, routeMock } from "./mock-browser.mjs";

const DIST = process.env.DIST;
if (!DIST) throw new Error("DIST=<a vite build --outDir directory> is required");
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/readout-shots";
const WIDTHS = (process.env.WIDTHS ?? "760,340,260").split(",").map(Number);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const ORIGIN = "http://tomarigi.readout-shot";
const FIXTURES = new URL("../tests/fixtures/tts/", import.meta.url).pathname;
const fixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
mkdirSync(OUT, { recursive: true });

// What each server answers (captured; tests/fixtures/tts/README.md)
const SERVERS = {
  kokoro: { "audio/voices": fixture("kokoro-voices.json"), models: fixture("kokoro-models.json") },
  voicevox: { speakers: fixture("voicevox-speakers.json"), engine_manifest: fixture("voicevox-manifest.json") },
  aivis: { speakers: fixture("aivis-speakers.json"), engine_manifest: fixture("aivis-manifest.json") },
  down: {},
};

const pick = (page, label) => page.getByRole("radio", { name: label });
const field = (page, label) =>
  page
    .locator(".readout-voice-card .local-ai-field")
    .filter({ has: page.locator(".local-ai-field-label", { hasText: new RegExp(`^${label}$`) }) })
    .locator("select, input")
    .first();

/** Scenes: lang, the server behind every URL, speech (false: no system voice), and the steps on the screen */
const SCENES = [
  { id: "system", lang: "en", server: "kokoro", steps: async () => {} },
  {
    id: "openai-form",
    lang: "en",
    server: "kokoro",
    steps: async (page) => {
      await pick(page, "Local TTS server").check();
      await page.waitForSelector(".readout-voice-card select:not([disabled])");
    },
  },
  {
    id: "openai-saved-test-ok",
    lang: "en",
    server: "kokoro",
    steps: async (page) => {
      await pick(page, "Local TTS server").check();
      await page.waitForSelector(".readout-voice-card select:not([disabled])");
      await field(page, "Voice").selectOption("jf_alpha");
      await page.locator(".readout-voice-card").getByRole("button", { name: "Save", exact: true }).click();
      await page.locator(".readout-voice-card").getByRole("button", { name: "Play a sample", exact: true }).click();
      await page.waitForSelector(".readout-voice-card .judge-status");
    },
  },
  {
    id: "voicevox-form-ja",
    lang: "ja",
    server: "voicevox",
    steps: async (page) => {
      await pick(page, "ローカルの TTS サーバー").check();
      await field(page, "サーバーの種類").selectOption("voicevox");
      await page.waitForSelector(".readout-voice-card .readout-voice-credit");
    },
  },
  {
    id: "aivis-saved-ja",
    lang: "ja",
    server: "aivis",
    steps: async (page) => {
      await pick(page, "ローカルの TTS サーバー").check();
      await field(page, "サーバーの種類").selectOption("voicevox");
      await page.waitForSelector(".readout-voice-card select:not([disabled])");
      await page.locator(".readout-voice-card").getByRole("button", { name: "保存", exact: true }).click();
    },
  },
  {
    id: "voicevox-en-ja-only",
    lang: "en",
    server: "voicevox",
    steps: async (page) => {
      await pick(page, "Local TTS server").check();
      await field(page, "Server type").selectOption("voicevox");
      await page.waitForSelector(".readout-voice-card select:not([disabled])");
    },
  },
  {
    id: "lists-failed-test-unreachable",
    lang: "en",
    server: "down",
    speech: "network: error sending request",
    steps: async (page) => {
      await pick(page, "Local TTS server").check();
      await page.waitForSelector(".readout-voice-card .ai-card-note");
      await field(page, "Model").fill("kokoro");
      await field(page, "Voice").fill("jf_alpha");
      await page.locator(".readout-voice-card").getByRole("button", { name: "Play a sample", exact: true }).click();
      await page.waitForSelector(".readout-voice-card .judge-status-error");
    },
  },
  {
    id: "no-speech-engine-ja",
    lang: "ja",
    server: "voicevox",
    query: "speech=none",
    steps: async (page) => {
      await pick(page, "ローカルの TTS サーバー").check();
      await field(page, "サーバーの種類").selectOption("voicevox");
      await page.waitForSelector(".readout-voice-card select:not([disabled])");
      await page.locator(".readout-voice-card").getByRole("button", { name: "保存", exact: true }).click();
    },
  },
];

// 0.1 seconds of silence, 8 kHz 8-bit mono
const WAV = (() => {
  const n = 800;
  const b = Buffer.alloc(44 + n, 128);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  return [...b];
})();

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
        ([lists, speech, wav]) => {
          window.__TAURI_INTERNALS__ = {
            metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
            invoke: (cmd, args) => {
              if (cmd === "log") return Promise.resolve();
              if (cmd === "tts_list") {
                const body = lists[args.path];
                return body === undefined ? Promise.reject("network: error sending request") : Promise.resolve({ status: 200, body });
              }
              if (cmd === "tts_speech") {
                return speech ? Promise.reject(speech) : new Promise((r) => setTimeout(() => r(new Uint8Array(wav).buffer), 1200));
              }
              return Promise.reject(new Error("no Tauri"));
            },
            transformCallback: () => 0,
          };
        },
        [SERVERS[scene.server], scene.speech ?? null, WAV],
      );
      await page.goto(`${ORIGIN}${mockPath(`view=settings&section=sound&scrollTo=readout-voice${scene.query ? `&${scene.query}` : ""}`)}`);
      await page.waitForSelector(".readout-voice", { timeout: 15000 });
      await scene.steps(page);
      await page.waitForTimeout(400);
      // The window as the user sees it, scrolled so "Read aloud" and the readout voice are in view
      await page.locator(".voice-enable-row", { hasText: /Read aloud|読み上げ/ }).evaluate((e) => e.scrollIntoView({ block: "start" }));
      const path = join(OUT, `${scene.id}-${w}.png`);
      await page.screenshot({ path });
      console.log(path);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
