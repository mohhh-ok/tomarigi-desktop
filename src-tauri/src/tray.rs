// ---- Menu bar icon ----

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::updater::{check_now, install_now, UpdateStatus};
use crate::window::{show_window, switch_mode, toggle_window, WindowMode};

/// The "floating window / standard window" items in the menu bar menu. The check marks are reset on every mode change
pub(crate) struct ModeMenu {
    pub(crate) floating: CheckMenuItem<tauri::Wry>,
    pub(crate) normal: CheckMenuItem<tauri::Wry>,
}

/// The "Check for updates" / "Update to v<version>" item. Its label follows the update status (show_update_status)
struct UpdateMenu(MenuItem<tauri::Wry>);

/// The system locale: `defaults read -g AppleLocale` on macOS, the OS locale elsewhere (sys-locale)
fn system_locale() -> String {
    #[cfg(target_os = "macos")]
    return std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    #[cfg(not(target_os = "macos"))]
    sys_locale::get_locale().unwrap_or_default()
}

/// Menu labels. Japanese if the system language is Japanese, English otherwise
/// (show/hide, floating window, standard window, quit)
fn menu_labels() -> (&'static str, &'static str, &'static str, &'static str) {
    if is_japanese() {
        ("表示 / 非表示", "浮遊窓（常に最前面）", "通常の窓（最大化できる）", "tomarigi を終了")
    } else {
        ("Show / Hide", "Floating (always on top)", "Standard window (can maximize)", "Quit tomarigi")
    }
}

/// Read once: the update item's label changes on every percent of a download
fn is_japanese() -> bool {
    static JA: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *JA.get_or_init(|| system_locale().starts_with("ja"))
}

/// The update item's label and whether it can be clicked. Japanese / English like the other items
fn update_label(status: &UpdateStatus) -> (String, bool) {
    let ja = is_japanese();
    match status {
        UpdateStatus::Available { version } | UpdateStatus::InstallFailed { version } => {
            (if ja { format!("v{version} に更新") } else { format!("Update to v{version}") }, true)
        }
        UpdateStatus::Checking => ((if ja { "アップデートを確認中…" } else { "Checking for Updates…" }).into(), false),
        UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. } => {
            ((if ja { "アップデート中…" } else { "Updating…" }).into(), false)
        }
        UpdateStatus::Idle | UpdateStatus::UpToDate | UpdateStatus::CheckFailed => {
            ((if ja { "アップデートを確認" } else { "Check for Updates" }).into(), true)
        }
    }
}

pub(crate) fn show_update_status(app: &AppHandle, status: &UpdateStatus) {
    let Some(menu) = app.try_state::<UpdateMenu>() else { return };
    let (label, enabled) = update_label(status);
    menu.0.set_text(label).ok();
    menu.0.set_enabled(enabled).ok();
}

/// The update item: checks, or installs the found version. Either way the window opens on the settings' update section,
/// where the result and the progress are shown (docs/design.md "Updates")
fn on_update_item(app: &AppHandle) {
    show_window(app);
    app.emit("open-updates", ()).ok();
    match crate::updater::update_status(app.clone()) {
        UpdateStatus::Available { .. } | UpdateStatus::InstallFailed { .. } => install_now(app),
        _ => check_now(app),
    }
}

pub(crate) fn setup_tray(app: &tauri::App, mode: WindowMode) -> tauri::Result<()> {
    let (toggle_label, floating_label, normal_label, quit_label) = menu_labels();
    let toggle = MenuItem::with_id(app, "toggle", toggle_label, true, None::<&str>)?;
    let floating =
        CheckMenuItem::with_id(app, "mode-floating", floating_label, true, mode == WindowMode::Floating, None::<&str>)?;
    let normal = CheckMenuItem::with_id(app, "mode-normal", normal_label, true, mode == WindowMode::Normal, None::<&str>)?;
    let (update_text, _) = update_label(&UpdateStatus::Idle);
    let update = MenuItem::with_id(app, "update", update_text, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &floating,
            &normal,
            &PredefinedMenuItem::separator(app)?,
            &update,
            &quit,
        ],
    )?;
    app.manage(ModeMenu { floating, normal });
    app.manage(UpdateMenu(update));
    // macOS: a black template image the menu bar tints. Windows / Linux taskbars are often dark, so the app icon in
    // color is used there
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("tomarigi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_window(app),
            "mode-floating" => switch_mode(app, WindowMode::Floating),
            "mode-normal" => switch_mode(app, WindowMode::Normal),
            "update" => on_update_item(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles show/hide, right click opens the menu. Linux doesn't deliver the click, so the menu's
            // "Show / Hide" is the way there
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
