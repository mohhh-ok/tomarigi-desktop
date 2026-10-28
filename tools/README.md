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
