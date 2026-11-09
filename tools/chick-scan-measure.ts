// Runs the app's own scanChicks (src/lib/session-chicks.ts) on a real parent transcript and its subagents/ folder, and
// prints each chick's state, the time of the first scan and of a second one (incremental), and the peak RSS.
// Files are read through stand-ins of NativeFile / NativeDirectoryHandle backed by node:fs instead of Tauri's fs_read.
// Usage: bun tools/chick-scan-measure.ts <path to the parent's .jsonl>
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NativeDirectoryHandle, NativeFile } from "../src/lib/native-fs.ts";
import { scanChicks } from "../src/lib/session-chicks.ts";

function fileAt(path: string): NativeFile {
  const st = statSync(path);
  const size = st.size;
  const read = (start: number, end: number) => {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, end - start, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  };
  const norm = (v: number) => Math.min(size, Math.max(0, v < 0 ? size + v : v));
  return {
    path,
    name: basename(path),
    size,
    lastModified: st.mtimeMs,
    slice: (start = 0, end = size) => ({
      text: async () => (norm(end) <= norm(start) ? "" : read(norm(start), norm(end))),
    }),
    text: async () => readFileSync(path, "utf8"),
  } as unknown as NativeFile;
}

function notFound(path: string) {
  return new DOMException(path, "NotFoundError");
}

function dirAt(path: string): NativeDirectoryHandle {
  return {
    kind: "directory",
    name: basename(path),
    path,
    async *values() {
      for (const e of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, e.name);
        yield e.isDirectory() ? dirAt(child) : { kind: "file", name: e.name, getFile: async () => fileAt(child) };
      }
    },
    async getDirectoryHandle(name: string) {
      const child = join(path, name);
      try {
        if (!statSync(child).isDirectory()) throw notFound(child);
      } catch {
        throw notFound(child);
      }
      return dirAt(child);
    },
    async getFileHandle(name: string) {
      const child = join(path, name);
      try {
        statSync(child);
      } catch {
        throw notFound(child);
      }
      return { kind: "file", name, getFile: async () => fileAt(child) };
    },
  } as unknown as NativeDirectoryHandle;
}

const parentPath = process.argv[2];
if (!parentPath) {
  console.error("usage: bun tools/chick-scan-measure.ts <parent .jsonl>");
  process.exit(2);
}
const projectDir = dirAt(dirname(parentPath));
const fileName = basename(parentPath);
const parentId = `measure/${fileName}`;

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
console.log(`rss before: ${mb(peakRss)}`);

for (const label of ["first", "second"]) {
  const t = performance.now();
  const chicks = await scanChicks(projectDir, fileName, parentId, Date.now(), new Map(), fileAt(parentPath));
  const ms = performance.now() - t;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const byState = new Map<string, number>();
  for (const c of chicks) byState.set(c.view.state, (byState.get(c.view.state) ?? 0) + 1);
  console.log(`${label} scan: ${ms.toFixed(0)}ms, ${chicks.length} chicks, ${[...byState].map(([s, n]) => `${s}=${n}`).join(" ")}, peak rss ${mb(peakRss)}`);
  if (label === "first") {
    for (const c of chicks) if (c.view.state === "working") console.log(`  working: ${c.view.id.split("/").pop()} ${c.view.name}`);
  }
}
clearInterval(sampler);
