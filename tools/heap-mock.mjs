// Runs the mock screen in headless Chromium with updates sped up, and compares JS heap snapshots taken early and late,
// to find what piles up in the page (issue #8). See tools/README.md.
//   PLAYWRIGHT=/tmp/pw/node_modules/playwright node tools/heap-mock.mjs
// BROWSER=webkit runs Playwright's WebKit instead: it has no heap snapshots, so it only drives the page; measure its web
// process with tools/webview-mem.sh (the pid is printed at the start).
// Env: MINUTES (default 10), QUERY (the mock's query, default the Concierge tab with ?cycle), TABS=1 switches tabs every
// TAB_SECONDS (default 5), OUT (default /tmp/tomarigi-desktop/heap-mock). Needs the dev server at 4842 (`bun run dev:web`
// or `bun run dev`).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pw = await import(join(process.env.PLAYWRIGHT ?? "playwright", "index.mjs"));
const WEBKIT = process.env.BROWSER === "webkit";
const MINUTES = Number(process.env.MINUTES ?? 10);
const QUERY = process.env.QUERY ?? "mock=1&panel=0&preset=mix&tab=concierge&concierge=&cycle=0.5";
const TABS = process.env.TABS === "1";
const TAB_SECONDS = Number(process.env.TAB_SECONDS ?? 5);
// RESIZE=1 flips the viewport between two heights every RESIZE_MS (default 500), as the Concierge tab's window fit does
const RESIZE = process.env.RESIZE === "1";
const RESIZE_MS = Number(process.env.RESIZE_MS ?? 500);
const OUT = process.env.OUT ?? "/tmp/tomarigi-desktop/heap-mock";
mkdirSync(OUT, { recursive: true });

const webPids = () =>
  new Set(
    execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes("ms-playwright/webkit") && l.includes("WebContent"))
      .map((l) => l.trim().split(" ")[0]),
  );
const before = WEBKIT ? webPids() : new Set();
const browser = await (WEBKIT ? pw.webkit : pw.chromium).launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 480, height: 600 } });
const cdp = WEBKIT ? undefined : await page.context().newCDPSession(page);
await cdp?.send("HeapProfiler.enable");
await page.goto(`http://localhost:4842/?${QUERY}`);
await page.waitForTimeout(5_000);
if (WEBKIT) console.log(`webkit web process: ${[...webPids()].filter((p) => !before.has(p)).join(" ")}`);

async function sample() {
  if (WEBKIT) return { nodes: await page.evaluate(() => document.getElementsByTagName("*").length) };
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  const dom = await cdp.send("Memory.getDOMCounters");
  return { usedKB: Math.round(heap.usedSize / 1024), ...dom };
}

/** Self size and count per node type and name, from a heap snapshot */
async function snapshot(file) {
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  const text = chunks.join("");
  writeFileSync(join(OUT, file), text);
  const snap = JSON.parse(text);
  const fields = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const [iType, iName, iSize] = ["type", "name", "self_size"].map((f) => fields.indexOf(f));
  const groups = new Map();
  for (let i = 0; i < snap.nodes.length; i += fields.length) {
    const type = types[snap.nodes[i + iType]];
    const raw = snap.strings[snap.nodes[i + iName]];
    // Strings and code are grouped by type only; their names are their contents
    const name = type === "object" || type === "native" || type === "closure" ? raw.slice(0, 80) : `(${type})`;
    const g = groups.get(name) ?? { count: 0, size: 0 };
    g.count++;
    g.size += snap.nodes[i + iSize];
    groups.set(name, g);
  }
  return groups;
}

const log = (line) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);
log(`start ${JSON.stringify(await sample())}`);
const first = WEBKIT ? undefined : await snapshot("first.heapsnapshot");

const tabs = ["concierge", "garden", "perch", "events"];
let t = 0;
const tabTimer = TABS
  ? setInterval(() => {
      t++;
      page.click(`#tab-btn-${tabs[t % tabs.length]}`).catch((e) => log(`tab click failed: ${e.message}`));
    }, TAB_SECONDS * 1000)
  : undefined;
let flip = false;
const resizeTimer = RESIZE
  ? setInterval(() => {
      flip = !flip;
      page.setViewportSize({ width: 260, height: flip ? 378 : 350 }).catch((e) => log(`resize failed: ${e.message}`));
    }, RESIZE_MS)
  : undefined;
for (let m = 1; m <= MINUTES; m++) {
  await page.waitForTimeout(60_000);
  log(`minute ${m} ${JSON.stringify(await sample())}`);
}
if (tabTimer) clearInterval(tabTimer);
if (resizeTimer) clearInterval(resizeTimer);
if (TABS) await page.click("#tab-btn-concierge").catch(() => {});
await page.waitForTimeout(2_000);
if (WEBKIT) {
  await browser.close();
  process.exit(0);
}
const last = await snapshot("last.heapsnapshot");
await browser.close();

const rows = [...last]
  .map(([name, g]) => {
    const f = first.get(name) ?? { count: 0, size: 0 };
    return { name, count: g.count - f.count, sizeKB: Math.round((g.size - f.size) / 1024), lastCount: g.count };
  })
  .filter((r) => r.count > 0 || r.sizeKB > 0)
  .sort((a, b) => b.sizeKB - a.sizeKB || b.count - a.count)
  .slice(0, 40);
log("growth between the first and last snapshot (count, KB, count at the end):");
for (const r of rows) console.log(`  ${String(r.count).padStart(7)} ${String(r.sizeKB).padStart(7)} KB ${String(r.lastCount).padStart(7)}  ${r.name}`);
