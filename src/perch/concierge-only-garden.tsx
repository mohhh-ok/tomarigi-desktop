// The Garden in "Concierge only" mode (docs/design.md "Concierge"; concierge-only.ts): the concierge bird and its bubble
// alone, at the top center of the garden, drawn as in the Garden (GardenNode). It isn't placed or saved like the birds:
// dragging it moves the floating window, which is the concierge's size. It reports the size the window needs for it
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { ConciergeAdvice, ConciergeLook } from "@/lib/concierge";
import { PLACE_EDGE_PX } from "@/lib/garden-place";
import type { SessionView } from "@/lib/sessions";
import { CONCIERGE_ID } from "./concierge";
import { conciergeOnlyWindowSize } from "./concierge-only";
import { GardenNode, type GardenMenu } from "./garden";
import { onFadeHandlePointerDown } from "./garden-fade";
import { popupGardenMenu } from "./garden-menu";

// The concierge's icon size here: a fixed size, since the window's size follows the concierge rather than the other way
// round (Claude's own decision: about the size it has beside a few birds in a 340×480 garden, so it reads the same)
const GLYPH_PX = 40;

export function ConciergeOnlyGarden({
  concierge,
  hasGranted,
  onFocus,
  canFocus,
  menu,
  onSize,
}: {
  // Absent with no session on screen (the Garden's empty message shows then, as without the mode)
  concierge?: { advice: ConciergeAdvice | null; look: ConciergeLook };
  hasGranted: boolean;
  onFocus?: (id: string) => void;
  canFocus?: (id: string) => boolean;
  menu: GardenMenu;
  // The window size it needs (CSS px; conciergeOnlyWindowSize)
  onSize: (size: { width: number; height: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);
  const [gardenW, setGardenW] = useState(0);

  // Measured after every render (the bubble's text, the window's size, the handle's label change it); onSize sends
  // only a changed size
  useLayoutEffect(() => {
    const brand = document.querySelector<HTMLElement>(".page-header .brand");
    const header = brand?.parentElement;
    // The handle with its label, on one line (its -8px margin pulls it into the page's padding)
    const handleW = brand && header ? brand.scrollWidth - 8 + (window.innerWidth - header.clientWidth) : 0;
    const garden = containerRef.current;
    if (garden) {
      if (garden.clientWidth !== gardenW) setGardenW(garden.clientWidth);
      const box = garden.getBoundingClientRect();
      const node = garden.querySelector<HTMLElement>(".garden-node");
      const bubble = garden.querySelector<HTMLElement>(".speech-bubble-below");
      const bottom = Math.max(
        node ? node.getBoundingClientRect().bottom : 0,
        bubble ? bubble.getBoundingClientRect().bottom : 0,
      );
      // Its border (1px each side) and PLACE_EDGE_PX inside it, as for the birds
      const edge = 2 * (PLACE_EDGE_PX + 1);
      onSize(
        conciergeOnlyWindowSize({
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          gardenW: box.width,
          gardenH: box.height,
          contentW: Math.max(node?.offsetWidth ?? 0, bubble?.offsetWidth ?? 0) + edge,
          contentH: bottom > 0 ? bottom - box.top + PLACE_EDGE_PX + 1 : 0,
          handleW,
        }),
      );
      return;
    }
    const empty = emptyRef.current;
    if (!empty) return;
    // The empty message isn't stretched to the window's bottom: the room from its top to the window's bottom is what
    // it takes, and it needs its own height plus the page's bottom padding and border (base.css .page)
    const label = empty.querySelector<HTMLElement>(".garden-empty-label");
    const box = empty.getBoundingClientRect();
    onSize(
      conciergeOnlyWindowSize({
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        gardenW: box.width,
        gardenH: window.innerHeight - box.top,
        contentW: (label?.offsetWidth ?? 0) + 16,
        contentH: box.height + 9,
        handleW,
      }),
    );
  });

  if (!concierge) {
    return (
      <div className="empty garden-empty" ref={emptyRef}>
        <span className="fade-handle garden-empty-label" onPointerDown={onFadeHandlePointerDown}>
          {t(hasGranted ? "emptyNoSessions" : "emptyNeedsReauth")}
        </span>
      </div>
    );
  }

  const advice = concierge.advice;
  const session: SessionView = {
    id: CONCIERGE_ID,
    project: t("conciergeName"),
    slug: CONCIERGE_ID,
    state: "done",
    sinceMs: -1,
    summary: advice?.line,
  };
  const target = advice?.targetId;
  return (
    <div
      className="garden garden-concierge-only"
      ref={containerRef}
      onContextMenu={(e) => {
        e.preventDefault();
        popupGardenMenu({ arrange: () => {}, ...menu });
      }}
    >
      <div className="garden-bubble-layer" ref={setBubbleLayer} />
      {gardenW > 0 && (
        <GardenNode
          session={session}
          position={{ x: gardenW / 2, y: PLACE_EDGE_PX }}
          gardenH={containerRef.current?.clientHeight ?? 0}
          containerRef={containerRef}
          entryOrigin="none"
          glyphSize={GLYPH_PX}
          iconSet="birds"
          onDragEnd={() => {}}
          stackOrder={1}
          bubbleLayer={bubbleLayer}
          focusable={Boolean(onFocus && target && canFocus?.(target))}
          onClick={() => target && onFocus?.(target)}
          concierge={concierge.look}
          dragMovesWindow
        />
      )}
    </div>
  );
}
