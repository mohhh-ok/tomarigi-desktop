// Reads files on the Rust side (fs_list / fs_stat / fs_read in src-tauri/src/lib.rs) instead of the File System Access API.
// The session scan (lib/sessions.ts and its session-*.ts modules, transcript.ts, codex-transcript.ts) was written
// against FileSystemDirectoryHandle / File in the tomarigi Chrome extension, so this provides handles with just the
// methods it uses, in the same shape.
import { invoke } from "@tauri-apps/api/core";

interface RawEntry {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

function notFound(path: string): DOMException {
  // The session scan (lib/codex-rollout.ts, lib/session-chicks.ts) treats a DOMException NotFoundError as
  // "doesn't exist, skip it"
  return new DOMException(`not found: ${path}`, "NotFoundError");
}

function isNotFound(e: unknown): boolean {
  return typeof e === "string" && e.startsWith("NotFound");
}

function join(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Replacement for File. size / lastModified are a snapshot taken at getFile() */
export class NativeFile {
  constructor(
    readonly path: string,
    readonly name: string,
    readonly size: number,
    readonly lastModified: number,
  ) {}

  /** Like Blob.slice, negative values are positions from the end */
  slice(start = 0, end = this.size): { text(): Promise<string> } {
    const norm = (v: number) => Math.min(this.size, Math.max(0, v < 0 ? this.size + v : v));
    const from = norm(start);
    const to = norm(end);
    return {
      text: () =>
        to <= from
          ? Promise.resolve("")
          : invoke<string>("fs_read", { path: this.path, start: from, end: to }),
    };
  }

  text(): Promise<string> {
    return this.slice().text();
  }
}

export class NativeFileHandle {
  readonly kind = "file" as const;
  constructor(
    readonly path: string,
    readonly name: string,
    private readonly preloaded?: RawEntry,
  ) {}

  async getFile(): Promise<NativeFile> {
    const meta = this.preloaded ?? (await stat(this.path));
    return new NativeFile(this.path, this.name, meta.size, meta.mtimeMs);
  }
}

export class NativeDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;
  constructor(readonly path: string) {
    this.name = basename(path);
  }

  async *values(): AsyncGenerator<NativeDirectoryHandle | NativeFileHandle> {
    let entries: RawEntry[];
    try {
      entries = await invoke<RawEntry[]>("fs_list", { path: this.path });
    } catch (e) {
      if (isNotFound(e)) throw notFound(this.path);
      throw e;
    }
    for (const entry of entries) {
      const child = join(this.path, entry.name);
      yield entry.kind === "directory"
        ? new NativeDirectoryHandle(child)
        : new NativeFileHandle(child, entry.name, entry);
    }
  }

  async getDirectoryHandle(name: string): Promise<NativeDirectoryHandle> {
    const child = join(this.path, name);
    const meta = await stat(child);
    if (meta.kind !== "directory") throw notFound(child);
    return new NativeDirectoryHandle(child);
  }

  async getFileHandle(name: string): Promise<NativeFileHandle> {
    const child = join(this.path, name);
    const meta = await stat(child);
    if (meta.kind !== "file") throw notFound(child);
    return new NativeFileHandle(child, name, meta);
  }
}

async function stat(path: string): Promise<RawEntry> {
  try {
    return await invoke<RawEntry>("fs_stat", { path });
  } catch (e) {
    if (isNotFound(e)) throw notFound(path);
    throw e;
  }
}

/** Whether the folder can be read now (replacement for tomarigi's queryPermission) */
export async function isReadableDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).kind === "directory";
  } catch {
    return false;
  }
}
