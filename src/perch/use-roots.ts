import { useCallback, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { isReadableDir } from "@/lib/native-fs";
import {
  checkNewRoot,
  checkRootLabel,
  checkRootRemovable,
  checkTypedRootPath,
  type SettingsProblem,
} from "@/lib/settings-checks";
import {
  loadRoots,
  newRoot,
  pickNewRoot,
  queryRead,
  saveRoots,
  type RootEntry,
  type RootKind,
} from "@/lib/settings-store";
import type { PerchSource } from "./source";

/** The watched folders: their state, read permission, and the operations the settings screen and the AI agent's tools
 * share (docs/design.md "Watched folders", "Settings by an AI agent (MCP)"). Each operation reads the latest list from
 * a ref, so two calls in a row (the agent's) don't work on a stale copy */
export function useRoots(source: PerchSource) {
  const [roots, setRootsState] = useState<RootEntry[]>([]);
  const [perms, setPerms] = useState<Record<string, PermissionState>>({});
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const rootsRef = useRef<RootEntry[]>([]);

  const setRoots = useCallback((next: RootEntry[]) => {
    rootsRef.current = next;
    setRootsState(next);
  }, []);

  /** At startup. The mock source (source.usesRoots === false) doesn't use the roots/perms subsystem; it shows its fixed
   * folders (source.displayRoots) when it has them */
  const loadAll = useCallback(async () => {
    if (source.usesRoots) {
      const loaded = await loadRoots();
      setRoots(loaded);
      const entries = await Promise.all(loaded.map(async (r) => [r.id, await queryRead(r)] as const));
      setPerms(Object.fromEntries(entries));
    } else if (source.displayRoots) {
      setRoots(source.displayRoots);
      setPerms(Object.fromEntries(source.displayRoots.map((r) => [r.id, "granted" as const])));
    }
  }, [source, setRoots]);

  /** So that state and persistence don't silently diverge on failure, it warns and shows a message on screen */
  const persist = useCallback(
    async (next: RootEntry[]) => {
      // Folders shown by mock are not saved
      if (!source.usesRoots) return;
      try {
        await saveRoots(next);
      } catch (e) {
        console.warn("[tomarigi] failed to save", e);
        setAddMessage(t("saveFailedMessage"));
      }
    },
    [source],
  );

  const append = useCallback(
    async (root: RootEntry) => {
      const next = [...rootsRef.current, root];
      setRoots(next);
      await persist(next);
      const perm = await queryRead(root);
      setPerms((prev) => ({ ...prev, [root.id]: perm }));
    },
    [persist, setRoots],
  );

  /** From the settings screen: the folder picker */
  const addRoot = useCallback(
    async (kind: RootKind) => {
      // mock has no folder picker
      if (!source.usesRoots) return;
      const result = await pickNewRoot(rootsRef.current, kind);
      if (result === "cancelled") return;
      if (result === "duplicate") {
        setAddMessage(t("duplicateRootMessage"));
        return;
      }
      setAddMessage(null);
      await append(result);
    },
    [source, append],
  );

  /** From the AI agent: a path it gives, through the same check as the picker's (plus absolute and readable, which the
   * picker guarantees) */
  const addRootAt = useCallback(
    async (kind: RootKind, path: string, label?: string): Promise<SettingsProblem | RootEntry> => {
      const trimmed = path.trim();
      // The file system is read only once the path passes the other rules
      const problem = checkTypedRootPath(trimmed) ?? checkNewRoot(rootsRef.current, trimmed);
      if (problem) return problem;
      if (!(await isReadableDir(trimmed))) return "not-readable";
      const root = newRoot(rootsRef.current, kind, trimmed, label);
      await append(root);
      return root;
    },
    [append],
  );

  const removeRoot = useCallback(
    async (id: string): Promise<SettingsProblem | undefined> => {
      const root = rootsRef.current.find((r) => r.id === id);
      if (!root) return undefined;
      const problem = checkRootRemovable(root);
      if (problem) return problem;
      const next = rootsRef.current.filter((r) => r.id !== id);
      setRoots(next);
      await persist(next);
      setPerms((prev) => {
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
      return undefined;
    },
    [persist, setRoots],
  );

  const renameRoot = useCallback(
    async (id: string, label: string): Promise<SettingsProblem | undefined> => {
      const problem = checkRootLabel(label);
      if (problem) return problem;
      const next = rootsRef.current.map((r) => (r.id === id ? { ...r, label: label.trim() } : r));
      setRoots(next);
      await persist(next);
      return undefined;
    },
    [persist, setRoots],
  );

  return { roots, rootsRef, perms, addMessage, loadAll, addRoot, addRootAt, removeRoot, renameRoot };
}
