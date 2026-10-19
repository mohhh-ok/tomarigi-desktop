// App updates (docs/design.md "Updates"). The Rust side (src-tauri/src/updater.rs) checks, downloads, and installs;
// this follows its status through the "update-status" event for the settings' update section
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "checkFailed" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  | { kind: "installing"; version: string }
  | { kind: "installFailed"; version: string };

/** ?update=<kind> shows that status instead of the real one (for screenshot checks; TOMARIGI_QUERY in the README).
 * The found version is 0.9.0 and the download is at 40% */
function statusFromQuery(): UpdateStatus | null {
  const kind = new URLSearchParams(location.search).get("update");
  const version = "0.9.0";
  switch (kind) {
    case "idle":
    case "checking":
    case "upToDate":
    case "checkFailed":
      return { kind };
    case "available":
    case "installing":
    case "installFailed":
      return { kind, version };
    case "downloading":
      return { kind, version, downloaded: 4_000_000, total: 10_000_000 };
    default:
      return null;
  }
}

export function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus>(() => statusFromQuery() ?? { kind: "idle" });
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (statusFromQuery()) {
      // The plain browser has no app version to read
      void getVersion().then(setVersion, () => setVersion("0.8.1"));
      return;
    }
    void getVersion().then(setVersion, () => {});
    void invoke<UpdateStatus>("update_status").then(setStatus, () => {});
    const unlisten = listen<UpdateStatus>("update-status", (e) => setStatus(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);
  return {
    status,
    version,
    check: () => void invoke("update_check"),
    install: () => void invoke("update_install"),
  };
}
