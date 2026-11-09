# tools

Tools for checking the app's behavior by hand or from an agent. Not part of the build.

## Playwright

The tools that open the mock in a browser (bubble-hit.mjs, heap-mock.mjs, and scripts/gallery/shoot.mjs) use
Playwright, which isn't a dependency of this repo. Install it outside the repo and pass its path as `PLAYWRIGHT`:

```sh
mkdir -p /tmp/pw && (cd /tmp/pw && bun add playwright && bunx playwright install chromium-headless-shell)
```

`CHROME=<path>` uses that Chromium instead of the one matching the Playwright version. To run the mock without a dev
server or port, build it once and pass the output as `DIST` (bubble-hit.mjs needs it; shoot.mjs uses the dev server at
4842 without it):

```sh
bunx vite build --outDir /tmp/tomarigi-desktop/dist
```

What bubble-hit.mjs and shoot.mjs share is in mock-browser.mjs: launching the browser, serving `DIST` (paths without a
file get index.html, as the dev server does), no calls to api.github.com, the mock's address (`/?mock=1&panel=0&…`),
and saving the Garden's positions as a drag does. That last one runs the app's own `saveGardenPositions`
(src/lib/garden-layout.ts), bundled with `bun build` when a tool starts and loaded into the page, so the tools don't
keep their own copy of the database's names. `bun` has to be on the PATH.

## chick-scan-measure.ts

Runs the app's own `scanChicks` (src/lib/session-chicks.ts) on a real parent transcript and its `subagents/` folder,
and prints how many chicks came out in each state, the ones still working, the time of the first scan and of a
second, incremental one, and the peak RSS. Use it to check a change to how chicks are judged done, or what reading
their completion records costs, on a parent with many chicks. Files are read through stand-ins backed by node:fs
instead of Tauri's `fs_read`. Read only.

```sh
bun tools/chick-scan-measure.ts ~/.claude/projects/<project>/<session id>.jsonl
```

## concierge-tab-shot.mjs

Shoots the mock's Concierge tab at given window widths (default 340px and 260px) for a UI check of its bubble: the
suggestions and the state lines. By default the scene has a session needing a reply, finished ones, a working one and
a long name that wraps (`preset=same-project`), in Japanese. Needs a `vite build` output (`DIST`) and Playwright
("Playwright" above); no dev server or port.

```sh
DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright OUT=/tmp/tomarigi-desktop/shots \
  node tools/concierge-tab-shot.mjs
```

Env: `WIDTHS`, `HEIGHT`, `QUERY` (another mock scene), `SHOT_LANG=en`, `NAME` (the files' prefix), `LABEL` (drawn at
the top left of each image, to tell shots apart), `REST=1` (at rest), `CSS` (a style sheet added to the page, to try a
value before writing it, e.g. `CSS='.concierge-status-lines { --dot-nudge: 1px }'`). Writes `<OUT>/<NAME>-<width>.png` at 2x.

`ENGINE=webkit` shoots in Playwright's WebKit, the engine of the app's WebView on macOS (`bunx playwright install
webkit` in the Playwright directory); the default is Chromium.

After each shot it prints, per state line, how far the vertical center of the dot's ink (the pixels it paints) is
from that of the ink of the lowercase x-height letters (a c e m n o r s u v w x z) on the line's first line, and from
that of its kanji and kana (dot minus text; plus is lower), in device px (2x) and CSS px, and writes it to
`<OUT>/<NAME>-<width>-dots.txt`. Against the x-height letters, every line should be within ±0.5 device px in WebKit
(the dot sits at their middle, docs/design.md "Concierge"; the kanji and kana come out about 1px above it). Ink, not
the text's box: the box is the UI font's ascent to descent (SF, the first of `-apple-system`, with a tall ascent), so
its middle is above where the letters are. Each file's first line names the font the Japanese is drawn in (by
comparing a canvas drawing against candidate fonts) and the primary font's ascent and descent. The ink comes from three
shots of the page: nothing on the lines drawn, only the dots, only the text.

## turn-verdict-probe.ts

Runs the turn verdict (docs/design.md "Turn verdicts") on real replies several times with OpenAI and Anthropic, with
the app's prompt, schema, models, and settings, and counts asking and continuing per reply. Used to compare a prompt
change before and after.

```sh
OPENAI_API_KEY=… ANTHROPIC_API_KEY=… bun tools/turn-verdict-probe.ts /tmp/tomarigi-desktop/cases.json before 8
```

The cases file is a JSON array of `{ name, want_asking, want_continuing, file, ts, user }`: `file` and `ts` find the
assistant line in a local transcript (its text blocks, last 2000 characters, are sent as the app does), and `user` is
the turn's user messages (each cut to 500 characters, as the app does). It points at local transcripts, so it stays
outside the repo. Prints one line per reply and provider, and writes every run's answer to
`$OUT/turn-verdict-<label>.json` (`OUT` defaults to /tmp/tomarigi-desktop). Env: `PROVIDERS` (default
`openai,anthropic`; `local` sends the app's Chat Completions body to `LOCAL_BASE_URL`, default
`http://localhost:11434/v1`, with `LOCAL_MODEL`, default `qwen2.5:14b-instruct`), `CASES` (comma-separated names to run).
Pass the keys as environment variables; don't print them.

The request and the reading of the answer are the app's own functions (`openAiJudgeBody` / `parseOpenAiJudgeReply`,
`anthropicJudgeBody` / `parseAnthropicJudgeReply`). A run the app would treat as failed (an HTTP error, a refusal, an
answer cut at the token limit, an incomplete answer, no output, or output that isn't JSON) counts in `errors` and is
kept as an `ERR` line. `asking` and `continuing` don't count `ERR` runs, though the printed denominator is still all
runs. The verdict's fields aren't checked against the schema, so an answer missing a field counts as neither.
A case whose `ts` finds no assistant line, or a line with no text, stops the whole run with an error before anything
is written, so a wrong case is caught instead of being sent empty.

## webview-mem.sh

Records the memory of one process with a timestamp, one line per sample: footprint (KB), the "WebKit malloc" line of
`footprint` (the JS heap and DOM side of WebKit), and RSS (KB). Used to see whether the WebView grows (issue #8).

```sh
tools/webview-mem.sh <pid> [interval seconds = 60] [samples = 10] > /tmp/tomarigi-desktop/mem.txt
```

Finding the pid of the app's WebView (the WebKit WebContent process; it is a child of launchd, not of the app):

1. List the WebContent pids before launching:
   `ps -axo pid=,command= | grep "[c]om.apple.WebKit.WebContent" | awk '{print $1}' | sort > /tmp/tomarigi-desktop/wc-before.txt`
2. Launch the app, wait a few seconds, list them again into `wc-after.txt`
3. `comm -13 /tmp/tomarigi-desktop/wc-before.txt /tmp/tomarigi-desktop/wc-after.txt` is the new one. For `bun run dev`,
   `lsof -nP -iTCP:4842` shows the WebKit Networking process connected to vite; the WebContent process started in the same
   second is the app's

Use footprint rather than RSS to judge growth: RSS goes up and down as macOS compresses and swaps pages.

## heap-mock.mjs

Runs the mock screen with updates sped up, to see whether something piles up in the page (issue #8). Needs the dev
server at 4842 (`bun run dev:web` or `bun run dev`) and Playwright ("Playwright" above); for `BROWSER=webkit`, also run
`bunx playwright install webkit` in /tmp/pw.

```sh
# Chromium: JS heap snapshots at the start and the end, and the objects that grew between them
MINUTES=10 PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/heap-mock.mjs
# WebKit (what the app runs on): no heap snapshots, so it prints its web process pid; measure it with webview-mem.sh
BROWSER=webkit RESIZE=1 MINUTES=12 PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/heap-mock.mjs
```

Env: `QUERY` (the mock's query; default the Concierge tab with `cycle=0.5`), `TABS=1` (switch tabs every `TAB_SECONDS`),
`RESIZE=1` (flip the viewport between 260×350 and 260×378 every `RESIZE_MS`, as the Concierge tab's window fit does),
`OUT` (where the snapshots go; default /tmp/tomarigi-desktop/heap-mock).

## bubble-hit.mjs

Checks in a headless browser what a click on a speech bubble reaches (docs/design.md "Fade until hovered"): the
concierge's bubble takes clicks over its whole box, its empty space included, so a bird drawn under it isn't pressed
through it and nothing jumps; a bird's own bubble lets clicks through. Runs the mock from a `vite build` output, with no
dev server or port, in the Garden (the concierge with a bird put under its bubble, and birds with bubbles,
`preset=asking`) and in the Concierge tab, each shown and at rest.

With Playwright and a build ("Playwright" above):

```sh
DIST=/tmp/tomarigi-desktop/dist PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/bubble-hit.mjs
```

Prints one `OK` / `NG` line per check with what `document.elementFromPoint` returned, the `[mock] focus` lines a click
logged (`?focusable=1`), or the Tauri calls a grab made (`plugin:window|start_dragging` moves the window). Exits 1 when
any check is NG.
