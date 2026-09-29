use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::append_log;
use crate::tray::ModeMenu;

// ---- Window ----

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(TomarigiPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Window mode (docs/design.md "Window and menu bar")
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WindowMode {
    /// NSPanel. Transparent, borderless, always on top, also shown above full-screen spaces
    Floating,
    /// Ordinary window with a title bar. Can maximize and go full screen. Not pinned on top
    Normal,
}

/// The current mode. Overwritten with the saved value at startup
pub(crate) static WINDOW_MODE: Mutex<WindowMode> = Mutex::new(WindowMode::Floating);
/// While switching modes, don't save the Moved / Resized caused by adding/removing the window frame (so the other
/// mode's position doesn't overwrite it)
static SUPPRESS_SAVE: AtomicBool = AtomicBool::new(false);
/// Sequence number of Moved / Resized. Save only when nothing changed for SAVE_SETTLE_MS after the last change
/// (the frame midway through the enter-full-screen animation was being saved; observed)
static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);
const SAVE_SETTLE_MS: u64 = 600;

pub(crate) fn schedule_save(app: &AppHandle) {
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
                if let Some(w) = h.get_webview_window("main") {
                    save_window_state(&w);
                }
            })
            .ok();
    });
}

pub(crate) fn current_mode() -> WindowMode {
    *WINDOW_MODE.lock().unwrap()
}

fn mode_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window-mode.json"))
}

pub(crate) fn load_mode(app: &AppHandle) -> WindowMode {
    mode_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<WindowMode>(&text).ok())
        .unwrap_or(WindowMode::Floating)
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(value) {
        let _ = std::fs::write(path, json);
    }
}

/// Position and size are kept separately per mode (so a maximized size isn't carried into the floating window).
/// The floating window uses the existing window.json
fn state_path(app: &AppHandle, mode: WindowMode) -> Option<PathBuf> {
    let name = match mode {
        WindowMode::Floating => "window.json",
        WindowMode::Normal => "window-normal.json",
    };
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

fn save_window_state(win: &WebviewWindow) {
    if SUPPRESS_SAVE.load(Ordering::SeqCst) {
        return;
    }
    // Don't save the size while maximized or full screen (so restoring goes back to the original size)
    // Also don't save the frame while entering full screen (tao's is_fullscreen can still be false; observed)
    if win.is_maximized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false) || in_fullscreen_transition(win) {
        return;
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
    let state = WindowState { x: pos.x, y: pos.y, width: size.width, height: size.height };
    let Some(path) = state_path(win.app_handle(), current_mode()) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, json);
    }
}

/// On first launch (no saved state), place it at the top right of the main display (so it doesn't hide the
/// terminal in the middle of the screen)
fn place_top_right(win: &WebviewWindow) {
    let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else { return };
    let (p, s, scale) = (monitor.position(), monitor.size(), monitor.scale_factor());
    let margin = (16.0 * scale) as i32;
    let menu_bar = (40.0 * scale) as i32;
    let x = p.x + s.width as i32 - size.width as i32 - margin;
    win.set_position(tauri::PhysicalPosition::new(x, p.y + menu_bar)).ok();
}

/// Restores the saved position and size. If the position isn't on any display (e.g. a disconnected display),
/// places it at the top right
pub(crate) fn restore_window_state(win: &WebviewWindow, mode: WindowMode) {
    let saved = state_path(win.app_handle(), mode)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<WindowState>(&text).ok());
    let Some(state) = saved else {
        place_top_right(win);
        return;
    };
    win.set_size(tauri::PhysicalSize::new(state.width, state.height)).ok();
    let on_screen = win.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        state.x >= p.x
            && state.y >= p.y
            && state.x < p.x + s.width as i32
            && state.y < p.y + s.height as i32
    });
    if on_screen {
        win.set_position(tauri::PhysicalPosition::new(state.x, state.y)).ok();
    } else {
        place_top_right(win);
    }
    append_log(&format!(
        "[window] restore mode={mode:?} x={} y={} w={} h={} on_screen={on_screen}",
        state.x, state.y, state.width, state.height
    ));
}

#[cfg(target_os = "macos")]
pub(crate) fn make_panel(win: &WebviewWindow) {
    use objc2_app_kit::NSWindowStyleMask;
    use tauri_nspanel::{CollectionBehavior, WebviewWindowExt};
    let panel = win.to_panel::<TomarigiPanel>().expect("to_panel");
    // Non-activating panel: clicking doesn't steal focus from Ghostty. Resizable lets you resize from the edges
    panel
        .set_style_mask(
            NSWindowStyleMask::Borderless
                | NSWindowStyleMask::NonactivatingPanel
                | NSWindowStyleMask::Resizable,
        )
        .ok();
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .into(),
    );
    // NSStatusWindowLevel (25). Above floating (3)
    panel.set_level(25);
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    // The shadow shows that it is floating above the terminal. For a transparent window, macOS builds the shadow
    // from the shape of the content (the rounded panel)
    panel.set_has_shadow(true);
    // Match the frosted glass corners to the rounded corners of .page (border-radius 12px in src/perch/styles/base.css)
    set_backdrop(win, 12.0);
}

#[cfg(target_os = "macos")]
pub(crate) fn ns_window(win: &WebviewWindow) -> Option<&objc2_app_kit::NSWindow> {
    let ptr = win.ns_window().ok()? as *const objc2_app_kit::NSWindow;
    unsafe { ptr.as_ref() }
}

/// Make the window itself transparent. The content's .page paints a translucent color, and set_backdrop's frosted
/// glass blurs what is behind it (for both floating and standard windows; docs/design.md "Window and menu bar")
#[cfg(target_os = "macos")]
fn set_window_clear(win: &WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let Some(ns) = ns_window(win) else { return };
    unsafe {
        let color: *mut AnyObject = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns, setBackgroundColor: color];
        let _: () = msg_send![ns, setOpaque: false];
    }
}

/// Marker for the frosted glass view (looked up among contentView's children)
#[cfg(target_os = "macos")]
const BACKDROP_ID: &str = "tomarigi.backdrop";

/// Frosted glass that blurs what is behind the window. Lays one NSVisualEffectView at the bottom of contentView
/// (behind the WKWebView) and shows it through the translucent color of the content's .page. The goal is to make
/// the window feel less heavy, not to let you read what is behind it.
/// Tauri's set_effects (window-vibrancy 0.6) adds a view on every call and has no way to remove it on macOS, so
/// here, which is called on every mode switch, a single view is reused and only its corner radius changes. Switching
/// to NSPanel (tauri-nspanel) only changes the window's class and keeps contentView, so the same view remains
/// before and after the switch
#[cfg(target_os = "macos")]
pub(crate) fn find_backdrop(ns: &objc2_app_kit::NSWindow) -> Option<&objc2::runtime::AnyObject> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    unsafe {
        let content: *mut AnyObject = msg_send![ns, contentView];
        let content = content.as_ref()?;
        let subviews: *mut AnyObject = msg_send![content, subviews];
        let count: usize = msg_send![subviews, count];
        for i in 0..count {
            let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            let ident: *mut NSString = msg_send![v, identifier];
            if ident.as_ref().is_some_and(|id| id.to_string() == BACKDROP_ID) {
                return v.as_ref();
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
fn set_backdrop(win: &WebviewWindow, radius: f64) {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSRect, NSString};
    let Some(ns) = ns_window(win) else { return };
    unsafe {
        let content: *mut AnyObject = msg_send![ns, contentView];
        let Some(content) = content.as_ref() else { return };
        let found = find_backdrop(ns);
        let view = match found {
            Some(v) => v,
            None => {
                let bounds: NSRect = msg_send![content, bounds];
                let alloc: Allocated<AnyObject> = msg_send![class!(NSVisualEffectView), alloc];
                let created: Retained<AnyObject> = msg_send![alloc, initWithFrame: bounds];
                let _: () = msg_send![&*created, setIdentifier: &*NSString::from_str(BACKDROP_ID)];
                // NSVisualEffectMaterialHUDWindow (13): dark frosted glass. BlendingMode BehindWindow (0): blur what is
                // behind the window. State Active (1): the floating window never becomes key (NonactivatingPanel), so
                // following the window's state would make the blur disappear
                let _: () = msg_send![&*created, setMaterial: 13isize];
                let _: () = msg_send![&*created, setBlendingMode: 0isize];
                let _: () = msg_send![&*created, setState: 1isize];
                // Use dark glass regardless of the window's appearance (the floating window has no theme set)
                let dark: *mut AnyObject =
                    msg_send![class!(NSAppearance), appearanceNamed: &*NSString::from_str("NSAppearanceNameDarkAqua")];
                let _: () = msg_send![&*created, setAppearance: dark];
                // NSViewWidthSizable (2) | NSViewHeightSizable (16). Follows the window size and the title bar being
                // added or removed
                let _: () = msg_send![&*created, setAutoresizingMask: 18usize];
                // NSWindowBelow (-1). Behind the content (WKWebView)
                let _: () = msg_send![content, addSubview: &*created, positioned: -1isize, relativeTo: std::ptr::null::<AnyObject>()];
                // The parent view retains it, so the reference here can be dropped
                let ptr: *const AnyObject = &*created;
                &*ptr
            }
        };
        // Corner radius uses setCornerRadius:, same as window-vibrancy (a private NSVisualEffectView method). On OS
        // versions without it, corners stay square
        let responds: bool = msg_send![view, respondsToSelector: sel!(setCornerRadius:)];
        if responds {
            let _: () = msg_send![view, setCornerRadius: radius];
        }
        append_log(&format!("[window] backdrop radius={radius} corner={responds} reused={}", found.is_some()));
    }
}

/// Turns the floating window (NSPanel) back into an ordinary window. Adds the title bar and traffic-light buttons,
/// and removes always-on-top and showing on all spaces
#[cfg(target_os = "macos")]
pub(crate) fn make_normal(win: &WebviewWindow) {
    use objc2_app_kit::NSWindowCollectionBehavior;
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = win.app_handle().get_webview_panel("main") {
        panel.to_window();
    }
    win.set_always_on_top(false).ok();
    win.set_visible_on_all_workspaces(false).ok();
    // tao's set_decorations takes effect later on the main queue, so add the title bar synchronously before
    // restoring the position (if it is added afterwards, the window grows upward, gets pushed back below the menu
    // bar, and the position shifts; observed)
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        ns.setStyleMask(
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable,
        );
    }
    win.set_decorations(true).ok();
    win.set_resizable(true).ok();
    win.set_maximizable(true).ok();
    // The content is dark, so make the title bar dark too
    win.set_theme(Some(tauri::Theme::Dark)).ok();
    set_window_clear(win);
    // The standard window has its own corners, so the frosted glass fills the window with no corner radius
    set_backdrop(win, 0.0);
    if let Some(ns) = ns_window(win) {
        // NSNormalWindowLevel (0). With FullScreenPrimary, the green traffic-light button goes full screen
        ns.setLevel(0);
        ns.setCollectionBehavior(NSWindowCollectionBehavior::Managed | NSWindowCollectionBehavior::FullScreenPrimary);
        ns.setHasShadow(true);
    }
}

#[cfg(target_os = "macos")]
/// The title bar must be removed first (has_titlebar in switch_mode_step). Switching to NSPanel with it still
/// attached crashes with NSRangeException because the title bar view can't remove the KVO it added to the original
/// class (observed)
fn make_floating(win: &WebviewWindow) {
    win.set_theme(None).ok();
    set_window_clear(win);
    make_panel(win);
}

/// Whether the title bar is attached in AppKit. tao's set_decorations takes effect later on the main queue, so look
/// at the actual styleMask
fn has_titlebar(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        return ns.styleMask().contains(NSWindowStyleMask::Titled);
    }
    let _ = win;
    false
}

/// Syncs the menu check marks and settings (the "window-mode" event in App.tsx) to the current mode
pub(crate) fn sync_mode_ui(app: &AppHandle, mode: WindowMode) {
    if let Some(menu) = app.try_state::<ModeMenu>() {
        menu.floating.set_checked(mode == WindowMode::Floating).ok();
        menu.normal.set_checked(mode == WindowMode::Normal).ok();
    }
    app.emit("window-mode", mode).ok();
}

/// Switches the mode on the fly. Call on the main thread, since it operates on AppKit windows
pub(crate) fn switch_mode(app: &AppHandle, mode: WindowMode) {
    switch_mode_step(app, mode, SwitchProgress::default());
}

/// Progress state for switching only after full screen and the title bar have been removed. Maximize is not undone
/// (undoing it takes effect later on the main queue, and sometimes it didn't undo even after waiting; observed.
/// Position and size are restored directly by restore_window_state)
#[derive(Default, Clone, Copy)]
struct SwitchProgress {
    attempt: u32,
    exited_fullscreen: bool,
    undecorated: bool,
    settled: bool,
}

/// Whether AppKit is midway through entering or leaving full screen. Switching to NSPanel midway runs tao's
/// windowDidResize with the content view detached, and it crashes on the contentView unwrap (observed). tao's
/// is_fullscreen becomes false as soon as the exit is requested, so look at AppKit's styleMask
fn in_fullscreen_transition(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        return ns.styleMask().contains(NSWindowStyleMask::FullScreen) || ns.contentView().is_none();
    }
    let _ = win;
    false
}

fn retry_switch(app: &AppHandle, mode: WindowMode, progress: SwitchProgress) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let h = handle.clone();
        handle.run_on_main_thread(move || switch_mode_step(&h, mode, progress)).ok();
    });
}

/// Show in the Dock, Cmd+Tab, and the app-name menu bar only for the standard window (so it can be brought back when
/// buried under other windows). The floating window stays hidden from them as before. LSUIElement in Info.plist is
/// kept to prevent a brief Dock appearance right after launch
pub(crate) fn set_dock_policy(app: &AppHandle, mode: WindowMode) {
    #[cfg(target_os = "macos")]
    {
        let policy = match mode {
            WindowMode::Floating => tauri::ActivationPolicy::Accessory,
            WindowMode::Normal => tauri::ActivationPolicy::Regular,
        };
        app.set_activation_policy(policy).ok();
        append_log(&format!("[window] activation policy for {mode:?}"));
    }
    let _ = (app, mode);
}

/// After switching to the standard window, bring the app to the front and show the window and the app-name menu bar.
/// Clicking the floating window doesn't activate the app (NonactivatingPanel), so switching from settings would
/// leave the previous app in front. It doesn't work right after setting Regular, so wait a moment
fn activate_later(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                #[cfg(target_os = "macos")]
                unsafe {
                    use objc2::runtime::AnyObject;
                    use objc2::{class, msg_send};
                    let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                    let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
                }
                if let Some(w) = h.get_webview_window("main") {
                    w.set_focus().ok();
                }
            })
            .ok();
    });
}

fn switch_mode_step(app: &AppHandle, mode: WindowMode, mut p: SwitchProgress) {
    let Some(win) = app.get_webview_window("main") else { return };
    if current_mode() == mode {
        // Clicking an already-checked item unchecks it, so check it again
        sync_mode_ui(app, mode);
        return;
    }
    if p.attempt == 0 {
        save_window_state(&win);
        // Don't save the Moved / Resized from leaving full screen or maximize as the current mode's position
        SUPPRESS_SAVE.store(true, Ordering::SeqCst);
    }
    p.attempt += 1;
    // Wait up to 5 seconds (200ms × 25). Remove full screen, then the title bar, and switch one interval after
    // they are gone
    if p.attempt <= 25 {
        if win.is_fullscreen().unwrap_or(false) || in_fullscreen_transition(&win) {
            if !p.exited_fullscreen {
                p.exited_fullscreen = true;
                win.set_fullscreen(false).ok();
            }
            return retry_switch(app, mode, p);
        }
        if mode == WindowMode::Floating && has_titlebar(&win) {
            if !p.undecorated {
                p.undecorated = true;
                win.set_decorations(false).ok();
            }
            return retry_switch(app, mode, p);
        }
        if (p.exited_fullscreen || p.undecorated) && !p.settled {
            p.settled = true;
            return retry_switch(app, mode, p);
        }
    } else {
        // Switching while they are still on would crash, so don't switch; restore the UI to the current mode
        append_log("[window] switch: gave up waiting for fullscreen / titlebar to end");
        SUPPRESS_SAVE.store(false, Ordering::SeqCst);
        sync_mode_ui(app, current_mode());
        return;
    }
    *WINDOW_MODE.lock().unwrap() = mode;
    if let Some(path) = mode_path(app) {
        write_json(path, &mode);
    }
    let visible = win.is_visible().unwrap_or(false);
    #[cfg(target_os = "macos")]
    match mode {
        WindowMode::Floating => make_floating(&win),
        WindowMode::Normal => make_normal(&win),
    }
    restore_window_state(&win, mode);
    set_dock_policy(app, mode);
    if visible {
        show_window(app);
        if mode == WindowMode::Normal {
            activate_later(app);
        }
    }
    sync_mode_ui(app, mode);
    append_log(&format!("[window] mode={mode:?}"));
    // Let the late Moved / Resized from adding/removing the frame pass, then re-enable saving and save the position
    // and size after the switch (so that even if the app quits without moving, it opens at the same position and
    // size next time)
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        SUPPRESS_SAVE.store(false, Ordering::SeqCst);
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                if let Some(w) = h.get_webview_window("main") {
                    save_window_state(&w);
                }
            })
            .ok();
    });
}

#[tauri::command]
pub(crate) fn get_window_mode() -> WindowMode {
    current_mode()
}

#[tauri::command]
pub(crate) fn set_window_mode(app: AppHandle, mode: WindowMode) {
    let handle = app.clone();
    app.run_on_main_thread(move || switch_mode(&handle, mode)).ok();
}

pub(crate) fn show_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    win.show().ok();
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("main") {
            // show resets the level to alwaysOnTop's floating (3), so reapply NSStatusWindowLevel (25) after showing
            panel.set_level(25);
            panel.order_front_regardless();
            let ns = panel.as_panel();
            append_log(&format!(
                "[window] shown class={} level={} isOnActiveSpace={}",
                ns.class().name().to_str().unwrap_or("?"),
                ns.level(),
                ns.isOnActiveSpace()
            ));
        } else {
            // Standard window: it is buried under other windows, so bring it to the front
            win.set_focus().ok();
            append_log("[window] shown mode=Normal");
        }
    }
}

pub(crate) fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    if win.is_visible().unwrap_or(false) {
        win.hide().ok();
    } else {
        show_window(app);
    }
}

#[tauri::command]
pub(crate) fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().ok();
    }
}
