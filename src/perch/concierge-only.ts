// "Concierge only" mode (docs/design.md "Concierge"; issue #6): the Garden shows only the concierge bird and its bubble.
// Turned on and off from the Garden's right-click menu (garden-menu.ts) and saved. The session birds are only hidden:
// the Garden keeps them as they were (garden.tsx, paused) while ConciergeOnlyGarden shows the concierge. In the floating
// window's Garden the window shrinks to the concierge (concierge_only_fit in src-tauri/src/garden_grow.rs) and goes back
// to its exact frame from before when the mode ends or the Garden is left (concierge_only_end)
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { SessionView } from "@/lib/sessions";
import { loadConciergeOnly, saveConciergeOnly } from "@/lib/settings-store";
import { needsAnswer } from "@/lib/turn-verdict";

/** The mock controls toggle the mode with this event on window, since the native menu doesn't show in a browser */
export const CONCIERGE_ONLY_EVENT = "tomarigi:concierge-only";

/** How many birds the mode hides, and how many of them need a reply (the same "needs reply" as their status lines) */
export function conciergeOnlyCounts(sessions: SessionView[]): { hidden: number; waiting: number } {
  return {
    hidden: sessions.length,
    waiting: sessions.filter((s) => needsAnswer(s.state, s.ask)).length,
  };
}

/** The label right of the handle: that the mode is on (badge), with the hidden birds and how many of them need a reply */
export function conciergeOnlyLabel({ hidden, waiting }: { hidden: number; waiting: number }): {
  badge: string;
  counts: string;
} {
  const counts = t("conciergeOnlyHidden", String(hidden));
  return {
    badge: t("conciergeOnlyBadge"),
    counts: waiting > 0 ? counts + t("conciergeOnlyWaiting", String(waiting)) : counts,
  };
}

/** The header's button into the mode, the counterpart of "Show all": on the Garden (onGarden; overlay: settings or the
    debug log open over it) while the concierge is shown and the mode is off, as the right-click menu's item is */
export function conciergeOnlyEntryShown({
  conciergeAvailable,
  conciergeOnly,
  onGarden,
  overlay,
}: {
  conciergeAvailable: boolean;
  conciergeOnly: boolean;
  onGarden: boolean;
  overlay: boolean;
}): boolean {
  return conciergeAvailable && !conciergeOnly && onGarden && !overlay;
}

/** The Garden's right-click menu: "Concierge only" below "Arrange" while the concierge is shown, checked while on, with
    "Arrange" disabled then */
export function gardenMenuModel({
  conciergeAvailable,
  conciergeOnly,
}: {
  conciergeAvailable: boolean;
  conciergeOnly: boolean;
}): { arrangeEnabled: boolean; conciergeOnly: { checked: boolean } | undefined } {
  return {
    arrangeEnabled: !(conciergeAvailable && conciergeOnly),
    conciergeOnly: conciergeAvailable ? { checked: conciergeOnly } : undefined,
  };
}

/** Whether the mode stays on: it turns off once the concierge stops being shown (the key deleted, Local removed), but
    not before the settings are loaded, while it isn't known yet */
export function conciergeOnlyAfter({ on, available, loaded }: { on: boolean; available: boolean; loaded: boolean }) {
  return on && (available || !loaded);
}

/** What the window needs to be (CSS px): its room around the garden plus what the concierge and its bubble need, and
    at least as wide as the handle with its label */
export function conciergeOnlyWindowSize(m: {
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
 * available: the concierge is shown (a key saved or Local set up). loaded: the settings are loaded. canShrink: the
 * floating window shows the Garden with nothing over it, where the window shrinks to the concierge.
 * Returns on (the saved mode, for the menu and the label), view (show ConciergeOnlyGarden in place of the birds: on,
 * and until the window is back at its frame after it ends, so the birds are measured at that size), shrunk (the
 * window is shrunk now), toggle, off ("Show all"), and fit (ConciergeOnlyGarden's size, sent while shrunk)
 */
export function useConciergeOnly({
  available,
  loaded,
  canShrink,
}: {
  available: boolean;
  loaded: boolean;
  canShrink: boolean;
}) {
  // ?conciergeOnly=1 starts with it on (for checking screenshots; TOMARIGI_QUERY in the README)
  const [saved, setSaved] = useState(() => new URLSearchParams(location.search).has("conciergeOnly"));
  useEffect(() => {
    if (new URLSearchParams(location.search).has("conciergeOnly")) return;
    void loadConciergeOnly().then((v) => v && setSaved(true), () => {});
  }, []);
  const on = conciergeOnlyAfter({ on: saved, available, loaded });
  // The concierge stopped being shown: the mode turns off, and stays off after a relaunch
  useEffect(() => {
    if (saved && !on) {
      setSaved(false);
      void saveConciergeOnly(false).catch(() => {});
    }
  }, [saved, on]);

  const toggle = useCallback(() => {
    setSaved((was) => {
      void saveConciergeOnly(!was).catch(() => {});
      void invoke("log", { line: `[concierge-only] ${was ? "off" : "on"}` }).catch(() => {});
      return !was;
    });
  }, []);
  // "Show all" (App.tsx): off the same way as unchecking it in the menu
  const off = useCallback(() => {
    setSaved((was) => {
      if (!was) return was;
      void saveConciergeOnly(false).catch(() => {});
      void invoke("log", { line: "[concierge-only] off (show all)" }).catch(() => {});
      return false;
    });
  }, []);
  useEffect(() => {
    window.addEventListener(CONCIERGE_ONLY_EVENT, toggle);
    return () => window.removeEventListener(CONCIERGE_ONLY_EVENT, toggle);
  }, [toggle]);

  const shrunk = on && canShrink;
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

  return { on, view: on || restoring, shrunk, toggle, off, fit };
}
