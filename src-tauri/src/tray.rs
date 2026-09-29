// ---- Menu bar icon ----

use std::process::Command;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::window::{switch_mode, toggle_window, WindowMode};

/// The "floating window / standard window" items in the menu bar menu. The check marks are reset on every mode change
pub(crate) struct ModeMenu {
    pub(crate) floating: CheckMenuItem<tauri::Wry>,
    pub(crate) normal: CheckMenuItem<tauri::Wry>,
}

/// Menu labels. Japanese if the system language is Japanese, English otherwise
/// (show/hide, floating window, standard window, quit)
fn menu_labels() -> (&'static str, &'static str, &'static str, &'static str) {
    let locale = Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    if locale.starts_with("ja") {
        ("表示 / 非表示", "浮遊窓（常に最前面）", "通常の窓（最大化できる）", "tomarigi を終了")
    } else {
        ("Show / Hide", "Floating (always on top)", "Standard window (can maximize)", "Quit tomarigi")
    }
}

pub(crate) fn setup_tray(app: &tauri::App, mode: WindowMode) -> tauri::Result<()> {
    let (toggle_label, floating_label, normal_label, quit_label) = menu_labels();
    let toggle = MenuItem::with_id(app, "toggle", toggle_label, true, None::<&str>)?;
    let floating =
        CheckMenuItem::with_id(app, "mode-floating", floating_label, true, mode == WindowMode::Floating, None::<&str>)?;
    let normal = CheckMenuItem::with_id(app, "mode-normal", normal_label, true, mode == WindowMode::Normal, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &floating,
            &normal,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(ModeMenu { floating, normal });
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
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
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles show/hide, right click opens the menu
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
