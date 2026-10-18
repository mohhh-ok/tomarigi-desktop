// Runs inside VS Code (test/integration/run.ts)
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";
import type { Api } from "../../src/extension";
import type { WindowEntry } from "../../src/registry";

const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"));

async function until<T>(get: () => T | undefined, what: string, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function entry(): WindowEntry | undefined {
  const dir = path.join(process.env.TOMARIGI_TEST_HOME!, ".tomarigi", "vscode");
  const name = `${vscode.env.uriScheme}-${process.pid}.json`;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  } catch {
    return undefined;
  }
}

function tests(): void {
  let api: Api;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<Api>(`${PKG.publisher}.${PKG.name}`);
    assert.ok(ext, "extension is loaded");
    api = await ext.activate();
  });

  test("the window file lists the terminals and a URI addressed to this window", async () => {
    const terminal = vscode.window.createTerminal("tomarigi-a");
    const pid = await terminal.processId;
    assert.ok(pid, "terminal has a shell");
    const e = await until(() => {
      const e = entry();
      return e?.terminalPids.includes(pid) ? e : undefined;
    }, "the terminal pid in the window file");
    assert.strictEqual(e.extensionHostPid, process.pid);
    assert.match(e.uri, new RegExp(`^${vscode.env.uriScheme}://${PKG.publisher}\\.${PKG.name}/focus\\?windowId=\\d+$`));
    terminal.dispose();
    await until(() => (entry()?.terminalPids.includes(pid) ? undefined : true), "the closed terminal to leave the file");
  });

  test("the URI shows the terminal whose shell is one of the pids", async () => {
    const a = vscode.window.createTerminal("tomarigi-a");
    const b = vscode.window.createTerminal("tomarigi-b");
    const [pa, pb] = await Promise.all([a.processId, b.processId]);
    a.show(false);
    await until(() => (vscode.window.activeTerminal === a ? true : undefined), "terminal a to be active");
    await api.handler.handleUri(vscode.Uri.parse(`${vscode.env.uriScheme}://x/focus?windowId=1&pids=999999,${pb}`));
    await until(() => (vscode.window.activeTerminal === b ? true : undefined), "terminal b to be shown");
    await api.handler.handleUri(vscode.Uri.parse(`${vscode.env.uriScheme}://x/focus?pids=${pa}`));
    await until(() => (vscode.window.activeTerminal === a ? true : undefined), "terminal a to be shown");
    a.dispose();
    b.dispose();
  });
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 30000 });
  mocha.suite.emit("pre-require", globalThis, "suite", mocha);
  tests();
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
}
