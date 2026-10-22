// The Garden's right-click menu (docs/design.md "Layout"; issue #4): one item, Arrange.
// A native menu popped up at the cursor, not one drawn in the page: at rest ("Fade until hovered") the window is fully
// transparent and takes clicks only over birds and the handle (fade.rs), so a menu drawn in the page would be hidden and
// clicked through, while a native menu is its own window and shows the same at rest and when shown
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { t } from "@/lib/i18n";

/** The mock controls ask for Arrange with this event on window, since the native menu doesn't show in a browser */
export const GARDEN_ARRANGE_EVENT = "tomarigi:garden-arrange";

// What Arrange does in the Garden on screen now (the menu is made once and kept, so its action reads this)
let onArrange: () => void = () => {};
let menu: Promise<Menu> | null = null;

/** Pops up the menu at the cursor; Arrange calls arrange. Nothing outside the app (the mock in a browser) */
export function popupGardenMenu(arrange: () => void): void {
  if (!isTauri()) return;
  onArrange = arrange;
  menu ??= Menu.new({ items: [{ id: "garden-arrange", text: t("gardenArrange"), action: () => onArrange() }] });
  menu.then(
    (m) => m.popup(),
    (e) => {
      // Made again on the next right-click
      menu = null;
      throw e;
    },
  ).catch((e) => void invoke("log", { line: `[garden] menu failed: ${e}` }).catch(() => {}));
}
