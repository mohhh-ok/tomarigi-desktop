// Linux (docs/design.md "Platforms"): processes come from /proc. A tmux pane is selected the same way as on macOS
// (tmux.rs); otherwise only the terminal window is brought to the front: the X11 window whose _NET_WM_PID is the
// nearest ancestor of the agent, through _NET_ACTIVE_WINDOW (EWMH). Tabs and panes inside the terminal can't be
// addressed. On a Wayland session only Xwayland windows are visible here, so a native Wayland terminal is not found
use std::collections::HashMap;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, Window, CLIENT_MESSAGE_EVENT,
};

use super::{ancestors, tmux, FocusLevel, FocusResult, Proc};

/// From /proc/<pid>/stat: (ppid, tty_nr). The command name in parentheses may contain spaces and parentheses, so
/// the fields are read after the last ")"
pub(super) fn parse_stat(stat: &str) -> Option<(u32, u32)> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    // state, ppid, pgrp, session, tty_nr
    let _state = fields.next()?;
    let ppid = fields.next()?.parse().ok()?;
    let tty_nr = fields.nth(2)?.parse::<i64>().ok()?;
    Some((ppid, tty_nr as u32))
}

/// The tty name (as ps shows it, without /dev/) of a tty_nr: pseudo terminals are majors 136–143 (`pts/N`), virtual
/// consoles major 4 below minor 64 (`ttyN`). None when the process has no terminal
pub(super) fn tty_name(tty_nr: u32) -> Option<String> {
    if tty_nr == 0 {
        return None;
    }
    let major = (tty_nr >> 8) & 0xfff;
    let minor = (tty_nr & 0xff) | ((tty_nr >> 12) & 0xfff00);
    match major {
        136..=143 => Some(format!("pts/{}", (major - 136) * 256 + minor)),
        4 if minor < 64 => Some(format!("tty{minor}")),
        _ => None,
    }
}

/// Every process this user can see. comm is the executable path (`/proc/<pid>/exe`), or the short name when that
/// can't be read (other users' processes)
pub(super) fn snapshot() -> Option<HashMap<u32, Proc>> {
    let mut procs = HashMap::new();
    for item in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = item.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(item.path().join("stat")) else { continue };
        let Some((ppid, tty_nr)) = parse_stat(&stat) else { continue };
        let comm = std::fs::read_link(item.path().join("exe"))
            .map(|p| p.to_string_lossy().trim_end_matches(" (deleted)").to_string())
            .or_else(|_| std::fs::read_to_string(item.path().join("comm")).map(|c| c.trim().to_string()))
            .unwrap_or_default();
        procs.insert(pid, Proc { pid, ppid, tty: tty_name(tty_nr).unwrap_or_else(|| "?".into()), comm });
    }
    Some(procs)
}

/// The window to bring forward: among the windows whose _NET_WM_PID is in the chain, one of the nearest ancestor.
/// windows is (window, pid) in stacking order from bottom to top, so the topmost of that process wins (a terminal
/// that runs every window in one process, like GNOME Terminal, can't tell its windows apart)
pub(super) fn pick_window(chain: &[Proc], windows: &[(Window, u32)]) -> Option<(Window, u32)> {
    chain.iter().find_map(|p| windows.iter().rev().find(|(_, pid)| *pid == p.pid).copied())
}

fn atom(conn: &impl Connection, name: &str) -> Option<u32> {
    Some(conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom)
}

/// Top-level windows with their _NET_WM_PID, bottom to top (_NET_CLIENT_LIST_STACKING, or _NET_CLIENT_LIST)
fn client_windows() -> Result<Vec<(Window, u32)>, String> {
    let x = crate::xconn::x().ok_or("no X display")?;
    let conn = &x.conn;
    let wm_pid = atom(conn, "_NET_WM_PID").ok_or("no _NET_WM_PID")?;
    let mut list = Vec::new();
    for name in ["_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"] {
        let Some(a) = atom(conn, name) else { continue };
        let Some(reply) = conn.get_property(false, x.root, a, AtomEnum::WINDOW, 0, u32::MAX).ok().and_then(|c| c.reply().ok())
        else {
            continue;
        };
        list = reply.value32().map(|v| v.collect()).unwrap_or_default();
        if !list.is_empty() {
            break;
        }
    }
    if list.is_empty() {
        return Err("the window manager publishes no client list".into());
    }
    Ok(list
        .into_iter()
        .filter_map(|w| {
            let reply = conn.get_property(false, w, wm_pid, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok()?;
            let pid = reply.value32()?.next()?;
            Some((w, pid))
        })
        .collect())
}

/// Asks the window manager to activate the window (source indication 2: a pager, which focus-stealing prevention
/// lets through; it also un-minimizes the window)
fn activate(window: Window) -> Result<(), String> {
    let x = crate::xconn::x().ok_or("no X display")?;
    let conn = &x.conn;
    let active = atom(conn, "_NET_ACTIVE_WINDOW").ok_or("no _NET_ACTIVE_WINDOW")?;
    let event = ClientMessageEvent {
        response_type: CLIENT_MESSAGE_EVENT,
        format: 32,
        sequence: 0,
        window,
        type_: active,
        data: [2u32, 0, 0, 0, 0].into(),
    };
    conn.send_event(false, x.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event)
        .map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn focus_pid_sync(pid: u32, fallback_to_app: bool) -> FocusResult {
    let Some(procs) = snapshot() else { return FocusResult::none(format!("pid={pid} /proc unreadable")) };
    let mut chain = ancestors(&procs, pid);
    if chain.is_empty() {
        return FocusResult::none(format!("pid={pid} not running"));
    }
    let mut detail = format!("pid={pid}");
    let mut pane = false;
    if let Some(tty) = chain.first().and_then(Proc::tty_path) {
        detail.push_str(&format!(" tty={tty}"));
        if let Some(server) = chain.iter().find(|p| p.name() == "tmux") {
            match tmux::switch_to(server, &tty) {
                Ok(client) => {
                    detail.push_str(&format!(" tmux={} client={}", client.pane_id, client.tty));
                    chain = ancestors(&procs, client.pid);
                    pane = true;
                }
                Err(e) => detail.push_str(&format!(" tmux: {e}")),
            }
        }
    }
    // Without a pane, only the window can be brought forward, and only when asked to (same as the app fallback on
    // macOS)
    if !pane && !fallback_to_app {
        return FocusResult::none(format!("{detail} no pane"));
    }
    let window = client_windows().and_then(|w| pick_window(&chain, &w).ok_or_else(|| "no window of an ancestor".into()));
    let raised = window.and_then(|(w, owner)| activate(w).map(|_| format!("window=0x{w:x} owner={owner}")));
    match (raised, pane) {
        (Ok(d), true) => FocusResult { level: FocusLevel::Pane, detail: format!("{detail} {d}") },
        (Err(e), true) => FocusResult { level: FocusLevel::Pane, detail: format!("{detail} {e}") },
        (Ok(d), false) => FocusResult { level: FocusLevel::App, detail: format!("{detail} {d}") },
        (Err(e), false) => FocusResult::none(format!("{detail} {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_fields_are_read_after_the_command_name() {
        let stat = "4373 (claude (x) y) S 4241 4373 4241 34819 4373 4194304 0 0";
        assert_eq!(parse_stat(stat), Some((4241, 34819)));
        assert_eq!(parse_stat("1 (systemd) S 0 1 1 0 -1"), Some((0, 0)));
    }

    #[test]
    fn tty_numbers_name_pseudo_terminals_and_consoles() {
        // pts/3: major 136, minor 3
        assert_eq!(tty_name((136 << 8) | 3).as_deref(), Some("pts/3"));
        // pts/300: major 137, minor 44
        assert_eq!(tty_name((137 << 8) | 44).as_deref(), Some("pts/300"));
        assert_eq!(tty_name((4 << 8) | 2).as_deref(), Some("tty2"));
        assert_eq!(tty_name(0), None);
    }

    #[test]
    fn the_window_of_the_nearest_ancestor_is_picked() {
        let proc = |pid, ppid| Proc { pid, ppid, tty: "pts/1".into(), comm: String::new() };
        let chain = vec![proc(30, 20), proc(20, 10), proc(10, 1)];
        // 10 (a terminal) has two windows; 20 (a shell) has none
        let windows = vec![(0x100, 10), (0x200, 99), (0x300, 10)];
        assert_eq!(pick_window(&chain, &windows), Some((0x300, 10)));
        assert_eq!(pick_window(&chain, &[(0x200, 99)]), None);
    }
}
