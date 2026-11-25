// Telling every window of the app that a saved setting changed (docs/design.md "Settings window", Detailed design (b)).
// kvPut / kvDelete (lib/kv.ts) and the API key functions (lib/api-keys.ts) call notifySettingChanged, so a save from any
// window, the menu bar, or an AI agent's tool passes here. Only the key's name is sent, never its value: API keys can be
// in IndexedDB with the webview key store
//
// The Tauri modules are imported when first used: lib/kv.ts is imported by modules the unit tests load with parts of
// @tauri-apps/api mocked, and a static import here failed those tests on exports the mocks don't have

export const SETTINGS_CHANGED = "settings-changed";

/** The key under which API key changes are told (the keys themselves are kept in Rust, not in IndexedDB) */
export const API_KEYS_SETTING = "apiKeys";

export interface SettingsChange {
  key: string;
  /** The label of the window that saved it */
  from: string;
}

let label: Promise<string | null> | undefined;

/** This window's label; null outside the app (the browser mock), where there is no other window to tell */
export function windowLabel(): Promise<string | null> {
  label ??= import("@tauri-apps/api/webviewWindow").then(
    (m) => m.getCurrentWebviewWindow().label,
    () => null,
  ).catch(() => null);
  return label;
}

export function notifySettingChanged(key: string): void {
  void (async () => {
    const from = await windowLabel();
    if (from === null) return;
    const { emit } = await import("@tauri-apps/api/event");
    await emit(SETTINGS_CHANGED, { key, from } satisfies SettingsChange);
  })().catch(() => {});
}

/** Whether this window reloads for the change: one of its keys, saved by another window. The window that saved has
 * already set its own state, and reloading on its own echo could pull a slider back while it is being dragged */
export function wantsReload(change: SettingsChange, keys: readonly string[], self: string | null): boolean {
  return change.from !== self && keys.includes(change.key);
}

/** Calls reload with the key whenever another window saves one of keys. Returns the function that stops listening */
export function onSettingsChanged(keys: readonly string[], reload: (key: string) => void): () => void {
  let stopped = false;
  const unlisten = (async () => {
    const self = await windowLabel();
    if (self === null || stopped) return undefined;
    const { listen } = await import("@tauri-apps/api/event");
    return listen<SettingsChange>(SETTINGS_CHANGED, ({ payload }) => {
      if (wantsReload(payload, keys, self)) reload(payload.key);
    });
  })().catch(() => undefined);
  return () => {
    stopped = true;
    void unlisten.then((f) => f?.());
  };
}
