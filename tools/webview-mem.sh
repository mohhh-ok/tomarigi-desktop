#!/bin/sh
# Records the memory of one process (the app's WebKit WebContent process) with a timestamp, one line per sample.
# Usage: tools/webview-mem.sh <pid> [interval seconds = 60] [samples = 10]
# Columns: time, footprint (KB), "WebKit malloc" dirty (as footprint prints it), RSS (KB)
# Finding the pid: see tools/README.md
pid=$1
interval=${2:-60}
count=${3:-10}
[ -n "$pid" ] || { echo "usage: $0 <pid> [interval] [count]" >&2; exit 2; }
echo "time footprint_kb webkit_malloc rss_kb"
i=0
while [ "$i" -lt "$count" ]; do
  if ! kill -0 "$pid" 2>/dev/null; then echo "$(date +%H:%M:%S) pid $pid is gone"; exit 1; fi
  fp=$(footprint -f bytes --noCategories "$pid" 2>&1 | sed -n 's/.*Footprint: \([0-9]*\) B.*/\1/p')
  wm=$(footprint "$pid" 2>&1 | awk '/WebKit malloc$/ {print $1 $2; exit}')
  rss=$(ps -o rss= -p "$pid" | tr -d ' ')
  echo "$(date +%H:%M:%S) $((fp / 1024)) ${wm:-?} $rss"
  i=$((i + 1))
  [ "$i" -lt "$count" ] && sleep "$interval"
done
