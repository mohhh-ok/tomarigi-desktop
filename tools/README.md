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

Env: `WIDTHS`, `HEIGHT`, `QUERY` (another mock scene; `preset=concierge-long&tab=concierge&concierge=` has state lines
long enough to be cut at 2 lines), `SHOT_LANG=en`, `NAME` (the files' prefix), `LABEL` (drawn at
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

## llm-regression/

The LLM regression test (docs/design.md "LLM regression test"): runs the turn verdict and the concierge on the scenes
in `cases.ts` with real models and prints the pass rate per scene and provider. Not part of `bun run test`; run it
when `bun run test:llm:needed` says a change can change its results.

```sh
bun install                                   # once: zod and typescript come from the dev dependencies
bun run test:llm:needed                       # "run" with the declarations a change touched, or "not needed"
set -a; source .env; set +a; bun run test:llm # every provider that can run, 8 runs a scene
bun run test:llm -- --dry-run                 # requests and rough input tokens per provider, no API call
bun run test:llm -- --baseline /tmp/tomarigi-desktop/llm/llm-regression-<label>.json   # before → after, NG on a drop
```

- `run.ts` sends the app's own requests: `summarizeTurn` / `turnPayload` (src/lib/summarize.ts) and `askConcierge` /
  `buildConciergePayload` (src/lib/concierge.ts), through `judgeRunnerFor` (src/lib/ai-judge.ts), so the prompts,
  schemas, models, request bodies, the reading of answers, and the checks after the answer (dropReason) are the app's.
  Only the transport differs: `transport.ts` posts the bodies with fetch to the URLs, headers, and timeouts of
  src-tauri/src/keys.rs, with keys from the environment instead of the Keychain
- Options (flags, or the env in brackets): `--providers openai,anthropic,local` (`LLM_PROVIDERS`; default all three),
  `--runs 8` (`LLM_RUNS`), `--cases a,b` (`LLM_CASES`), `--min-pass 0.75` (`LLM_MIN_PASS`: a scene under it is NG),
  `--baseline <json>` (`LLM_BASELINE`), `--label <name>` (`LLM_LABEL`; the result's file name), `--dry-run`. Keys:
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Local: `LOCAL_BASE_URL` (default `http://localhost:11434/v1`) and
  `LOCAL_MODEL` (default `qwen2.5:14b-instruct`). The environment is checked with zod at start; a key that doesn't
  look like one stops it. Pass keys as environment variables; don't print them
- A provider without a key, a Local server that isn't running or doesn't have the model, or Local while memory pressure
  is at warning or above is printed as `not run (<why>)` and shown as `not run` in the table; the others still run.
  Providers run side by side, one request at a time each
- Prints one line per scene and provider as it goes, the table (`passed/runs`, or `before → after` with a baseline),
  the tokens the API counted per provider, and an `NG` line for each scene under `--min-pass` or below its baseline.
  Exits 1 when there is any. Every answer of every run is written to `$OUT/llm-regression-<label>.json` (`OUT` defaults
  to /tmp/tomarigi-desktop/llm); pass that file as the next run's `--baseline`
- `cases.ts` is the table: turn scenes (`user`, `reply`, and the `want`ed asking / continuing / abusive; fields left out
  aren't checked; `lineMustNot`, a pattern the speech bubble line must not match) and concierge scenes (sessions as the
  app's SessionView, and a `check` on the answer). A scene's own `runs` and `minPass` replace `--runs` and `--min-pass`
  when they are stricter, for a misjudgment that comes only now and then. A scene keeps only the shape of a real reply
  that decides the verdict; what the work was about is made up. Never point a scene at a local transcript or log, keep
  new scenes free of anything from another project (names, features, issue numbers, files, amounts, counts, URLs,
  accounts, ids), and have the table checked for privacy by subagents twice before committing it
- `needs-run.ts` finds what the test reaches: every top-level declaration that tools/llm-regression/ uses, followed
  through the TypeScript checker into src/. A change inside one of them, to the test's files, or to
  src-tauri/src/keys.rs (whose URLs, headers, and timeouts `transport.ts` copies; `tests/llm-transport.test.ts` checks
  they match) prints `run` with the reasons; otherwise `not needed`. The base is the merge base with the branch's
  upstream, or origin/main when it has none (or the first argument), so commits not pushed yet count; the working tree
  and untracked files count too
- `run.ts` exits 1 when a scene is NG, when no provider ran, or when a provider in `--baseline` didn't run this time

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
