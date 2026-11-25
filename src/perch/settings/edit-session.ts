import type { Editing } from "./root-manager";

/** The edit that is open right now, kept in a ref so that closing it is visible to the next event at once: a React
 * state update isn't, and the blur that follows removing the field would still see the edit as open */
export interface EditSession {
  current: Editing | null;
}

/**
 * Closes the open edit. Only the first call after the edit was opened closes it; it returns what to save (the edit
 * itself when `save`, else null). Every later call (the blur after Cancel or Esc removes the field, Enter followed by
 * blur) gets null and does nothing
 */
export function finishEdit(session: EditSession, save: boolean): Editing | null {
  const open = session.current;
  session.current = null;
  return save ? open : null;
}
