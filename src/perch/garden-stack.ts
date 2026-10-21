// Stacking of the garden's birds and bubbles (docs/design.md "Layout"). Bubbles are in one layer above every bird
// (.garden-bubble-layer), newer turns on top. A bird the user dragged comes in front instead: its node goes above the
// bubble layer and its bubble out of the layer, just above its node, the last dragged frontmost; while dragged, above
// all of them. Pure computation (no DOM access)

// z-index of .garden-bubble-layer in styles/speech-bubble.css
export const BUBBLE_LAYER_Z = 2000;
// Dragged-and-dropped birds, above the bubble layer: node and bubble take two steps per rank
const FRONT_Z = 3000;
// A bird being dragged, above every dropped one
const DRAGGING_Z = 100_000;

export interface GardenStack {
  /** z-index of the bird's node */
  node: number;
  /** z-index of its bubble's anchor: inside the bubble layer, or beside it in the garden */
  bubble: number;
  bubbleInLayer: boolean;
}

/** front: the bird's rank among dropped ones (frontRanks in lib/garden-layout.ts); bubbleOrder: among bubbles by turn */
export function gardenStack(args: { dragging: boolean; front?: number; bubbleOrder?: number }): GardenStack {
  const { dragging, front, bubbleOrder } = args;
  if (dragging) return { node: DRAGGING_Z, bubble: DRAGGING_Z + 1, bubbleInLayer: false };
  if (front !== undefined) return { node: FRONT_Z + 2 * front, bubble: FRONT_Z + 2 * front + 1, bubbleInLayer: false };
  return { node: bubbleOrder ?? 0, bubble: bubbleOrder ?? 0, bubbleInLayer: true };
}
