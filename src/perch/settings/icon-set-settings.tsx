import { t } from "@/lib/i18n";
import type { IconSetAssignments, IconSetId } from "@/lib/icon-set-store";
import { ICON_SET_IDS, ICON_SET_LABEL, ICON_SETS, resolveIconSet } from "../icon-sets";

// One row shown in IconSetSettings (issue #14). running=false is a row "not running now but with a saved
// assignment" (shown dimmed; see IconSetSettings)
export interface IconSetRow {
  slug: string;
  label: string;
  running: boolean;
}

/**
 * Per-project icon set assignments (issue #14). Row = project (deduplicated by slug); each press of the
 * toggle button at the right end advances to the next set in ICON_SET_IDS order (after frog it wraps
 * around to birds). The rows are the union of "projects in the current sessions" ∪ "projects with only a
 * saved assignment left" (iconSetRows, computed in App.tsx). Rows not running are dimmed to tell them apart
 * (icon-set-row-idle). Switching back to "birds" deletes the assignment entry itself (the semantics
 * no entry = birds; see resolveIconSet in lib/icon-set-store.ts). Changes are saved and applied to state
 * immediately (like RootManager etc., there is no dedicated save button).
 */
export function IconSetSettings({
  rows,
  assignments,
  onChange,
}: {
  rows: IconSetRow[];
  assignments: IconSetAssignments;
  onChange: (slug: string, label: string, set: IconSetId) => void;
}) {
  return (
    <section className="icon-sets">
      <h2>{t("iconSetHeading")}</h2>
      {rows.length === 0 ? (
        <p className="icon-set-empty">{t("iconSetEmpty")}</p>
      ) : (
        <ul className="icon-set-list">
          {rows.map((row) => {
            const set = resolveIconSet(assignments, row.slug);
            const nextSet = ICON_SET_IDS[(ICON_SET_IDS.indexOf(set) + 1) % ICON_SET_IDS.length];
            return (
              <li
                key={row.slug}
                className={row.running ? "icon-set-row" : "icon-set-row icon-set-row-idle"}
              >
                <span className="icon-set-project" title={row.slug}>
                  {row.label}
                </span>
                <img
                  className="icon-set-glyph"
                  src={ICON_SETS[set].working}
                  width={20}
                  height={20}
                  alt=""
                  title={ICON_SET_LABEL[set]}
                  draggable={false}
                />
                <button
                  type="button"
                  className="small icon-set-toggle"
                  aria-label={`${t("iconSetToggleAria")}: ${row.label} (${ICON_SET_LABEL[set]})`}
                  onClick={() => onChange(row.slug, row.label, nextSet)}
                >
                  ⇄
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
