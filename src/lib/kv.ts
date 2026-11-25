// The app's one key-value store: the "tomarigi" IndexedDB, store "kv", shared by every window of the app (they load the
// same origin). Every write goes through kvPut / kvDelete, which tell the other windows (lib/settings-sync.ts)
import { openDB, type IDBPDatabase } from "idb";
import { notifySettingChanged } from "./settings-sync";

const DB_NAME = "tomarigi";
const STORE = "kv";

function db(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  });
}

export async function kvGet(key: string): Promise<unknown> {
  return (await db()).get(STORE, key);
}

export async function kvPut(key: string, value: unknown): Promise<void> {
  await (await db()).put(STORE, value, key);
  notifySettingChanged(key);
}

export async function kvDelete(key: string): Promise<void> {
  await (await db()).delete(STORE, key);
  notifySettingChanged(key);
}
