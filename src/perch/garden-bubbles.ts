// Which birds outside a watch block keep the bubble room (docs/design.md "Layout"). A bubble shows its whole text and is
// drawn above every bird (styles/speech-bubble.css), so it may cover a neighbour, and a bubble that wraps onto more
// lines covers its own bird's status lines; the room stays one line's height. Only a bird in the same row as a bird
// with a bubble keeps the room, so the status lines of a row line up, as in a watch block's row. Pure computation in
// garden px (no DOM access)

/** A bird outside a block: y is its top edge (px) */
export interface BubbleBird {
  id: string;
  y: number;
  bubble: boolean;
}

// Birds whose top edges are this close stand in one row (px)
const ROW_TOLERANCE_PX = 12;

/** Birds without a bubble that keep the bubble room, so their status lines line up with the row's */
export function bubbleRoomFor(birds: BubbleBird[]): Set<string> {
  const room = new Set<string>();
  for (const b of birds) {
    if (b.bubble) continue;
    if (birds.some((a) => a.bubble && Math.abs(a.y - b.y) <= ROW_TOLERANCE_PX)) room.add(b.id);
  }
  return room;
}
