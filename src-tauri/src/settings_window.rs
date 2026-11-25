// ---- Settings window (docs/design.md "Settings window") ----
//
// A standard window of its own (label `settings`) loading the same frontend with `?view=settings`. Built when opened and
// destroyed when closed. Its size and place are saved to settings-window.json and restored when it is built again.
// In floating mode the app is an Accessory app and the floating panel never takes focus, so opening activates the app
// for this window and closing gives the front back to the app that was there before

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use crate::append_log;
use crate::window::{current_mode, on_any_monitor, WindowMode};

pub(crate) const LABEL: &str = "settings";
const DEFAULT_SIZE: (f64, f64) = (760.0, 560.0);
const MIN_SIZE: (f64, f64) = (560.0, 420.0);
const SAVE_SETTLE_MS: u64 = 400;

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Frame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// The app that was in front when the settings window was opened in floating mode (its pid), brought back on close
static PREVIOUS_APP: Mutex<Option<i32>> = Mutex::new(None);
static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn frame_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings-window.json"))
}

/// A section id is only letters and `-` (the page checks it against its list; this keeps the URL plain)
fn valid_section(section: &str) -> bool {
    !section.is_empty() && section.len() <= 32 && section.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

/// The page's URL: the settings view, the section when one is asked for, and `mock=1` when the app runs on mock data
fn page_url(section: Option<&str>, mock: bool) -> String {
    let mut url = base_url(section, mock);
    // The page's test runs in the first window only, not again when the test reopens it
    static PAGE_TEST_ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if self_test() && !PAGE_TEST_ASKED.swap(true, Ordering::SeqCst) {
        url.push_str("&selftest=1");
    }
    url
}

fn base_url(section: Option<&str>, mock: bool) -> String {
    let mut url = String::from("index.html?view=settings");
    if let Some(s) = section.filter(|s| valid_section(s)) {
        url.push_str("&section=");
        url.push_str(s);
    }
    if mock {
        url.push_str("&mock=1");
    }
    url
}

#[tauri::command]
pub(crate) fn open_settings(app: AppHandle, section: Option<String>) {
    let handle = app.clone();
    app.run_on_main_thread(move || open(&handle, section.as_deref())).ok();
}

/// Opens the settings window, or brings it to the front at `section`. Call on the main thread
pub(crate) fn open(app: &AppHandle, section: Option<&str>) {
    if current_mode() == WindowMode::Floating {
        remember_front_app();
    }
    if let Some(win) = app.get_webview_window(LABEL) {
        win.unminimize().ok();
        win.show().ok();
        if let Some(s) = section.filter(|s| valid_section(s)) {
            win.emit_to(LABEL, "settings-section", s).ok();
        }
        focus(&win);
        focus_later(app);
        return;
    }
    let mock = std::env::var("TOMARIGI_MOCK").is_ok_and(|v| v == "1");
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page_url(section, mock).into()))
        .title("tomarigi")
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .resizable(true)
        .theme(Some(tauri::Theme::Dark))
        // The page's own background (.settings-page), so no white shows before it paints
        .background_color(tauri::window::Color(24, 24, 30, 255))
        .visible(false)
        .build();
    let win = match built {
        Ok(w) => w,
        Err(e) => {
            append_log(&format!("[settings-window] build failed: {e}"));
            return;
        }
    };
    restore_frame(&win);
    let handle = app.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_save(&handle),
        WindowEvent::Destroyed => give_front_back(),
        _ => {}
    });
    win.show().ok();
    focus(&win);
    focus_later(app);
    append_log("[settings-window] opened");
}

/// Focuses the window again once it is on screen and its page has started: right after building, macOS sometimes left
/// the key window where it was (observed with the self-test)
fn focus_later(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                if let Some(w) = h.get_webview_window(LABEL) {
                    focus(&w);
                }
            })
            .ok();
    });
}

/// Makes the window the key window. In floating mode (Accessory) the app isn't active, so it is activated first; the
/// activation policy isn't changed, so no Dock icon shows (checked on macOS; docs/design.md "Settings window")
fn focus(win: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
    }
    win.set_focus().ok();
}

#[cfg(target_os = "macos")]
fn remember_front_app() {
    use objc2_app_kit::NSWorkspace;
    let front = NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier());
    let own = std::process::id() as i32;
    // Opening again while the settings window is in front keeps the app remembered the first time
    if let Some(pid) = front.filter(|&pid| pid != own) {
        *PREVIOUS_APP.lock().unwrap() = Some(pid);
        append_log(&format!("[settings-window] front app before opening pid={pid}"));
    }
}

#[cfg(not(target_os = "macos"))]
fn remember_front_app() {}

/// When the window closes in floating mode, the app that was in front before comes back. In standard mode the app has
/// its own window in front, so nothing is done (and nothing was remembered)
fn give_front_back() {
    let Some(pid) = PREVIOUS_APP.lock().unwrap().take() else { return };
    if current_mode() != WindowMode::Floating {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            app.activateWithOptions(NSApplicationActivationOptions::empty());
        }
    }
    let _ = pid;
}

fn schedule_save(app: &AppHandle) {
    let generation = SAVE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(SAVE_SETTLE_MS));
        if SAVE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                if let Some(w) = h.get_webview_window(LABEL) {
                    save_frame(&w);
                }
            })
            .ok();
    });
}

fn save_frame(win: &WebviewWindow) {
    if win.is_minimized().unwrap_or(false) || win.is_maximized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false)
    {
        return;
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
    let frame = Frame { x: pos.x, y: pos.y, width: size.width, height: size.height };
    let Some(path) = frame_path(win.app_handle()) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&frame) {
        let _ = std::fs::write(path, json);
    }
}

/// The saved size and place; centered on the main display when nothing is saved or the place isn't on any display
fn restore_frame(win: &WebviewWindow) {
    let saved = frame_path(win.app_handle())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Frame>(&text).ok());
    if let Some(f) = saved {
        append_log(&format!("[settings-window] saved frame x={} y={} w={} h={}", f.x, f.y, f.width, f.height));
    }
    match saved {
        Some(f) => {
            win.set_size(tauri::PhysicalSize::new(f.width, f.height)).ok();
            if on_any_monitor(win, f.x, f.y) {
                win.set_position(tauri::PhysicalPosition::new(f.x, f.y)).ok();
            } else {
                win.center().ok();
            }
        }
        None => {
            win.center().ok();
        }
    }
}

/// TOMARIGI_SETTINGS_TEST=1 (debug builds only; the verify .app and dev): a self-test for checks where synthetic clicks
/// can't be used, like TOMARIGI_MODE_TEST. It opens the settings window the way the menu item does, opens it again at a
/// section, hides the floating window while the page (`selftest=1`) changes settings through its own controls, then
/// closes the window and opens it again. Each step is logged as `[settings-test]`
fn self_test() -> bool {
    cfg!(debug_assertions) && std::env::var("TOMARIGI_SETTINGS_TEST").is_ok_and(|v| v == "1")
}

fn log_state(step: &str, app: &AppHandle) {
    let count = app.webview_windows().keys().filter(|l| l.as_str() == LABEL).count();
    let Some(win) = app.get_webview_window(LABEL) else {
        #[cfg(target_os = "macos")]
        let front = objc2_app_kit::NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier())
            .unwrap_or(0);
        #[cfg(not(target_os = "macos"))]
        let front = 0;
        append_log(&format!("[settings-test] {step}: no settings window, frontPid={front} ownPid={}", std::process::id()));
        return;
    };
    #[cfg(target_os = "macos")]
    let (key, active, policy, front) = unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_app_kit::NSWorkspace;
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let active: bool = msg_send![ns_app, isActive];
        let policy: isize = msg_send![ns_app, activationPolicy];
        let key = crate::window::ns_window(&win).map(|n| n.isKeyWindow()).unwrap_or(false);
        let front = NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier()).unwrap_or(0);
        (key, active, policy, front)
    };
    #[cfg(not(target_os = "macos"))]
    let (key, active, policy, front) = (win.is_focused().unwrap_or(false), true, 0isize, 0i32);
    let size = win.inner_size().map(|s| format!("{}x{}", s.width, s.height)).unwrap_or_default();
    append_log(&format!(
        "[settings-test] {step}: windows={count} key={key} appActive={active} policy={policy} frontPid={front} ownPid={} size={size} main_visible={}",
        std::process::id(),
        app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false)
    ));
}

pub(crate) fn start_self_test(app: &AppHandle) {
    if !self_test() {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let step = |wait_ms: u64, name: &'static str, f: fn(&AppHandle)| {
            std::thread::sleep(std::time::Duration::from_millis(wait_ms));
            let h = handle.clone();
            handle
                .run_on_main_thread(move || {
                    f(&h);
                    append_log(&format!("[settings-test] did {name}"));
                })
                .ok();
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let h = handle.clone();
            handle.run_on_main_thread(move || log_state(name, &h)).ok();
        };
        step(4000, "open-from-menu", |h| open(h, None));
        step(1500, "open-again-at-concierge", |h| open(h, Some("concierge")));
        // The page's own test (settings-selftest.ts) runs now, with the floating window hidden
        step(500, "hide-floating", |h| {
            h.get_webview_window("main").map(|w| w.hide());
        });
        // After the page switched the window mode to standard and back to floating: the settings window keeps the focus
        step(19000, "after-page-test", |_| {});
        step(1500, "show-floating", crate::window::show_window);
        step(2000, "close", |h| {
            h.get_webview_window(LABEL).map(|w| w.close());
        });
        step(2000, "reopen", |h| open(h, None));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_names_the_view_and_a_valid_section_only() {
        assert_eq!(base_url(None, false), "index.html?view=settings");
        assert_eq!(base_url(Some("updates"), false), "index.html?view=settings&section=updates");
        assert_eq!(base_url(Some("ai"), true), "index.html?view=settings&section=ai&mock=1");
        assert_eq!(base_url(Some("x&y=1"), false), "index.html?view=settings");
        assert_eq!(base_url(Some(""), false), "index.html?view=settings");
    }
}
