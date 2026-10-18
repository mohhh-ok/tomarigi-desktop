// Splitting and comparing paths. Both "/" and "\\" are separators: on Windows the folder picker and the working
// folders in transcripts use "\\", and Rust's default folders mix the two (home "C:\\Users\\x" + ".claude/projects").
// Rust accepts either on Windows, so paths are passed on as they are and only read through these helpers

const TRAILING_SEPARATORS = /[\\/]+$/;

/** The path without trailing separators */
export function trimSeparators(path: string): string {
  return path.replace(TRAILING_SEPARATORS, "");
}

/** The form two paths are compared in: trailing separators dropped and "\\" read as "/" */
export function pathKey(path: string): string {
  return trimSeparators(path).replaceAll("\\", "/");
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Whether a path is absolute: "/…" or, on Windows, "C:\…", "C:/…" or "\\server\…" */
export function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** The folder a path is in (trailing separators ignored). A path with no separator is returned as is */
export function parentDir(path: string): string {
  const trimmed = trimSeparators(path);
  const idx = lastSeparator(trimmed);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

/**
 * The last segment of a path (trailing separators ignored).
 * Inputs whose segment would be empty (e.g. "/") are returned as is.
 */
export function basename(path: string): string {
  const trimmed = trimSeparators(path);
  return trimmed.slice(lastSeparator(trimmed) + 1) || path;
}

/** The path of `path` relative to `base` (with path's own separators) if it is under base and not base itself */
export function relativeTo(base: string, path: string): string | undefined {
  const b = pathKey(base);
  // pathKey only drops trailing separators and swaps "\\" for "/", so its indices match the trimmed path
  return b && pathKey(path).startsWith(`${b}/`) ? trimSeparators(path).slice(b.length + 1) : undefined;
}
