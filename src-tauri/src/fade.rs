use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::append_log;
use crate::window::{current_mode, find_backdrop, ns_window, WindowMode};

// ---- Fade until hovered (docs/design.md "Fade until hovered") ----
// At rest the floating window's Garden shows only the birds and the window handle ("Tomarigi" in the header), and
// clicks go through to the window below (ignoresMouseEvents). The WebView then gets no mouse events, so the cursor is
// watched here: on a bird or the handle the window takes clicks while staying faded, and clicking the handle
// (reveal_garden) shows the whole window. garden-fade.ts sends the bird and handle rectangles and whether the fade
// applies, and receives "garden-fade" (true = faded) to fade the page itself

/// A bird's or the handle's rectangle in window content coordinates (CSS px = points, origin at the top left)
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
    handle: Option<BirdRect>,
    /// Whether the fade was in effect at the last tick (false in the standard window, while hidden, etc.)
    active: bool,
    /// Shown at full strength (the handle was clicked and the cursor hasn't left the window yet)
    revealed: bool,
    /// Taking clicks: shown, or faded with the cursor on a bird or the handle (or a drag started there still held)
    interactive: bool,
    /// Faded with the cursor on a bird (or a drag started on one still held): the page makes the handle stand out
    on_bird: bool,
    /// The handle was clicked; shown on the next tick
    reveal: bool,
    /// Emit the current state on the next tick even if it didn't change. The page may have lost it: reloaded
    /// (data-fade is gone while clicks still go through), enabled flipped off and on within a tick, or an emit
    /// arrived before the page's listener was registered
    resync: bool,
}

static FADE: Mutex<Fade> = Mutex::new(Fade {
    wanted: false,
    birds: Vec::new(),
    handle: None,
    active: false,
    revealed: false,
    interactive: false,
    on_bird: false,
    reveal: false,
    resync: false,
});
const FADE_TICK_MS: u64 = 50;

/// TOMARIGI_FADE_TEST (README): until then the cursor counts as inside the window, so a reveal stays without the
/// cursor being moved
static HOLD_INSIDE_UNTIL: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn holding_inside() -> bool {
    let until = *HOLD_INSIDE_UNTIL.lock().unwrap_or_else(|e| e.into_inner());
    until.is_some_and(|t| std::time::Instant::now() < t)
}

/// A panic while holding the lock mustn't leave the window stuck letting clicks through, so a poisoned lock is
/// still used
fn fade_state() -> std::sync::MutexGuard<'static, Fade> {
    FADE.lock().unwrap_or_else(|e| e.into_inner())
}

/// resync: garden-fade.ts sets it on its first call after mounting (after its listener is registered)
#[tauri::command]
pub(crate) fn set_garden_fade(
    enabled: bool,
    birds: Vec<BirdRect>,
    handle: Option<BirdRect>,
    resync: bool,
) {
    let mut fade = fade_state();
    if resync || fade.wanted != enabled {
        fade.resync = true;
    }
    fade.wanted = enabled;
    fade.birds = birds;
    fade.handle = handle;
}

/// The handle was clicked while faded (garden-fade.ts): show the whole window
#[tauri::command]
pub(crate) fn reveal_garden() {
    let mut fade = fade_state();
    if fade.active {
        fade.reveal = true;
    }
}

/// Next revealed state. Only a handle click shows the window; once shown, it stays until the cursor leaves the window
/// (kept while a mouse button is held, so resizing from the edge or dragging the window isn't cut off midway)
fn next_revealed(revealed: bool, reveal: bool, inside: bool, button_down: bool) -> bool {
    reveal || (revealed && (inside || button_down))
}

/// Next interactive state. Faded, the window takes clicks only with the cursor on a bird or the handle. A drag started
/// there keeps it until the button is released, even off them; a press that started elsewhere (e.g. in the window
/// below) doesn't turn it on
fn next_interactive(interactive: bool, revealed: bool, on_target: bool, button_down: bool) -> bool {
    revealed || if button_down { interactive } else { on_target }
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

/// Whether clicks go through (not on a bird or the handle at rest)
#[cfg(target_os = "macos")]
fn apply_click_through(win: &WebviewWindow, through: bool) {
    let Some(ns) = ns_window(win) else { return };
    ns.setIgnoresMouseEvents(through);
}

/// Faded: the frosted glass and shadow disappear. The rest of the page fades in CSS
#[cfg(target_os = "macos")]
fn apply_fade(win: &WebviewWindow, faded: bool) {
    use objc2::msg_send;
    let Some(ns) = ns_window(win) else { return };
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
    let inside = (x >= 0.0 && y >= 0.0 && x <= w && y <= h) || holding_inside();
    let change = {
        let mut fade = fade_state();
        let active = fade.wanted && current_mode() == WindowMode::Floating && visible;
        let reveal = std::mem::take(&mut fade.reveal);
        let revealed = if !active {
            false
        } else if fade.active {
            next_revealed(fade.revealed, reveal, inside, button_down)
        } else {
            // When the fade starts (e.g. back to the Garden tab), stay shown while the cursor is still in the window
            inside
        };
        let interactive = if !active {
            true
        } else {
            let on_target = fade.birds.iter().chain(fade.handle.iter()).any(|b| b.contains(x, y));
            next_interactive(fade.interactive, revealed, on_target, button_down)
        };
        let over_bird = fade.birds.iter().any(|b| b.contains(x, y));
        let on_bird = active && !revealed && if button_down { fade.on_bird } else { over_bird };
        let changed = active != fade.active || (active && revealed != fade.revealed);
        let bird_changed = on_bird != fade.on_bird;
        let through_changed = active != fade.active || interactive != fade.interactive;
        let resync = std::mem::take(&mut fade.resync);
        fade.active = active;
        fade.revealed = revealed;
        fade.interactive = interactive;
        fade.on_bird = on_bird;
        (changed || through_changed || bird_changed || resync)
            .then_some((active, revealed, interactive, on_bird, changed, through_changed, bird_changed, resync))
    };
    let Some((active, revealed, interactive, on_bird, changed, through_changed, bird_changed, resync)) = change else {
        return;
    };
    apply_click_through(&win, !interactive);
    // Taking clicks over a bird or the handle doesn't change how the window looks, so only a reveal or fade emits
    if changed || resync {
        apply_fade(&win, active && !revealed);
    }
    if bird_changed || resync {
        win.emit("garden-fade-bird", on_bird).ok();
    }
    if changed {
        append_log(&if active { format!("[fade] revealed={revealed}") } else { "[fade] off".to_string() });
    } else if through_changed && active && !revealed {
        append_log(&format!("[fade] clicks={}", if interactive { "on" } else { "through" }));
    }
}

/// Watches the cursor while the fade is wanted. Hops to the main thread only then, since AppKit windows are
/// touched only there
#[cfg(target_os = "macos")]
pub(crate) fn start_fade_watch(app: &AppHandle) {
    // Self-test: 4 seconds after launch, reveal as a handle click would, and keep it shown for 6 seconds as if the
    // cursor were in the window (for screenshots of both states without moving the cursor)
    if std::env::var("TOMARIGI_FADE_TEST").is_ok() {
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(4));
            *HOLD_INSIDE_UNTIL.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(std::time::Instant::now() + std::time::Duration::from_secs(6));
            append_log("[fade-test] reveal");
            reveal_garden();
        });
    }
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

    /// Fade until hovered (docs/design.md "Fade until hovered"): only a handle click shows the window, only leaving the
    /// window fades it
    #[test]
    fn fade_reveals_on_a_handle_click_and_fades_only_after_leaving_the_window() {
        // At rest: moving inside the window, on a bird or not, keeps it faded
        assert!(!next_revealed(false, false, true, false));
        assert!(next_revealed(false, true, true, false));
        // Shown: moving within the window keeps it shown
        assert!(next_revealed(true, false, true, false));
        // Shown: leaving the window fades it, unless a button is held (resizing from the edge)
        assert!(!next_revealed(true, false, false, false));
        assert!(next_revealed(true, false, false, true));
        let bird = BirdRect { x: 10.0, y: 20.0, width: 40.0, height: 40.0 };
        assert!(bird.contains(10.0, 20.0));
        assert!(!bird.contains(50.0, 30.0));
    }

    /// Faded, clicks are taken on a bird or the handle only, and a drag started there keeps them until released
    #[test]
    fn faded_window_takes_clicks_only_on_a_bird_or_the_handle() {
        assert!(!next_interactive(false, false, false, false));
        assert!(next_interactive(false, false, true, false));
        // Dragging off the bird or handle keeps clicks until the button is released
        assert!(next_interactive(true, false, false, true));
        assert!(!next_interactive(true, false, false, false));
        // A press that started elsewhere doesn't take clicks when it passes over a bird
        assert!(!next_interactive(false, false, true, true));
        // Shown: the whole window takes clicks
        assert!(next_interactive(false, true, false, false));
    }
}
