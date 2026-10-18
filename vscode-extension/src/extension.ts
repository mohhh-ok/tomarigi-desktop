// Tomarigi's VS Code extension (docs/design.md "Jumping to the terminal pane", VS Code / Cursor).
// Each window writes its own window-addressed URI and its terminals' pids for Tomarigi, and handles that URI by
// showing the terminal whose shell is one of the pids. A plain URI would reach only the topmost window, which is why
// Tomarigi opens the URI of the window that has the terminal
import * as path from "node:path";
import * as vscode from "vscode";
import { entryPath, pidsOf, registryDir, removeEntry, removeStaleEntries, terminalOf, terminalPids, writeEntry, writeLastFocus } from "./registry";

let file: string | undefined;
/** Set by deactivate so a write still waiting on processId doesn't bring the file back */
let closed = false;

const handler: vscode.UriHandler = {
  async handleUri(uri) {
    if (uri.path !== "/focus") return;
    const pids = pidsOf(uri.query);
    const terminal = await terminalOf(vscode.window.terminals, pids);
    // The editor brings this window to the front after a URI is handled
    terminal?.show(false);
    // The last URI handled, for checking where a jump went
    const shown = terminal ? await terminal.processId : undefined;
    writeLastFocus(
      path.join(registryDir(), "last-focus.log"),
      `${new Date().toISOString()} window=${vscode.workspace.name ?? "-"} uri=${uri.toString(true)} pids=${pids.join(",")} shown=${shown ?? "none"}\n`,
    );
  },
};

/** Returned to the integration tests, which can't route a URI through the OS */
export interface Api {
  handler: vscode.UriHandler;
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
  context.subscriptions.push(vscode.window.registerUriHandler(handler));

  const own = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}/focus`));
  removeStaleEntries(registryDir());
  const entryFile = entryPath(registryDir(), vscode.env.uriScheme, process.pid);
  file = entryFile;
  // Writes run one after another so a slow processId can't overwrite a newer list
  let queue = Promise.resolve();
  const update = () => {
    queue = queue
      .then(async () => {
        const pids = await terminalPids(vscode.window.terminals);
        if (closed) return;
        writeEntry(entryFile, { uri: own.toString(true), extensionHostPid: process.pid, terminalPids: pids });
      })
      .catch((e) => console.error("[tomarigi] could not write", entryFile, e));
  };
  update();
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(update),
    vscode.window.onDidCloseTerminal(update),
  );
  return { handler };
}

export function deactivate(): void {
  closed = true;
  if (file) removeEntry(file);
}
