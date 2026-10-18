// Tomarigi's VS Code extension (docs/design.md "Jumping to the terminal pane", VS Code / Cursor).
// Each window writes its own window-addressed URI and its terminals' pids for Tomarigi, and handles that URI by
// showing the terminal whose shell is one of the pids. A plain URI would reach only the topmost window, which is why
// Tomarigi opens the URI of the window that has the terminal
import * as vscode from "vscode";
import { entryPath, pidsOf, registryDir, removeEntry, terminalOf, terminalPids, writeEntry } from "./registry";

let file: string | undefined;

const handler: vscode.UriHandler = {
  async handleUri(uri) {
    if (uri.path !== "/focus") return;
    const terminal = await terminalOf(vscode.window.terminals, pidsOf(uri.query));
    // The editor brings this window to the front after a URI is handled
    terminal?.show(false);
  },
};

/** Returned to the integration tests, which can't route a URI through the OS */
export interface Api {
  handler: vscode.UriHandler;
}

export async function activate(context: vscode.ExtensionContext): Promise<Api> {
  context.subscriptions.push(vscode.window.registerUriHandler(handler));

  const own = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://${context.extension.id}/focus`));
  const path = entryPath(registryDir(), vscode.env.uriScheme, process.pid);
  file = path;
  // Writes run one after another so a slow processId can't overwrite a newer list
  let queue = Promise.resolve();
  const update = () => {
    queue = queue
      .then(async () => {
        writeEntry(path, {
          uri: own.toString(true),
          extensionHostPid: process.pid,
          terminalPids: await terminalPids(vscode.window.terminals),
        });
      })
      .catch((e) => console.error("[tomarigi] could not write", path, e));
  };
  update();
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(update),
    vscode.window.onDidCloseTerminal(update),
  );
  return { handler };
}

export function deactivate(): void {
  if (file) removeEntry(file);
}
