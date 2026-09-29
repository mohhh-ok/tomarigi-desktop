use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::append_log;
use crate::window::{current_mode, find_backdrop, ns_window, WindowMode};

// ---- Fade until hovered (docs/design.md "Window mode") ----
// At rest the floating window's Garden shows only the birds, and clicks go through to the window below
// (ignoresMouseEvents). The WebView then gets no mouse events, so the cursor is watched here and the whole window
// comes back when it is on a bird. garden-fade.ts sends the bird rectangles and whether the fade applies, and
// receives "garden-fade" (true = faded) to fade the page itself

/// A bird's rectangle in window content coordinates (CSS px = points, origin at the top left)
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub(crate) struct BirdRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl BirdRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

struct Fade {
    /// From garden-fade.ts: floating window, Garden tab, and at least one bird
    wanted: bool,
    birds: Vec<BirdRect>,
    /// Whether the fade was in effect at the last tick (false in the standard window, while hidden, etc.)
    active: bool,
    /// Shown at full strength (the cursor went onto a bird and hasn't left the window yet)
    revealed: bool,
    /// Emit the current state on the next tick even if it didn't change. The page may have lost it: reloaded
    /// (data-fade is gone while clicks still go through), enabled flipped off and on within a tick, or an emit
    /// arrived before the page's listener was registered
    resync: bool,
}

static FADE: Mutex<Fade> =
    Mutex::new(Fade { wanted: false, birds: Vec::new(), active: false, revealed: false, resync: false });
const FADE_TICK_MS: u64 = 50;

/// A panic while holding the lock mustn't leave the window stuck letting clicks through, so a poisoned lock is
/// still used
fn fade_state() -> std::sync::MutexGuard<'static, Fade> {
    FADE.lock().unwrap_or_else(|e| e.into_inner())
}

/// resync: garden-fade.ts sets it on its first call after mounting (after its listener is registered)
#[tauri::command]
pub(crate) fn set_garden_fade(enabled: bool, birds: Vec<BirdRect>, resync: bool) {
    let mut fade = fade_state();
    if resync || fade.wanted != enabled {
        fade.resync = true;
    }
    fade.wanted = enabled;
    fade.birds = birds;
}

/// Next revealed state. Once shown, it stays until the cursor leaves the window (kept while a mouse button is held,
/// so resizing from the edge or dragging the window isn't cut off midway)
fn next_revealed(revealed: bool, inside: bool, on_bird: bool, button_down: bool) -> bool {
    if revealed {
        inside || button_down
    } else {
        on_bird
    }
}

/// Cursor position in the window's content coordinates, and whether a mouse button is held
#[cfg(target_os = "macos")]
fn cursor_in_window(ns: &objc2_app_kit::NSWindow) -> (f64, f64, f64, f64, bool) {
    use objc2::{class, msg_send};
    use objc2_foundation::NSPoint;
    // Screen coordinates with the origin at the bottom left, in points (same as the window frame)
    let mouse: NSPoint = unsafe { msg_send![class!(NSEvent), mouseLocation] };
    let pressed: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    let frame = ns.frame();
    let x = mouse.x - frame.origin.x;
    let y = frame.origin.y + frame.size.height - mouse.y;
    (x, y, frame.size.width, frame.size.height, pressed != 0)
}

/// Faded: clicks go through, and the frosted glass and shadow disappear. The rest of the page fades in CSS
#[cfg(target_os = "macos")]
fn apply_fade(win: &WebviewWindow, faded: bool) {
    use objc2::msg_send;
    let Some(ns) = ns_window(win) else { return };
    ns.setIgnoresMouseEvents(faded);
    if let Some(view) = find_backdrop(ns) {
        let alpha: f64 = if faded { 0.0 } else { 1.0 };
        let _: () = unsafe { msg_send![view, setAlphaValue: alpha] };
    }
    ns.setHasShadow(!faded);
    if !faded {
        ns.invalidateShadow();
    }
    win.emit("garden-fade", faded).ok();
}

/// Called on the main thread every FADE_TICK_MS. The state is decided under the lock; the window, the emit, and the
/// log are touched after releasing it
#[cfg(target_os = "macos")]
fn fade_tick(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let Some(ns) = ns_window(&win) else { return };
    let visible = win.is_visible().unwrap_or(false);
    let (x, y, w, h, button_down) = cursor_in_window(ns);
    let inside = x >= 0.0 && y >= 0.0 && x <= w && y <= h;
    let change = {
        let mut fade = fade_state();
        let active = fade.wanted && current_mode() == WindowMode::Floating && visible;
        let revealed = if !active {
            false
        } else if fade.active {
            let on_bird = fade.birds.iter().any(|b| b.contains(x, y));
            next_revealed(fade.revealed, inside, on_bird, button_down)
        } else {
            // When the fade starts (e.g. back to the Garden tab), stay shown while the cursor is still in the window
            inside
        };
        let changed = active != fade.active || (active && revealed != fade.revealed);
        let resync = std::mem::take(&mut fade.resync);
        fade.active = active;
        fade.revealed = revealed;
        (changed || resync).then_some((active, revealed, changed))
    };
    let Some((active, revealed, changed)) = change else { return };
    apply_fade(&win, active && !revealed);
    if changed {
        append_log(&if active { format!("[fade] revealed={revealed}") } else { "[fade] off".to_string() });
    }
}

/// Watches the cursor while the fade is wanted. Hops to the main thread only then, since AppKit windows are
/// touched only there
#[cfg(target_os = "macos")]
pub(crate) fn start_fade_watch(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(FADE_TICK_MS));
        let busy = {
            let fade = fade_state();
            fade.wanted || fade.active || fade.resync
        };
        if busy {
            let h = handle.clone();
            handle.run_on_main_thread(move || fade_tick(&h)).ok();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fade until hovered (docs/design.md "Window mode"): a bird shows the window, only leaving the window fades it
    #[test]
    fn fade_reveals_on_a_bird_and_fades_only_after_leaving_the_window() {
        // At rest: moving inside the window but not on a bird keeps it faded
        assert!(!next_revealed(false, true, false, false));
        assert!(next_revealed(false, true, true, false));
        // Shown: moving off the bird within the window keeps it shown
        assert!(next_revealed(true, true, false, false));
        // Shown: leaving the window fades it, unless a button is held (resizing from the edge)
        assert!(!next_revealed(true, false, false, false));
        assert!(next_revealed(true, false, false, true));
        let bird = BirdRect { x: 10.0, y: 20.0, width: 40.0, height: 40.0 };
        assert!(bird.contains(10.0, 20.0));
        assert!(!bird.contains(50.0, 30.0));
    }
}
