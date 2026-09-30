// Grow the floating window when the Garden's birds don't fit (docs/design.md "Layout"). This decides how far (a scale
// of the user's size, gardenFitScale in lib/garden-fit.ts); the Rust side (src-tauri/src/garden_grow.rs) decides the
// direction, caps it at the display's visible area, and keeps the user's size apart from the grown one
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { gardenFitScale, nextGrowScale, type GardenFit, type GrowKept } from "@/lib/garden-fit";

interface UserSize {
  width: number;
  height: number;
  /** Changed by a manual resize (not by a mode switch) */
  manual: boolean;
}

/**
 * active: floating window, Garden tab, nothing else shown in its place. Otherwise the window goes back to the user's
 * size. birdCount: after a manual resize the window isn't grown back until a bird joins
 */
export function useGardenGrow(active: boolean, fit: GardenFit | null, birdCount: number) {
  const [user, setUser] = useState<UserSize | null>(null);
  // Number of birds at the last manual resize. Growth waits until there are more birds than this
  const [heldAt, setHeldAt] = useState<number | null>(null);
  const countRef = useRef(birdCount);
  countRef.current = birdCount;
  useEffect(() => {
    void invoke<UserSize>("window_user_size").then(setUser, () => {});
    const unlisten = listen<UserSize>("window-user-size", (e) => {
      setUser(e.payload);
      if (e.payload.manual) setHeldAt(countRef.current);
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // A bird joined since the manual resize: grow again. A bird left: count from the smaller number, so the next one
  // to join counts as joining
  useEffect(() => {
    if (heldAt === null) return;
    if (birdCount > heldAt) setHeldAt(null);
    else if (birdCount < heldAt) setHeldAt(birdCount);
  }, [birdCount, heldAt]);

  const held = heldAt !== null && birdCount <= heldAt;
  const growing = active && fit && user && !held;
  const needed = growing ? gardenFitScale(user.width, user.height, fit) : 1;
  // The scale applied while growing. Cleared when not growing, so it starts over from the needed scale
  const keptRef = useRef<GrowKept | null>(null);
  const sentRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    let scale = 1;
    if (growing) {
      scale = nextGrowScale(keptRef.current, needed, birdCount, user.width, user.height);
      keptRef.current = { scale, count: birdCount, userW: user.width, userH: user.height };
    } else {
      keptRef.current = null;
    }
    if (sentRef.current === scale) return;
    sentRef.current = scale;
    // What the needed scale came from, to check in the log why it changed
    const line = `[grow] page scale=${scale} needed=${needed} birds=${birdCount} fit=${JSON.stringify(fit)}`;
    void invoke("log", { line }).catch(() => {});
    void invoke("garden_fit", { scale }).catch(() => {});
  });
}
