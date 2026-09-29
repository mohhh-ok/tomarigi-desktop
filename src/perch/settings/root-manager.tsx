import { useRef } from "react";
import { t } from "@/lib/i18n";
import type { RootEntry } from "@/lib/settings-store";

/** The watched folder whose label is being edited, and the text typed so far */
export interface Editing {
  id: string;
  draft: string;
}

export function RootManager({
  roots,
  perms,
  brokenIds,
  editing,
  addMessage,
  onRequestAdd,
  onRemove,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
}: {
  roots: RootEntry[];
  perms: Record<string, PermissionState>;
  brokenIds: string[];
  editing: Editing | null;
  addMessage: string | null;
  onRequestAdd: () => void;
  onRemove: (id: string) => void;
  onStartEdit: (root: RootEntry) => void;
  onEditChange: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}) {
  // Suppresses the blur that fires right after canceling with Escape from calling onCommitEdit and
  // committing over it (there is always at most one row being edited, so one shared flag is enough)
  const suppressBlurRef = useRef(false);

  return (
    <section className="roots">
      <h2>{t("rootsHeading")}</h2>
      <ul className="root-list">
        {roots.map((root) => {
          const perm = perms[root.id];
          const broken = brokenIds.includes(root.id);
          const isEditing = editing?.id === root.id;
          return (
            <li key={root.id} className="root-row">
              {isEditing ? (
                <input
                  className="root-label-input"
                  autoFocus
                  value={editing.draft}
                  placeholder={t("rootLabelPlaceholder")}
                  onChange={(e) => onEditChange(e.target.value)}
                  // In browsers where no blur follows Escape, a leftover flag would wrongly swallow the next
                  // blur commit, so always reset it on the focus that starts editing
                  onFocus={() => {
                    suppressBlurRef.current = false;
                  }}
                  onBlur={() => {
                    if (suppressBlurRef.current) {
                      suppressBlurRef.current = false;
                      return;
                    }
                    onCommitEdit();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitEdit();
                    if (e.key === "Escape") {
                      suppressBlurRef.current = true;
                      onCancelEdit();
                    }
                  }}
                />
              ) : (
                <span className="root-label" title={root.path}>
                  {root.label}
                  {/* The label alone doesn't tell what it actually is (which config directory), so the path is added */}
                  <span className="root-path">{root.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                </span>
              )}
              {/* Folders always watched by default (~/.claude/projects etc.). Can't be removed */}
              {root.builtin && <span className="badge badge-default">{t("rootDefaultBadge")}</span>}
              {/* The desktop app has no concept of read permission. Shown only when the folder is missing or unreadable */}
              {(broken || perm !== "granted") && (
                <span className="badge badge-error">{t("badgeUnreadable")}</span>
              )}
              {!isEditing && (
                <button className="small" onClick={() => onStartEdit(root)}>
                  {t("editLabelButton")}
                </button>
              )}
              {root.builtin ? (
                // Defaults can't be removed. Reserve only the × slot so the label edit button lines up with added rows
                <button
                  className="small remove root-remove-placeholder"
                  aria-hidden="true"
                  tabIndex={-1}
                  disabled
                >
                  ✕
                </button>
              ) : (
                <button
                  className="small remove"
                  onClick={() => onRemove(root.id)}
                  aria-label={t("removeButtonAria")}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button onClick={onRequestAdd}>{t("addRootButton")}</button>
      {addMessage && <p className="add-message">{addMessage}</p>}
    </section>
  );
}
