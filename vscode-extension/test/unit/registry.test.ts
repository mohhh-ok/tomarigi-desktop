import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { entryPath, pidsOf, registryDir, removeEntry, terminalOf, terminalPids, writeEntry } from "../../src/registry";

const term = (pid: number | undefined) => ({ processId: Promise.resolve(pid) });

describe("registry", () => {
  test("the file is named by the uri scheme and the extension host pid under ~/.tomarigi/vscode", () => {
    expect(registryDir("/Users/me")).toBe(path.join("/Users/me", ".tomarigi", "vscode"));
    expect(entryPath("/d", "cursor", 510)).toBe(path.join("/d", "cursor-510.json"));
  });

  test("an entry is written whole and removed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomarigi-ext-"));
    const file = entryPath(path.join(dir, "vscode"), "vscode", 42);
    const entry = { uri: "vscode://mohtech.tomarigi/focus?windowId=1", extensionHostPid: 42, terminalPids: [7, 8] };
    writeEntry(file, entry);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(entry);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["vscode-42.json"]);
    removeEntry(file);
    removeEntry(file);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  test("pids are read from the query and junk is dropped", () => {
    expect(pidsOf("windowId=3&pids=540,530,520")).toEqual([540, 530, 520]);
    expect(pidsOf("pids=1,x,-2,,3.5,9")).toEqual([1, 9]);
    expect(pidsOf("windowId=3")).toEqual([]);
  });

  test("the terminal whose shell is one of the pids is found", async () => {
    const terminals = [term(undefined), term(530), term(531)];
    expect(await terminalOf(terminals, [540, 531])).toBe(terminals[2]);
    expect(await terminalOf(terminals, [999])).toBeUndefined();
    expect(await terminalPids(terminals)).toEqual([530, 531]);
  });
});
