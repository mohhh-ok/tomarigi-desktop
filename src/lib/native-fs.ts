// File System Access API の代わりに Rust 側(src-tauri/src/lib.rs の fs_list / fs_stat / fs_read)で
// ファイルを読む。lib/sessions.ts・transcript.ts・codex-transcript.ts は tomarigi(Chrome 拡張)の
// FileSystemDirectoryHandle / File を前提に書かれているので、使っているメソッドだけを同じ形で
// 持つ handle を用意して差し替える(走査・状態判定のロジックは tomarigi のまま動かす)。
import { invoke } from "@tauri-apps/api/core";

interface RawEntry {
  name: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
}

function notFound(path: string): DOMException {
  // sessions.ts は DOMException の NotFoundError を「無いので飛ばす」として扱う
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

/** File の代わり。size / lastModified は getFile() 時点のスナップショット */
export class NativeFile {
  constructor(
    readonly path: string,
    readonly name: string,
    readonly size: number,
    readonly lastModified: number,
  ) {}

  /** Blob.slice と同じく負の値は末尾からの位置として扱う */
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

/** フォルダが今読めるか(tomarigi の queryPermission の代わり) */
export async function isReadableDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).kind === "directory";
  } catch {
    return false;
  }
}
