# tools

Tools for checking the app's behavior by hand or from an agent. Not part of the build.

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
server at 4842 (`bun run dev:web` or `bun run dev`) and Playwright, which isn't a dependency of this repo. Install it as
the header of scripts/gallery/shoot.mjs says; for `BROWSER=webkit`, also run `bunx playwright install webkit` in /tmp/pw.

```sh
# Chromium: JS heap snapshots at the start and the end, and the objects that grew between them
MINUTES=10 PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/heap-mock.mjs
# WebKit (what the app runs on): no heap snapshots, so it prints its web process pid; measure it with webview-mem.sh
BROWSER=webkit RESIZE=1 MINUTES=12 PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/heap-mock.mjs
```

Env: `QUERY` (the mock's query; default the Concierge tab with `cycle=0.5`), `TABS=1` (switch tabs every `TAB_SECONDS`),
`RESIZE=1` (flip the viewport between 260×350 and 260×378 every `RESIZE_MS`, as the Concierge tab's window fit does),
`OUT` (where the snapshots go; default /tmp/tomarigi-desktop/heap-mock).
