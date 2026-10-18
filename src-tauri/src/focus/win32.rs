// Windows (docs/design.md "Platforms"): processes come from sysinfo (there is no ps and no tty). Only the terminal
// window is brought to the front: the nearest ancestor of the agent that has a visible top-level window, with
// SetForegroundWindow. Windows Terminal tabs can't be addressed from outside, so a Windows Terminal window comes
// forward on whatever tab it shows
use std::collections::HashMap;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
    GW_OWNER, SW_RESTORE,
};

use super::{ancestors, vscode, FocusLevel, FocusResult, Proc};
use crate::liveness::win::{snapshot as sys_snapshot, Detail};

/// Every process, with its parent. comm is the executable path; tty is empty (Windows has none)
pub(super) fn snapshot() -> HashMap<u32, Proc> {
    let sys = sys_snapshot(Detail::Command);
    sys.processes()
        .iter()
        .map(|(pid, p)| {
            let pid = pid.as_u32();
            let comm = p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| p.name().to_string_lossy().into_owned());
            (pid, Proc { pid, ppid: p.parent().map(|pp| pp.as_u32()).unwrap_or(0), tty: String::new(), comm })
        })
        .collect()
}

/// The nearest process in the chain that owns one of the windows
pub(super) fn pick_window(chain: &[Proc], windows: &[(isize, u32)]) -> Option<(isize, u32)> {
    chain.iter().find_map(|p| windows.iter().find(|(_, pid)| *pid == p.pid).copied())
}

/// Visible top-level windows that no other window owns (dialogs and tool windows are owned), with their process.
/// EnumWindows goes from the top of the z-order, so the frontmost window of a process comes first
fn top_level_windows() -> Vec<(isize, u32)> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = unsafe { &mut *(lparam.0 as *mut Vec<(isize, u32)>) };
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|o| !o.is_invalid());
        if unsafe { IsWindowVisible(hwnd) }.as_bool() && !owned {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            out.push((hwnd.0 as isize, pid));
        }
        true.into()
    }
    let mut out: Vec<(isize, u32)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

pub(super) fn focus_pid_sync(pid: u32, fallback_to_app: bool) -> FocusResult {
    let procs = snapshot();
    let chain = ancestors(&procs, pid);
    if chain.is_empty() {
        return FocusResult::none(format!("pid={pid} not running"));
    }
    let mut detail = format!("pid={pid}");
    // A terminal inside a VS Code window: its tab is focused through Tomarigi's extension (vscode.rs)
    match vscode::focus(&chain, &procs) {
        Ok(d) => return FocusResult { level: FocusLevel::Pane, detail: format!("{detail} {d}") },
        Err(e) => detail.push_str(&format!(" {e}")),
    }
    // There is no pane to focus; the window is brought forward only when asked to (same as the app fallback on macOS)
    if !fallback_to_app {
        return FocusResult::none(format!("{detail} no pane"));
    }
    let Some((hwnd, owner)) = pick_window(&chain, &top_level_windows()) else {
        return FocusResult::none(format!("{detail} no window of an ancestor"));
    };
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        // Allowed because Tomarigi received the last input (the click on the bird)
        let ok = SetForegroundWindow(hwnd).as_bool();
        let detail = format!("{detail} window={:x} owner={owner} foreground={ok}", hwnd.0 as isize);
        if ok {
            FocusResult { level: FocusLevel::App, detail }
        } else {
            FocusResult::none(detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_of_the_nearest_ancestor_is_picked() {
        let proc = |pid, ppid| Proc { pid, ppid, tty: String::new(), comm: String::new() };
        // claude.exe (30) under pwsh.exe (20) under WindowsTerminal.exe (10)
        let chain = vec![proc(30, 20), proc(20, 10), proc(10, 4)];
        assert_eq!(pick_window(&chain, &[(0x200, 99), (0x100, 10)]), Some((0x100, 10)));
        assert_eq!(pick_window(&chain, &[(0x200, 99)]), None);
    }
}
