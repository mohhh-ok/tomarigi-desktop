import { type RootEntry } from "@/lib/fsa";
import { scanSessions, type ScanResult } from "@/lib/sessions";

/**
 * Abstraction of the data source App.tsx uses. The boundary for injecting real data (scanning roots via FileSystemAccess) and
 * mock data (entrypoints/perch/mock.tsx) into App.tsx in the same shape.
 * Introduced so that with ?mock=1 we stop maintaining a separate component that duplicates the real App.tsx shell,
 * and instead run App.tsx itself with a swapped source (one source of truth for the shell).
 */
export interface PerchSource {
  /** Whether to use the roots/permission subsystem. If false, the setup screen, watched folder settings, and
   * permission checks are all skipped (for mock) */
  usesRoots: boolean;
  scan(granted: RootEntry[]): Promise<ScanResult>;
  /** For sources that want data changes reflected immediately (mock). Call it to rescan without waiting for
   * App.tsx's polling (3 seconds). Returns unsubscribe. Left undefined because real doesn't use it */
  subscribe?(onChange: () => void): () => void;
}

export const realSource: PerchSource = {
  usesRoots: true,
  scan: (granted) => scanSessions(granted),
};
