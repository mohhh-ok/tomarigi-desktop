// Paths separated by "\\" (Windows: the folder picker, cwd in transcripts) and by "/" (macOS / Linux, and the
// home + ".claude/projects" mix Rust returns for default folders on Windows) read the same way
import { describe, expect, test } from "bun:test";
import { basename, isAbsolutePath, parentDir, pathKey, relativeTo, samePath } from "../src/lib/paths.ts";
import { codexDirOf, configDirOf } from "../src/lib/session-liveness.ts";
import type { RootEntry } from "../src/lib/settings-store.ts";
import { relativeLabel } from "../src/perch/watch-links.ts";
import type { SessionView } from "../src/lib/sessions.ts";

const rootAt = (path: string) => ({ path }) as RootEntry;

describe("watched folder → agent folder", () => {
  test("configDirOf: macOS path as saved by earlier versions", () => {
    expect(configDirOf(rootAt("/Users/x/.claude/projects"))).toBe("/Users/x/.claude");
    expect(configDirOf(rootAt("/Users/x/.claude/projects/"))).toBe("/Users/x/.claude");
  });

  test("configDirOf: Windows path from the folder picker", () => {
    expect(configDirOf(rootAt("C:\\Users\\x\\.claude\\projects"))).toBe("C:\\Users\\x\\.claude");
    expect(configDirOf(rootAt("C:\\Users\\x\\.claude\\projects\\"))).toBe("C:\\Users\\x\\.claude");
  });

  test("configDirOf: Windows default folder (home joined with a / path)", () => {
    expect(configDirOf(rootAt("C:\\Users\\x\\.claude/projects"))).toBe("C:\\Users\\x\\.claude");
  });

  test("codexDirOf: sessions folder or the codex folder itself", () => {
    expect(codexDirOf(rootAt("/Users/x/.codex/sessions"))).toBe("/Users/x/.codex");
    expect(codexDirOf(rootAt("/Users/x/.codex/"))).toBe("/Users/x/.codex");
    expect(codexDirOf(rootAt("C:\\Users\\x\\.codex\\sessions"))).toBe("C:\\Users\\x\\.codex");
    expect(codexDirOf(rootAt("C:\\Users\\x\\.codex\\sessions\\"))).toBe("C:\\Users\\x\\.codex");
    expect(codexDirOf(rootAt("C:\\Users\\x\\.codex\\"))).toBe("C:\\Users\\x\\.codex");
    expect(codexDirOf(rootAt("C:\\Users\\x\\my-sessions"))).toBe("C:\\Users\\x\\my-sessions");
  });
});

describe("paths", () => {
  test("samePath: the picker's path matches the default folder of the same place (duplicate check)", () => {
    expect(samePath("C:\\Users\\x\\.claude\\projects", "C:\\Users\\x\\.claude/projects")).toBe(true);
    expect(samePath("C:\\Users\\x\\.claude\\projects\\", "C:\\Users\\x\\.claude\\projects")).toBe(true);
    expect(samePath("/Users/x/.claude/projects/", "/Users/x/.claude/projects")).toBe(true);
    expect(samePath("/Users/x/.claude/projects", "/Users/x/.claude/projects2")).toBe(false);
    expect(pathKey("C:\\a\\b\\")).toBe("C:/a/b");
  });

  test("basename / parentDir", () => {
    expect(basename("C:\\Users\\x\\Dev\\app")).toBe("app");
    expect(basename("/Users/x/Dev/app/")).toBe("app");
    expect(basename("/")).toBe("/");
    expect(parentDir("C:\\Users\\x\\Dev\\app\\")).toBe("C:\\Users\\x\\Dev");
    expect(parentDir("app")).toBe("app");
  });

  test("isAbsolutePath", () => {
    expect(isAbsolutePath("/Users/x")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\x")).toBe(true);
    expect(isAbsolutePath("c:/Users/x")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("Users\\x")).toBe(false);
    expect(isAbsolutePath("C:")).toBe(false);
  });

  test("relativeTo", () => {
    expect(relativeTo("C:\\Dev\\app", "C:\\Dev\\app\\packages\\web")).toBe("packages\\web");
    expect(relativeTo("/Dev/app", "/Dev/app/web")).toBe("web");
    expect(relativeTo("/Dev/app", "/Dev/app2")).toBeUndefined();
    expect(relativeTo("/Dev/app", "/Dev/app")).toBeUndefined();
  });
});

describe("relativeLabel with Windows working folders", () => {
  const view = (cwd: string, project: string) => ({ cwd, project }) as SessionView;
  test("same folder shows no name, a sub folder shows the relative path, elsewhere the folder name", () => {
    const parent = view("C:\\Dev\\app", "app");
    expect(relativeLabel(parent, view("C:\\Dev\\app\\", "app"))).toBeUndefined();
    expect(relativeLabel(parent, view("C:\\Dev\\app\\web", "web"))).toBe("web");
    expect(relativeLabel(parent, view("C:\\Dev\\other", "other"))).toBe("other");
  });
});
