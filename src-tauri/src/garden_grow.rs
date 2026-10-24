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

/// Which edge of an axis stays put when the window grows or shrinks back
#[derive(Clone, Copy, PartialEq, Debug)]
enum Keep {
    Start,
    Center,
    End,
}

/// Decided by which third of the area (`area_start`, `area_len`) the window's center is in: the first third keeps the
/// start edge, the last third keeps the end edge, the middle keeps the center
fn keep_of(start: i32, len: u32, area_start: i32, area_len: u32) -> Keep {
    let center = start as f64 + len as f64 / 2.0 - area_start as f64;
    let third = area_len as f64 / 3.0;
    if center < third {
        Keep::Start
    } else if center > third * 2.0 {
        Keep::End
    } else {
        Keep::Center
    }
}

/// One axis: where the window of length `len` at `start` starts once grown to `new_len` (keep_of decides which edge
/// stays). Then kept inside the area
fn grow_axis(start: i32, len: u32, new_len: u32, area_start: i32, area_len: u32) -> i32 {
    place_axis(start, len, new_len, keep_of(start, len, area_start, area_len), area_start, area_len)
}

/// One axis: where the window of length `len` at `start` starts once resized to `new_len`, keeping `keep`. Then kept
/// inside the area
fn place_axis(start: i32, len: u32, new_len: u32, keep: Keep, area_start: i32, area_len: u32) -> i32 {
    let grow = new_len as i64 - len as i64;
    let pos = match keep {
        Keep::Start => start as i64,
        Keep::End => start as i64 - grow,
        Keep::Center => start as i64 - grow / 2,
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

/// The garden's edges inside the window (physical px from each window edge)
#[derive(Clone, Copy, Debug)]
pub(crate) struct Insets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// While a bird or block is dragged (docs/design.md "Layout"): the frame `cur` grown on each axis where the pointer
/// (physical, on screen) is within `band` of the garden's edge or past it, toward that edge only, so the garden's edge
/// ends up `band` past the pointer. The other edge of the axis stays. Capped at the visible area `area`
pub(crate) fn drag_grow_frame(cur: Frame, pointer: (f64, f64), insets: Insets, band: f64, area: Frame) -> Frame {
    let axis = |start: i32, len: u32, p: f64, lo_in: f64, hi_in: f64, area_start: i32, area_len: u32| {
        let (start, end) = (start as f64, start as f64 + len as f64);
        let (area_start, area_end) = (area_start as f64, area_start as f64 + area_len as f64);
        let (garden_lo, garden_hi) = (start + lo_in, end - hi_in);
        let (start, end) = if p > garden_hi - band {
            (start, end.max((p + band + hi_in).min(area_end)))
        } else if p < garden_lo + band {
            (start.min((p - band - lo_in).max(area_start)), end)
        } else {
            (start, end)
        };
        (start.round() as i32, (end - start).round() as u32)
    };
    let (x, width) = axis(cur.x, cur.width, pointer.0, insets.left, insets.right, area.x, area.width);
    let (y, height) = axis(cur.y, cur.height, pointer.1, insets.top, insets.bottom, area.y, area.height);
    Frame { x, y, width, height }
}

/// Which part of the window stayed put when `cur` became `grown` by drag_grow_frame, per axis (as GrowAnchor): the
/// right / bottom edge when it grew left / up, otherwise the left / top edge
pub(crate) fn drag_anchor(cur: Frame, grown: Frame) -> (f64, f64) {
    (if grown.x < cur.x { 1.0 } else { 0.0 }, if grown.y < cur.y { 1.0 } else { 0.0 })
}

/// For a bubble above its bird's name past the garden's top (docs/design.md "Layout"): the frame `cur` grown up by `up`
/// (physical px), the bottom edge staying, capped at the visible area `area`. Used for a window in the display's upper
/// part, which grows to fit keeping its top edge; like a drag pushing the top edge
pub(crate) fn bubble_grow_frame(cur: Frame, up: u32, area: Frame) -> Frame {
    let y = (cur.y as i64 - up as i64).max(area.y as i64).min(cur.y as i64) as i32;
    Frame { y, height: cur.height + (cur.y - y) as u32, ..cur }
}

/// "Concierge only" (docs/design.md "Concierge"): the frame `cur` resized to `width` × `height` (physical px) toward the
/// edges it sits near, decided per axis by the display's thirds as for growing (keep_of), kept inside the visible area
/// `area`. Used both to shrink the window to the concierge and to fit it again when its bubble changes
pub(crate) fn compact_frame(cur: Frame, width: u32, height: u32, area: Frame) -> Frame {
    let (width, height) = (width.min(area.width), height.min(area.height));
    Frame {
        x: grow_axis(cur.x, cur.width, width, area.x, area.width),
        y: grow_axis(cur.y, cur.height, height, area.y, area.height),
        width,
        height,
    }
}

/// The user's frame, what is saved and what the user's size is measured from. While "Concierge only" is on
/// (`compact`: the frame just before it and, if the window was grown then, the user's frame of that growth), it is the
/// frame from before it, so the compact frame is never saved; otherwise the user's frame while grown (`grown_user`)
pub(crate) fn user_frame_of(compact: Option<(Frame, Option<Frame>)>, grown_user: Option<Frame>) -> Option<Frame> {
    match compact {
        Some((before, before_user)) => Some(before_user.unwrap_or(before)),
        None => grown_user,
    }
}

/// Whether a resize to `scale` shrinks the window: the scale went down (birds left), or the user dropped a bird or block
/// (the page then asks for the smallest scale at which everything stays put, which may be the same scale as before)
pub(crate) fn shrinking(scale: f64, last_scale: f64, drop: bool) -> bool {
    drop || scale < last_scale
}

/// The frame for growing to fit at `scale` (grow_frame). After a drag grew the window (`dragged`, the frame it left),
/// the dragged size stays while growing (a bird joining doesn't take back the room the user pulled out), and when
/// shrinking each axis goes to the fitted size but never above the dragged one (shrinking doesn't grow the other axis;
/// what fits unmoved at both sizes fits at the smaller of each). Either way it is resized from the dragged frame keeping
/// the edge the page expects (keep_of the user's frame, as garden_grow_anchor tells it), so the birds on screen stay at
/// the same place on screen
pub(crate) fn fit_frame(user: Frame, scale: f64, area: Frame, dragged: Option<Frame>, shrink: bool) -> Frame {
    let fit = grow_frame(user, scale, area);
    let Some(d) = dragged else { return fit };
    let (width, height) = if shrink {
        (fit.width.min(d.width).max(user.width), fit.height.min(d.height).max(user.height))
    } else {
        (fit.width.max(d.width), fit.height.max(d.height))
    };
    Frame {
        x: place_axis(d.x, d.width, width, keep_of(user.x, user.width, area.x, area.width), area.x, area.width),
        y: place_axis(d.y, d.height, height, keep_of(user.y, user.height, area.y, area.height), area.y, area.height),
        width,
        height,
    }
}

struct Grown {
    /// The user's frame (what is saved, and what the window goes back to)
    user: Frame,
    /// The frame set by growing
    applied: Frame,
    /// A drag grew the window (drag_grow_frame) since it was last grown to fit
    dragged: bool,
}

/// Some while the window is grown
static GROWN: Mutex<Option<Grown>> = Mutex::new(None);
/// Moved / Resized until this time come from growing or shrinking back (set_size and set_position each report
/// intermediate frames, so the exact frame can't be matched)
static AUTO_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
const AUTO_SETTLE_MS: u64 = 400;
/// The user's size last sent to the page (physical)
static SENT_USER_SIZE: Mutex<Option<(u32, u32)>> = Mutex::new(None);
/// The scale the page last asked for (garden_fit), to tell growing from shrinking back after a drag (fit_frame)
static LAST_SCALE: Mutex<f64> = Mutex::new(1.0);
/// While a drag grows the window: the part of the window that stays put (garden_grow_anchor tells the page this one)
static DRAG_ANCHOR: Mutex<Option<GrowAnchor>> = Mutex::new(None);
/// While "Concierge only" shrinks the floating window: the frame it had just before, and the growth it had then, both
/// put back as they were when it ends, so every bird comes back at the same place on screen
struct Compact {
    before: Frame,
    grown: Option<Grown>,
}
static COMPACT: Mutex<Option<Compact>> = Mutex::new(None);
/// How far past the pointer a drag pulls the garden's edge, and how close the pointer must come to it (CSS px)
const DRAG_BAND_PX: f64 = 24.0;

fn current_frame(win: &WebviewWindow) -> Option<Frame> {
    let (pos, size) = (win.outer_position().ok()?, win.inner_size().ok()?);
    Some(Frame { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// The user's frame while grown or while "Concierge only" shrinks the window (user_frame_of; None when neither)
pub(crate) fn grown_user_frame() -> Option<Frame> {
    let compact = COMPACT.lock().unwrap().as_ref().map(|c| (c.before, c.grown.as_ref().map(|g| g.user)));
    user_frame_of(compact, GROWN.lock().unwrap().as_ref().map(|g| g.user))
}

/// Forgets the grown frame, and the frame from before "Concierge only". Called when the mode switches: the frame saved
/// just before is the user's, and it is what gets restored
pub(crate) fn forget() {
    *GROWN.lock().unwrap() = None;
    *COMPACT.lock().unwrap() = None;
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
    // "Concierge only": the window goes back to the frame from before it when it ends, so a move or resize meanwhile is
    // neither saved nor taken for the user's size
    if COMPACT.lock().unwrap().is_some() {
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

/// The main window while growing applies to it: floating, and "Concierge only" not shrinking it (nothing grows it then)
fn growable_window(app: &AppHandle) -> Option<WebviewWindow> {
    let win = app.get_webview_window("main")?;
    (current_mode() == WindowMode::Floating && COMPACT.lock().unwrap().is_none()).then_some(win)
}

fn apply(app: &AppHandle, scale: f64, drop: bool) {
    let Some(win) = growable_window(app) else { return };
    let grown = GROWN.lock().unwrap().as_ref().map(|g| (g.user, g.applied, g.dragged));
    let Some((user, shown, dragged)) = grown.or_else(|| current_frame(&win).map(|f| (f, f, false))) else { return };
    let Some(area) = visible_area(&win, user) else { return };
    let last = std::mem::replace(&mut *LAST_SCALE.lock().unwrap(), scale);
    let target = fit_frame(user, scale, area, dragged.then_some(shown), shrinking(scale, last, drop));
    if target == shown {
        return;
    }
    // Back at the user's size after a drag moved an edge: the user's frame is where the window now is
    let user = if (target.width, target.height) == (user.width, user.height) { target } else { user };
    set_frame(&win, Grown { user, applied: target, dragged });
    append_log(&format!("[grow] scale={scale} drop={drop} user={user:?} area={area:?} dragged={dragged} -> {target:?}"));
}

/// Moves the window to `grown.applied`, remembering it as grown unless it is the user's frame
fn set_frame(win: &WebviewWindow, grown: Grown) {
    let target = grown.applied;
    *GROWN.lock().unwrap() = (target != grown.user).then_some(grown);
    move_window(win, target);
}

/// Moves the window to `target`, the Moved / Resized it causes not taken for a manual move or resize (AUTO_UNTIL). Set
/// the other state before calling it: Moved / Resized can arrive while set_size / set_position run
fn move_window(win: &WebviewWindow, target: Frame) {
    *AUTO_UNTIL.lock().unwrap() = Some(Instant::now() + Duration::from_millis(AUTO_SETTLE_MS));
    win.set_size(tauri::PhysicalSize::new(target.width, target.height)).ok();
    win.set_position(tauri::PhysicalPosition::new(target.x, target.y)).ok();
}

/// Runs `f` on the main thread and waits up to 2 seconds for what it returns (None when it couldn't run or timed out)
fn on_main_thread<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&AppHandle) -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || tx.send(f(&handle)).unwrap_or_default()).ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok()
}

fn drag_grow(app: &AppHandle, pointer: (f64, f64), insets: Insets) {
    let Some(win) = growable_window(app) else { return };
    let Some(scale) = win.scale_factor().ok() else { return };
    let grown = GROWN.lock().unwrap().as_ref().map(|g| (g.user, g.applied));
    let Some((user, shown)) = grown.or_else(|| current_frame(&win).map(|f| (f, f))) else { return };
    let Some(area) = visible_area(&win, user) else { return };
    let physical = Insets {
        left: insets.left * scale,
        top: insets.top * scale,
        right: insets.right * scale,
        bottom: insets.bottom * scale,
    };
    let target = drag_grow_frame(shown, (pointer.0 * scale, pointer.1 * scale), physical, DRAG_BAND_PX * scale, area);
    if target == shown {
        return;
    }
    let (x, y) = drag_anchor(shown, target);
    *DRAG_ANCHOR.lock().unwrap() = Some(GrowAnchor { x, y });
    set_frame(&win, Grown { user, applied: target, dragged: true });
    append_log(&format!("[grow] drag pointer={pointer:?} user={user:?} {shown:?} -> {target:?}"));
}

/// Grows the window up by `top` CSS px (bubble_grow_frame). Returns whether it was resized
fn bubble_grow(app: &AppHandle, top: f64) -> bool {
    let Some(win) = growable_window(app) else { return false };
    let Some(scale) = win.scale_factor().ok() else { return false };
    let grown = GROWN.lock().unwrap().as_ref().map(|g| (g.user, g.applied));
    let Some((user, shown)) = grown.or_else(|| current_frame(&win).map(|f| (f, f))) else { return false };
    let Some(area) = visible_area(&win, user) else { return false };
    let target = bubble_grow_frame(shown, (top * scale).ceil().max(0.0) as u32, area);
    if target == shown {
        return false;
    }
    set_frame(&win, Grown { user, applied: target, dragged: true });
    append_log(&format!("[grow] bubble up={top} user={user:?} {shown:?} -> {target:?}"));
    true
}

/// A bubble above its bird's name reaches past the garden's top in a window in the display's upper part: grows the
/// window up by `top` CSS px, the bottom edge staying (docs/design.md "Layout"). Returns whether it was resized; the
/// page keeps its birds at the same place on screen with anchor y 1 until the resize arrives
#[tauri::command]
pub(crate) async fn garden_bubble_grow(app: AppHandle, top: f64) -> bool {
    on_main_thread(&app, move |app| bubble_grow(app, top)).unwrap_or(false)
}

/// While a bird or block is dragged: grows the floating window toward the garden's edge the pointer is near or past
/// (drag_grow_frame). x, y: the pointer on screen; left..bottom: the garden's edges inside the window (CSS px)
#[tauri::command]
pub(crate) fn garden_drag_grow(app: AppHandle, x: f64, y: f64, left: f64, top: f64, right: f64, bottom: f64) {
    let handle = app.clone();
    app.run_on_main_thread(move || drag_grow(&handle, (x, y), Insets { left, top, right, bottom })).ok();
}

/// The drag ended: the next resizes keep the edges garden_grow_anchor tells from the user's frame again
#[tauri::command]
pub(crate) fn garden_drag_end() {
    *DRAG_ANCHOR.lock().unwrap() = None;
}

/// Grows the floating window to `scale` times the user's size (1 or less: back to the user's size). drop: the user just
/// dropped a bird or block, and `scale` is the smallest at which everything stays put (shrinks a dragged window too)
#[tauri::command]
pub(crate) fn garden_fit(app: AppHandle, scale: f64, drop: Option<bool>) {
    let handle = app.clone();
    app.run_on_main_thread(move || apply(&handle, scale, drop.unwrap_or(false))).ok();
}

/// The window's smallest size (tauri.conf.json), so the compact frame is placed for the size the window really gets
fn min_size(app: &AppHandle, scale: f64) -> (u32, u32) {
    let w = app.config().app.windows.first();
    let css = |v: Option<f64>| (v.unwrap_or(0.0) * scale).round() as u32;
    (css(w.and_then(|w| w.min_width)), css(w.and_then(|w| w.min_height)))
}

fn concierge_only_apply(app: &AppHandle, width: f64, height: f64) {
    let Some(win) = app.get_webview_window("main") else { return };
    if current_mode() != WindowMode::Floating {
        return;
    }
    let (Some(shown), Ok(scale)) = (current_frame(&win), win.scale_factor()) else { return };
    let Some(area) = visible_area(&win, shown) else { return };
    let (min_w, min_h) = min_size(app, scale);
    let size = |css: f64, min: u32| ((css * scale).ceil().max(0.0) as u32).max(min);
    let target = compact_frame(shown, size(width, min_w), size(height, min_h), area);
    let mut compact = COMPACT.lock().unwrap();
    if compact.is_none() {
        // The growth is put back with the frame when it ends; meanwhile nothing grows the window
        *compact = Some(Compact { before: shown, grown: GROWN.lock().unwrap().take() });
        append_log(&format!("[concierge-only] on from {shown:?}"));
    }
    drop(compact);
    if target == shown {
        return;
    }
    move_window(&win, target);
    append_log(&format!("[concierge-only] fit {width}x{height} {shown:?} -> {target:?}"));
}

/// "Concierge only" is on in the floating window's Garden: shrinks the window to `width` × `height` CSS px (what the
/// concierge and its bubble need, with the window's room around the garden) toward the edges it sits near
/// (compact_frame). The first call remembers the frame from before it; later calls fit a changed bubble the same way
#[tauri::command]
pub(crate) fn concierge_only_fit(app: AppHandle, width: f64, height: f64) {
    let handle = app.clone();
    app.run_on_main_thread(move || concierge_only_apply(&handle, width, height)).ok();
}

/// The window's inner size in CSS px
#[derive(Serialize)]
pub(crate) struct InnerSize {
    width: f64,
    height: f64,
}

fn concierge_only_restore(app: &AppHandle) -> Option<InnerSize> {
    let compact = COMPACT.lock().unwrap().take()?;
    let win = app.get_webview_window("main")?;
    let before = compact.before;
    *GROWN.lock().unwrap() = compact.grown;
    move_window(&win, before);
    append_log(&format!("[concierge-only] off -> {before:?}"));
    let scale = win.scale_factor().ok()?;
    Some(InnerSize { width: before.width as f64 / scale, height: before.height as f64 / scale })
}

/// "Concierge only" ended, or left the floating window's Garden: puts the window back to the exact frame and growth it
/// had just before it. Returns the inner size it goes back to, for the page to wait for before showing the birds
/// again (None when it wasn't shrunk)
#[tauri::command]
pub(crate) async fn concierge_only_end(app: AppHandle) -> Option<InnerSize> {
    on_main_thread(&app, concierge_only_restore).flatten()
}

/// Which part of the window stays put on screen when it grows or shrinks back, per axis: 0 the left / top edge, 1 the
/// right / bottom edge, 0.5 the center. The page keeps the Garden's birds at the same place on screen with it
#[derive(Serialize, Clone, Copy)]
pub(crate) struct GrowAnchor {
    x: f64,
    y: f64,
}

/// GrowAnchor, with how far the window can grow up for a bubble (garden_bubble_grow): CSS px from the window's top to
/// the visible area's top
#[derive(Serialize)]
pub(crate) struct GrowAnchorRoom {
    #[serde(flatten)]
    anchor: GrowAnchor,
    above: f64,
}

fn anchor_value(keep: Keep) -> f64 {
    match keep {
        Keep::Start => 0.0,
        Keep::Center => 0.5,
        Keep::End => 1.0,
    }
}

/// The anchor the next grow_frame of the user's frame uses (the page asks before each garden_fit)
#[tauri::command]
pub(crate) fn garden_grow_anchor(app: AppHandle) -> Option<GrowAnchorRoom> {
    let win = app.get_webview_window("main")?;
    let shown = current_frame(&win)?;
    let user = grown_user_frame().unwrap_or(shown);
    let area = visible_area(&win, user)?;
    let above = (shown.y - area.y).max(0) as f64 / win.scale_factor().ok()?;
    let anchor = DRAG_ANCHOR.lock().unwrap().unwrap_or(GrowAnchor {
        x: anchor_value(keep_of(user.x, user.width, area.x, area.width)),
        y: anchor_value(keep_of(user.y, user.height, area.y, area.height)),
    });
    Some(GrowAnchorRoom { anchor, above })
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
    fn anchor_the_page_gets_matches_the_edge_that_stays() {
        // The page keeps the Garden's birds on screen with this (garden_grow_anchor)
        let right_bottom = Frame { x: 1080, y: 505, width: 340, height: 300 };
        assert_eq!(keep_of(right_bottom.x, right_bottom.width, AREA.x, AREA.width), Keep::End);
        assert_eq!(keep_of(right_bottom.y, right_bottom.height, AREA.y, AREA.height), Keep::End);
        let middle = Frame { x: 550, y: 275, width: 340, height: 300 };
        assert_eq!(keep_of(middle.x, middle.width, AREA.x, AREA.width), Keep::Center);
        let top_left = Frame { x: 20, y: 40, width: 340, height: 300 };
        assert_eq!(keep_of(top_left.y, top_left.height, AREA.y, AREA.height), Keep::Start);
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

    // Garden edges inside the window (physical px): header and tabs above, padding around
    const INSETS: Insets = Insets { left: 20.0, top: 100.0, right: 20.0, bottom: 20.0 };
    const BAND: f64 = 48.0;

    #[test]
    fn dragging_near_the_right_edge_grows_right_only() {
        let cur = Frame { x: 100, y: 100, width: 680, height: 600 };
        // The garden's right edge is at 760; the pointer is 10px inside it
        let f = drag_grow_frame(cur, (750.0, 300.0), INSETS, BAND, AREA);
        assert_eq!((f.x, f.y, f.height), (100, 100, 600));
        // The garden's right edge goes BAND past the pointer
        assert_eq!(f.x + f.width as i32 - 20, 750 + 48);
        assert_eq!(drag_anchor(cur, f), (0.0, 0.0));
    }

    #[test]
    fn dragging_past_the_left_edge_grows_left_keeping_the_right_edge() {
        let cur = Frame { x: 400, y: 100, width: 680, height: 600 };
        let f = drag_grow_frame(cur, (380.0, 300.0), INSETS, BAND, AREA);
        assert_eq!(f.x + f.width as i32, 1080);
        assert_eq!(f.x + 20, 380 - 48);
        assert_eq!((f.y, f.height), (100, 600));
        assert_eq!(drag_anchor(cur, f).0, 1.0);
    }

    #[test]
    fn dragging_near_the_top_grows_up_keeping_the_bottom_edge() {
        let cur = Frame { x: 100, y: 300, width: 680, height: 400 };
        // The garden's top edge is at 400
        let f = drag_grow_frame(cur, (300.0, 420.0), INSETS, BAND, AREA);
        assert_eq!(f.y + f.height as i32, 700);
        assert_eq!(f.y + 100, 420 - 48);
        assert_eq!(drag_anchor(cur, f), (0.0, 1.0));
    }

    #[test]
    fn dragging_in_the_middle_of_the_garden_doesnt_grow() {
        let cur = Frame { x: 100, y: 100, width: 680, height: 600 };
        assert_eq!(drag_grow_frame(cur, (400.0, 400.0), INSETS, BAND, AREA), cur);
    }

    #[test]
    fn dragging_grows_up_to_the_visible_area() {
        let cur = Frame { x: 700, y: 300, width: 680, height: 500 };
        // Near the bottom-right corner, far past the display
        let f = drag_grow_frame(cur, (1500.0, 900.0), INSETS, BAND, AREA);
        assert_eq!(f.x + f.width as i32, AREA.x + AREA.width as i32);
        assert_eq!(f.y + f.height as i32, AREA.y + AREA.height as i32);
        assert_eq!((f.x, f.y), (700, 300));
    }

    #[test]
    fn growing_to_fit_after_a_drag_keeps_the_dragged_size() {
        // Top-left window (keeps its top-left when growing to fit), grown 300px to the right by a drag
        let user = Frame { x: 20, y: 40, width: 340, height: 300 };
        let dragged = Frame { x: 20, y: 40, width: 640, height: 300 };
        let f = fit_frame(user, 1.2, AREA, Some(dragged), false);
        // Width stays at the dragged 640 (the fit asks for 408), height grows to the fit's 360
        assert_eq!(f, Frame { x: 20, y: 40, width: 640, height: 360 });
        // Without a drag, as before
        assert_eq!(fit_frame(user, 1.2, AREA, None, false), grow_frame(user, 1.2, AREA));
    }

    #[test]
    fn shrinking_after_a_drag_keeps_the_edge_the_page_expects() {
        // Top-left window grown 300px to the left by a drag (its right edge stayed). Birds leave: back to the user's
        // size, keeping the left edge as the page's anchor (keep_of the user's frame) says, not jumping to the user's x
        let user = Frame { x: 300, y: 40, width: 340, height: 300 };
        let dragged = Frame { x: 0, y: 40, width: 640, height: 300 };
        assert_eq!(keep_of(user.x, user.width, AREA.x, AREA.width), Keep::Start);
        let f = fit_frame(user, 1.0, AREA, Some(dragged), true);
        assert_eq!(f, Frame { x: 0, y: 40, width: 340, height: 300 });
    }

    #[test]
    fn a_drop_shrinks_a_dragged_window_without_growing_the_other_axis() {
        // Grown 300px to the right by a drag; on the drop the page finds everything stays put from scale 1.6 (544×480).
        // The width shrinks to 544, and the height stays 300 rather than growing to 480
        let user = Frame { x: 20, y: 40, width: 340, height: 300 };
        let dragged = Frame { x: 20, y: 40, width: 640, height: 300 };
        assert_eq!(fit_frame(user, 1.6, AREA, Some(dragged), true), Frame { x: 20, y: 40, width: 544, height: 300 });
    }

    #[test]
    fn a_drop_is_a_shrink_even_at_the_same_scale() {
        // The page sent scale 1 before the drag and sends 1 again on the drop: the window still goes back
        assert!(shrinking(1.0, 1.0, true));
        assert!(shrinking(1.0, 1.2, false));
        assert!(!shrinking(1.0, 1.0, false));
    }

    #[test]
    fn a_bubble_above_grows_a_window_in_the_upper_part_upward_only() {
        // A window in the display's top third keeps its top edge when growing to fit, but a bubble above its bird's
        // name past the garden's top grows it up by what the bubble needs, the bottom edge staying
        let cur = Frame { x: 100, y: 120, width: 680, height: 200 };
        assert_eq!(keep_of(cur.y, cur.height, AREA.y, AREA.height), Keep::Start);
        assert_eq!(bubble_grow_frame(cur, 12, AREA), Frame { x: 100, y: 108, width: 680, height: 212 });
    }

    #[test]
    fn a_bubble_above_grows_up_to_the_visible_area() {
        let cur = Frame { x: 100, y: 35, width: 680, height: 400 };
        assert_eq!(bubble_grow_frame(cur, 40, AREA), Frame { x: 100, y: 25, width: 680, height: 410 });
        // Already at the top: nothing to grow
        let top = Frame { y: 25, ..cur };
        assert_eq!(bubble_grow_frame(top, 40, AREA), top);
    }

    #[test]
    fn shrinking_after_a_bubble_grew_the_window_up_keeps_the_top_edge() {
        // Grown 12px up for a bubble from the user's frame in the top third, then a bird leaves: back to the user's
        // size from the bottom, the top edge where the bubble left it (the page shrinks with anchor y 0)
        let user = Frame { x: 100, y: 120, width: 680, height: 200 };
        assert_eq!(keep_of(user.y, user.height, AREA.y, AREA.height), Keep::Start);
        let up = bubble_grow_frame(user, 12, AREA);
        assert_eq!(fit_frame(user, 1.0, AREA, Some(up), true), Frame { x: 100, y: 108, width: 680, height: 200 });
        // Growing to fit afterwards keeps the grown height and the top edge
        assert_eq!(fit_frame(user, 1.0, AREA, Some(up), false), up);
    }

    #[test]
    fn concierge_only_shrinks_toward_the_edges_it_sits_near() {
        // Bottom right: the right and bottom edges stay
        let br = Frame { x: 1080, y: 505, width: 340, height: 300 };
        let f = compact_frame(br, 260, 220, AREA);
        assert_eq!(f, Frame { x: 1160, y: 585, width: 260, height: 220 });
        // Top left: the left and top edges stay
        let tl = Frame { x: 20, y: 40, width: 340, height: 300 };
        assert_eq!(compact_frame(tl, 260, 220, AREA), Frame { x: 20, y: 40, width: 260, height: 220 });
        // Middle: the center stays
        let mid = Frame { x: 550, y: 275, width: 340, height: 300 };
        assert_eq!(compact_frame(mid, 260, 220, AREA), Frame { x: 590, y: 315, width: 260, height: 220 });
        // A longer bubble grows it the same way, from the compact frame
        let grown = compact_frame(f, 260, 300, AREA);
        assert_eq!(grown, Frame { x: 1160, y: 505, width: 260, height: 300 });
    }

    #[test]
    fn concierge_only_keeps_inside_the_visible_area() {
        let low = Frame { x: 1300, y: 700, width: 140, height: 125 };
        let f = compact_frame(low, 260, 400, AREA);
        assert!(f.x + f.width as i32 <= AREA.x + AREA.width as i32);
        assert!(f.y + f.height as i32 <= AREA.y + AREA.height as i32);
    }

    #[test]
    fn concierge_only_saves_the_frame_from_before_it() {
        let before = Frame { x: 1080, y: 505, width: 340, height: 300 };
        let user = Frame { x: 1100, y: 505, width: 320, height: 280 };
        // While on, what is saved is the frame from before it, or the user's frame if it was grown then
        assert_eq!(user_frame_of(Some((before, None)), None), Some(before));
        assert_eq!(user_frame_of(Some((before, Some(user))), None), Some(user));
        // Off: the user's frame while grown, as before
        assert_eq!(user_frame_of(None, Some(user)), Some(user));
        assert_eq!(user_frame_of(None, None), None);
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
