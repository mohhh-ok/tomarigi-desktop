// Persists per-project icon set assignments (issue #14).
//
// Like garden-layout.ts, this uses the app's key-value store (lib/kv.ts).
//
// The key is the project identifier within the data source (same vocabulary as SessionView.slug in lib/session-types.ts).
// rootId isn't part of the key — when the same project path is seen from several roots,
// the assignment is shared (intended behavior).
//
// This is the only definition (source of truth) of IconSetId. The images themselves (WebP imports) are
// src/perch's concern (lib is the logic layer and can't depend on src/perch's asset
// imports), but "which IDs exist" is shared vocabulary needed by both persistence (validation, resolving defaults)
// and display, so it's kept in the same place as BirdState (lib/session-types.ts).
// src/perch/icon-sets.ts imports this type and builds the image table.

import { kvDelete, kvGet, kvPut } from "./kv";

export const KEY_ICON_SET_ASSIGNMENTS = "projectIconSets";
// Leftover key from the old unreleased approach (regex rules). Deleted when found on load
const KEY_ICON_SET_RULES_LEGACY = "iconSetRules";

export type IconSetId = "birds" | "gnome" | "cat" | "robot" | "frog";

export const DEFAULT_ICON_SET: IconSetId = "birds";

// Canonical order used for both validation and cycling the toggle in the UI (going to the next set)
export const ICON_SET_IDS: readonly IconSetId[] = ["birds", "gnome", "cat", "robot", "frog"];

function isIconSetId(value: unknown): value is IconSetId {
  return typeof value === "string" && (ICON_SET_IDS as readonly string[]).includes(value);
}

/**
 * One assignment. label is a snapshot of the display name (SessionView.project) — kept so rows of projects
 * that aren't running still show a human-readable name. Saved only when the assignment changes
 * (while the session is shown it may be overwritten with the latest display name each time, but writing on every poll is
 * forbidden. See the caller in App.tsx).
 */
export interface IconSetAssignment {
  set: IconSetId;
  label: string;
}

export type IconSetAssignments = Record<string /* slug */, IconSetAssignment>;

function isIconSetAssignment(value: unknown): value is IconSetAssignment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isIconSetId(v.set) && typeof v.label === "string";
}

/**
 * Saved assignments (slug → {set, label}). Broken entries (e.g. leftovers from a set removed in the
 * future) are removed on load. When nothing is saved, an empty object (= always resolves to DEFAULT_ICON_SET).
 * Because of the "choosing birds (default) = deleting the entry" semantics (see resolveIconSet below),
 * an entry whose set is DEFAULT_ICON_SET is never expected to be saved.
 */
export async function loadIconSetAssignments(): Promise<IconSetAssignments> {
  // Clean up leftovers from the old unreleased approach (regex rules), once
  if ((await kvGet(KEY_ICON_SET_RULES_LEGACY)) !== undefined) await kvDelete(KEY_ICON_SET_RULES_LEGACY);
  const saved = (await kvGet(KEY_ICON_SET_ASSIGNMENTS)) as unknown;
  if (typeof saved !== "object" || saved === null) return {};
  const out: IconSetAssignments = {};
  for (const [slug, value] of Object.entries(saved as Record<string, unknown>)) {
    if (isIconSetAssignment(value)) out[slug] = value;
  }
  return out;
}

export async function saveIconSetAssignments(assignments: IconSetAssignments): Promise<void> {
  await kvPut(KEY_ICON_SET_ASSIGNMENTS, assignments);
}

/** Resolves slug → IconSetId. DEFAULT_ICON_SET (birds) if there's no assignment. */
export function resolveIconSet(assignments: IconSetAssignments, slug: string): IconSetId {
  return assignments[slug]?.set ?? DEFAULT_ICON_SET;
}
