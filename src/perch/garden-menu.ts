// The Garden's right-click menu (docs/design.md "Layout"; issues #4 and #6): Arrange, and below it "Concierge only"
// while the concierge is shown (gardenMenuModel in concierge-only.ts).
// A native menu popped up at the cursor, not one drawn in the page: at rest ("Fade until hovered") the window is fully
// transparent and takes clicks only over birds and the handle (fade.rs), so a menu drawn in the page would be hidden and
// clicked through, while a native menu is its own window and shows the same at rest and when shown
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { t } from "@/lib/i18n";
import { gardenMenuModel } from "./concierge-only";

/** The mock controls ask for Arrange with this event on window, since the native menu doesn't show in a browser */
export const GARDEN_ARRANGE_EVENT = "tomarigi:garden-arrange";

// The menu last popped up, closed when the next one is made (its items depend on the mode)
let shown: Menu | null = null;

/** Pops up the menu at the cursor. Nothing outside the app (the mock in a browser) */
export function popupGardenMenu({
  arrange,
  conciergeAvailable,
  conciergeOnly,
  toggleConciergeOnly,
}: {
  arrange: () => void;
  conciergeAvailable: boolean;
  conciergeOnly: boolean;
  toggleConciergeOnly: () => void;
}): void {
  if (!isTauri()) return;
  const model = gardenMenuModel({ conciergeAvailable, conciergeOnly });
  Menu.new({
    items: [
      { id: "garden-arrange", text: t("gardenArrange"), enabled: model.arrangeEnabled, action: arrange },
      ...(model.conciergeOnly
        ? [
            {
              id: "garden-concierge-only",
              text: t("gardenConciergeOnly"),
              checked: model.conciergeOnly.checked,
              action: toggleConciergeOnly,
            },
          ]
        : []),
    ],
  })
    .then((m) => {
      void shown?.close().catch(() => {});
      shown = m;
      return m.popup();
    })
    .catch((e) => void invoke("log", { line: `[garden] menu failed: ${e}` }).catch(() => {}));
}
