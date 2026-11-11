// The Concierge tab (docs/design.md "Concierge"): only the concierge bird and its bubble. The Garden's birds are only
// hidden: the Garden keeps them as they were (garden.tsx, paused) while ConciergeTabView shows the concierge. In the
// floating window the window shrinks to the concierge (concierge_only_fit in src-tauri/src/garden_grow.rs) and goes back
// to its exact frame from before when the tab is left (concierge_only_end)
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { SessionView } from "@/lib/sessions";
import { waitsOnDeveloper } from "@/lib/turn-verdict";

/** How many other birds there are, and how many of them need a reply (the same "needs reply" as their status lines) */
export function conciergeTabCounts(sessions: SessionView[]): { others: number; waiting: number } {
  return {
    others: sessions.length,
    waiting: sessions.filter(waitsOnDeveloper).length,
  };
}

/** The label right under the handle: which tab this is (badge), with the other birds and how many of them need a reply */
export function conciergeTabLabel({ others, waiting }: { others: number; waiting: number }): {
  badge: string;
  counts: string;
} {
  const counts = t("conciergeOnlyHidden", String(others));
  return {
    badge: t("conciergeName"),
    counts: waiting > 0 ? counts + t("conciergeOnlyWaiting", String(waiting)) : counts,
  };
}

/** The tabs in the tab row, in order: Concierge first, always shown, with or without a provider (docs/design.md
    "Concierge"; without one the tab says what is needed) */
export const TABS = ["concierge", "garden", "perch", "events"] as const;
export type Tab = (typeof TABS)[number];

export function tabsShown(): readonly Tab[] {
  return TABS;
}

/**
 * What the Concierge tab shows (docs/design.md "Concierge"):
 * - "setup": no provider (no OpenAI / Anthropic key saved, Local not set up): the concierge with a bubble saying what it
 *   needs, that the other tabs work without a key, and a button to the settings' AI section. It doesn't depend on the
 *   sessions, since the concierge has nothing to say about them either way (Claude's own decision)
 * - "empty": a provider but no session on screen: the Garden's empty message
 * - "report": the concierge with the state lines and its suggestions
 */
export type ConciergeTabContent = "setup" | "empty" | "report";

export function conciergeTabContent({ available, sessions }: { available: boolean; sessions: number }): ConciergeTabContent {
  if (!available) return "setup";
  return sessions > 0 ? "report" : "empty";
}

/** Whether the concierge asks for suggestions, and so whether the Concierge tab's readout takes done and needs reply
    (concierge-readout.ts): only with the tab open and a provider. Without a provider the tab has no suggestions, and
    the readout is the per-session one, as outside the tab */
export function conciergeWantsSuggestions({ tab, available }: { tab: Tab; available: boolean }): boolean {
  return tab === "concierge" && available;
}

/** A saved tab, or undefined when what was saved isn't one */
export function tabOf(value: unknown): Tab | undefined {
  return TABS.find((tab) => tab === value);
}

/** What the window needs to be (CSS px): its room around the garden plus what the concierge and its bubble need, and
    at least as wide as the handle's row */
export function conciergeTabWindowSize(m: {
  innerW: number;
  innerH: number;
  gardenW: number;
  gardenH: number;
  contentW: number;
  contentH: number;
  handleW: number;
}): { width: number; height: number } {
  return {
    width: Math.ceil(Math.max(m.innerW - m.gardenW + m.contentW, m.handleW)),
    height: Math.ceil(m.innerH - m.gardenH + m.contentH),
  };
}

// How long to wait for the window to be back at its frame from before, before the birds are shown again anyway
const RESTORE_WAIT_MS = 1000;

/** Waits until the window's inner size is `size` (the restored frame), or the wait times out */
function waitForSize(size: { width: number; height: number }): Promise<void> {
  const at = () => Math.abs(window.innerWidth - size.width) <= 1 && Math.abs(window.innerHeight - size.height) <= 1;
  return new Promise((resolve) => {
    if (at()) return resolve();
    const done = () => {
      window.removeEventListener("resize", check);
      clearTimeout(timer);
      // One frame more, so the Garden measures the new size, not the one before it
      requestAnimationFrame(() => resolve());
    };
    const check = () => at() && done();
    const timer = setTimeout(done, RESTORE_WAIT_MS);
    window.addEventListener("resize", check);
  });
}

/**
 * open: the Concierge tab is open. canShrink: the floating window shows it with nothing over it (settings, the debug
 * log), where the window shrinks to the concierge.
 * Returns view (show ConciergeTabView in place of the birds: open, and until the window is back at its frame after it
 * is left, so the birds are measured at that size), shrunk (the window is shrunk now), and fit (ConciergeTabView's
 * size, sent while shrunk)
 */
export function useConciergeTab({ open, canShrink }: { open: boolean; canShrink: boolean }) {
  const shrunk = open && canShrink;
  // The window was shrunk and is going back to its frame: the birds wait for it (view stays true until then)
  const [restoring, setRestoring] = useState(false);
  const wasShrunk = useRef(false);
  const sentRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (shrunk) {
      wasShrunk.current = true;
      return;
    }
    if (!wasShrunk.current) return;
    wasShrunk.current = false;
    sentRef.current = undefined;
    setRestoring(true);
    let alive = true;
    void invoke<{ width: number; height: number } | null>("concierge_only_end")
      .catch(() => null)
      .then((size) => (size ? waitForSize(size) : undefined))
      .then(() => alive && setRestoring(false));
    return () => {
      alive = false;
      setRestoring(false);
    };
  }, [shrunk]);

  const fit = useCallback(
    (size: { width: number; height: number }) => {
      if (!shrunk) return;
      const key = `${size.width}x${size.height}`;
      if (sentRef.current === key) return;
      sentRef.current = key;
      void invoke("concierge_only_fit", size).catch(() => {});
    },
    [shrunk],
  );

  return { view: open || restoring, shrunk, fit };
}
