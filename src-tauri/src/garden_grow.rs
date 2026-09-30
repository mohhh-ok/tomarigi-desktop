// Grows the floating window when the Garden's birds don't fit (docs/design.md "Layout"). The page decides how far (a
// scale of the user's size; src/perch/garden-grow.ts); this decides the direction, caps it at the display's visible
// area, and keeps the user's size apart from the grown one: the grown frame is never saved, and the Moved / Resized
// it causes are not taken for a manual move or resize.
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::append_log;
use crate::window::{current_mode, WindowMode};

/// Window frame in physical pixels (outer position, inner size; the same for the borderless floating window)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// One axis: where the window of length `len` at `start` starts once grown to `new_len`. Decided by which third of
/// the area (`area_start`, `area_len`) the window's center is in: the first third keeps the start edge, the last
/// third keeps the end edge, the middle keeps the center. Then kept inside the area
fn grow_axis(start: i32, len: u32, new_len: u32, area_start: i32, area_len: u32) -> i32 {
    let center = start as f64 + len as f64 / 2.0 - area_start as f64;
    let third = area_len as f64 / 3.0;
    let grow = new_len as i64 - len as i64;
    let pos = if center < third {
        start as i64
    } else if center > third * 2.0 {
        start as i64 - grow
    } else {
        start as i64 - grow / 2
    };
    let max = area_start as i64 + area_len as i64 - new_len as i64;
    pos.clamp(area_start as i64, max.max(area_start as i64)) as i32
}

/// The user's frame grown by `scale` (width and height by the same factor, keeping the aspect ratio), capped at the
/// visible area `area`. Never smaller than the user's frame: a scale ≤ 1, or a user frame already larger than the
/// area, returns the user's frame as is
pub(crate) fn grow_frame(user: Frame, scale: f64, area: Frame) -> Frame {
    if user.width == 0 || user.height == 0 {
        return user;
    }
    let max = (area.width as f64 / user.width as f64).min(area.height as f64 / user.height as f64);
    let s = scale.min(max);
    if !(s > 1.0) {
        return user;
    }
    let width = ((user.width as f64 * s).round() as u32).min(area.width);
    let height = ((user.height as f64 * s).round() as u32).min(area.height);
    Frame {
        x: grow_axis(user.x, user.width, width, area.x, area.width),
        y: grow_axis(user.y, user.height, height, area.y, area.height),
        width,
        height,
    }
}

struct Grown {
    /// The user's frame (what is saved, and what the window goes back to)
    user: Frame,
    /// The frame set by growing
    applied: Frame,
}

/// Some while the window is grown
static GROWN: Mutex<Option<Grown>> = Mutex::new(None);
/// Moved / Resized until this time come from growing or shrinking back (set_size and set_position each report
/// intermediate frames, so the exact frame can't be matched)
static AUTO_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
const AUTO_SETTLE_MS: u64 = 400;
/// The user's size last sent to the page (physical)
static SENT_USER_SIZE: Mutex<Option<(u32, u32)>> = Mutex::new(None);

fn current_frame(win: &WebviewWindow) -> Option<Frame> {
    let (pos, size) = (win.outer_position().ok()?, win.inner_size().ok()?);
    Some(Frame { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// The user's frame while grown (None when not grown)
pub(crate) fn grown_user_frame() -> Option<Frame> {
    GROWN.lock().unwrap().as_ref().map(|g| g.user)
}

/// Forgets the grown frame. Called when the mode switches: the frame saved just before is the user's, and it is what
/// gets restored
pub(crate) fn forget() {
    *GROWN.lock().unwrap() = None;
}

/// Handles Moved / Resized of the floating window. Returns false when it came from growing (don't save it).
/// A manual resize while grown makes the new frame the user's; a manual move moves the user's frame along
pub(crate) fn on_frame_changed(win: &WebviewWindow) -> bool {
    if current_mode() != WindowMode::Floating {
        return true;
    }
    if AUTO_UNTIL.lock().unwrap().is_some_and(|t| Instant::now() < t) {
        return false;
    }
    let Some(now) = current_frame(win) else { return true };
    let mut grown = GROWN.lock().unwrap();
    let Some(g) = grown.as_mut() else { return true };
    if now == g.applied {
        return false;
    }
    if (now.width, now.height) == (g.applied.width, g.applied.height) {
        g.user.x += now.x - g.applied.x;
        g.user.y += now.y - g.applied.y;
        g.applied = now;
    } else {
        append_log(&format!("[grow] manual resize while grown -> user {now:?}"));
        *grown = None;
    }
    true
}

/// The visible area (without the menu bar and the Dock) of the display the user's frame is on
fn visible_area(win: &WebviewWindow, user: Frame) -> Option<Frame> {
    let (cx, cy) = (user.x + user.width as i32 / 2, user.y + user.height as i32 / 2);
    let monitors = win.available_monitors().unwrap_or_default();
    let monitor = monitors
        .into_iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32
        })
        .or_else(|| win.current_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some(Frame { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height })
}

fn apply(app: &AppHandle, scale: f64) {
    let Some(win) = app.get_webview_window("main") else { return };
    if current_mode() != WindowMode::Floating {
        return;
    }
    let grown = GROWN.lock().unwrap().as_ref().map(|g| (g.user, g.applied));
    let Some((user, shown)) = grown.or_else(|| current_frame(&win).map(|f| (f, f))) else { return };
    let Some(area) = visible_area(&win, user) else { return };
    let target = grow_frame(user, scale, area);
    if target == shown {
        return;
    }
    // Set the state before moving the window: Moved / Resized can arrive while set_size / set_position run
    *AUTO_UNTIL.lock().unwrap() = Some(Instant::now() + Duration::from_millis(AUTO_SETTLE_MS));
    *GROWN.lock().unwrap() = (target != user).then_some(Grown { user, applied: target });
    win.set_size(tauri::PhysicalSize::new(target.width, target.height)).ok();
    win.set_position(tauri::PhysicalPosition::new(target.x, target.y)).ok();
    append_log(&format!("[grow] scale={scale} user={user:?} area={area:?} -> {target:?}"));
}

/// Grows the floating window to `scale` times the user's size (1 or less: back to the user's size)
#[tauri::command]
pub(crate) fn garden_fit(app: AppHandle, scale: f64) {
    let handle = app.clone();
    app.run_on_main_thread(move || apply(&handle, scale)).ok();
}

#[derive(Serialize, Clone, Copy)]
pub(crate) struct UserSize {
    /// CSS pixels
    width: f64,
    height: f64,
    manual: bool,
}

fn user_size(win: &WebviewWindow, manual: bool) -> Option<(UserSize, (u32, u32))> {
    let frame = grown_user_frame().or_else(|| current_frame(win))?;
    let scale = win.scale_factor().ok()?;
    let size = UserSize {
        width: frame.width as f64 / scale,
        height: frame.height as f64 / scale,
        manual,
    };
    Some((size, (frame.width, frame.height)))
}

/// The user's size of the floating window, for the page to compute the scale from
#[tauri::command]
pub(crate) fn window_user_size(app: AppHandle) -> Option<UserSize> {
    let win = app.get_webview_window("main")?;
    let (size, physical) = user_size(&win, false)?;
    *SENT_USER_SIZE.lock().unwrap() = Some(physical);
    Some(size)
}

/// Tells the page the user's size when it changed ("window-user-size"). manual: changed by a manual resize (the page
/// then waits for a bird to join before growing again)
pub(crate) fn notify_user_size(win: &WebviewWindow, manual: bool) {
    if current_mode() != WindowMode::Floating {
        return;
    }
    let Some((size, physical)) = user_size(win, manual) else { return };
    let mut sent = SENT_USER_SIZE.lock().unwrap();
    if *sent == Some(physical) {
        return;
    }
    *sent = Some(physical);
    append_log(&format!("[grow] user size {}x{} manual={manual}", size.width, size.height));
    win.app_handle().emit("window-user-size", size).ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 1440×900 display with a 25px menu bar and a 75px Dock (visible area 1440×800 from y=25)
    const AREA: Frame = Frame { x: 0, y: 25, width: 1440, height: 800 };

    #[test]
    fn bottom_right_grows_up_and_left() {
        let user = Frame { x: 1080, y: 505, width: 340, height: 300 };
        let f = grow_frame(user, 1.5, AREA);
        assert_eq!((f.width, f.height), (510, 450));
        // Right and bottom edges stay where they were
        assert_eq!(f.x + f.width as i32, user.x + user.width as i32);
        assert_eq!(f.y + f.height as i32, user.y + user.height as i32);
    }

    #[test]
    fn middle_grows_around_the_center() {
        let user = Frame { x: 550, y: 275, width: 340, height: 300 };
        let f = grow_frame(user, 1.5, AREA);
        assert_eq!((f.width, f.height), (510, 450));
        assert_eq!(f.x * 2 + f.width as i32, user.x * 2 + user.width as i32);
        assert_eq!(f.y * 2 + f.height as i32, user.y * 2 + user.height as i32);
    }

    #[test]
    fn top_left_grows_down_and_right() {
        let user = Frame { x: 20, y: 40, width: 340, height: 300 };
        let f = grow_frame(user, 1.5, AREA);
        assert_eq!(f, Frame { x: 20, y: 40, width: 510, height: 450 });
    }

    #[test]
    fn per_axis_right_and_top() {
        // Right third horizontally, top third vertically: keep the right edge and the top edge
        let user = Frame { x: 1080, y: 40, width: 340, height: 300 };
        let f = grow_frame(user, 1.2, AREA);
        assert_eq!(f.x + f.width as i32, 1420);
        assert_eq!(f.y, 40);
    }

    #[test]
    fn capped_at_the_visible_area_keeping_the_aspect_ratio() {
        let user = Frame { x: 1080, y: 505, width: 340, height: 400 };
        let f = grow_frame(user, 8.0, AREA);
        // Height hits 800 first (scale 2): width 680, still 340:400
        assert_eq!((f.width, f.height), (680, 800));
        assert_eq!(f.y, AREA.y);
        assert!(f.x >= AREA.x && f.x + f.width as i32 <= AREA.x + AREA.width as i32);
    }

    #[test]
    fn grown_frame_is_kept_inside_the_area() {
        // Center in the middle third but near the bottom: growing around the center would cross the Dock
        let user = Frame { x: 550, y: 40, width: 340, height: 780 };
        let f = grow_frame(user, 1.02, AREA);
        assert_eq!(f.height, 796);
        assert_eq!(f.y + f.height as i32, AREA.y + AREA.height as i32);
    }

    #[test]
    fn never_smaller_than_the_user_size() {
        let user = Frame { x: 1080, y: 505, width: 340, height: 300 };
        assert_eq!(grow_frame(user, 1.0, AREA), user);
        assert_eq!(grow_frame(user, 0.5, AREA), user);
        // A user frame larger than the visible area is left as is
        let big = Frame { x: 0, y: 0, width: 1600, height: 1000 };
        assert_eq!(grow_frame(big, 2.0, AREA), big);
    }
}
