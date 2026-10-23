import { type RootEntry } from "@/lib/settings-store";
import { scanSessions, type ScanResult, type SessionView } from "@/lib/sessions";
import type { ConciergeAdvice } from "@/lib/concierge";
import type { ShownSuggestion } from "@/lib/concierge-status";

/**
 * Abstraction of the data source App.tsx uses. The boundary for injecting real data (scanning roots via FileSystemAccess) and
 * mock data (mock.tsx) into App.tsx in the same shape.
 * Introduced so that with ?mock=1 we stop maintaining a separate component that duplicates the real App.tsx shell,
 * and instead run App.tsx itself with a swapped source (one source of truth for the shell).
 */
export interface PerchSource {
  /** Whether to use the roots/permission subsystem. If false, the setup screen, watched folder settings, and
   * permission checks are all skipped (for mock) */
  usesRoots: boolean;
  /** For a source that doesn't scan folders (mock): watched folders shown in settings only, so the folder list and
   * the add-folder dialog can be checked in a browser. Nothing is read from them, saved, or picked */
  displayRoots?: RootEntry[];
  scan(granted: RootEntry[]): Promise<ScanResult>;
  /** For sources that want data changes reflected immediately (mock). Call it to rescan without waiting for
   * App.tsx's polling (3 seconds). Returns unsubscribe. Left undefined because real doesn't use it */
  subscribe?(onChange: () => void): () => void;
  /** For a source that doesn't call the API (mock): the concierge's advice for these sessions, or undefined to ask the
   * real concierge. Left undefined because real doesn't use it */
  conciergeAdvice?(sessions: SessionView[]): ConciergeAdvice | null | undefined;
  /** The same for the suggestions of "Concierge only", or undefined to take them from the real concierge */
  conciergeSuggestions?(sessions: SessionView[]): ShownSuggestion[] | undefined;
  /** For a source with no terminal panes (mock, ?focusable=1): every session can be clicked and a click is only
   * logged, so how clickable things look can be checked in a browser. Left undefined because real doesn't use it */
  focusLogOnly?: boolean;
}

export const realSource: PerchSource = {
  usesRoots: true,
  scan: (granted) => scanSessions(granted),
};
