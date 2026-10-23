// The Garden's right-click menu (docs/design.md "Layout"; issue #4): Arrange.
// A native menu popped up at the cursor, not one drawn in the page: at rest ("Fade until hovered") the window is fully
// transparent and takes clicks only over birds and the handle (fade.rs), so a menu drawn in the page would be hidden and
// clicked through, while a native menu is its own window and shows the same at rest and when shown
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { t } from "@/lib/i18n";

/** The mock controls ask for Arrange with this event on window, since the native menu doesn't show in a browser */
export const GARDEN_ARRANGE_EVENT = "tomarigi:garden-arrange";

// The menu last popped up, closed when the next one is made
let shown: Menu | null = null;

/** Pops up the menu at the cursor. Nothing outside the app (the mock in a browser) */
export function popupGardenMenu({ arrange }: { arrange: () => void }): void {
  if (!isTauri()) return;
  Menu.new({ items: [{ id: "garden-arrange", text: t("gardenArrange"), action: arrange }] })
    .then((m) => {
      void shown?.close().catch(() => {});
      shown = m;
      return m.popup();
    })
    .catch((e) => void invoke("log", { line: `[garden] menu failed: ${e}` }).catch(() => {}));
}
