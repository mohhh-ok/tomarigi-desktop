use serde::Deserialize;
use std::path::Path;
use std::process::Command;

use crate::liveness::live_codex_threads;
use crate::{append_log, expand};

// ---- Ghostty ----

/// Focuses the Ghostty terminal whose tty matches, and returns the tty of the front pane after focusing.
/// Ghostty can run as several app instances (`open -n`), and `tell application "Ghostty"` reaches only one of them,
/// so every instance is asked by pid through ScriptingBridge (docs/design.md "Jumping to the Ghostty pane")
pub(crate) fn ghostty_focus(tty: &str) -> String {
    let instances = sb::ghostty_pids();
    for gpid in &instances {
        if let Some(front) = sb::focus_tty(*gpid, tty) {
            return format!("ghostty={gpid} front={front}");
        }
    }
    format!("NOT FOUND in ghostty={instances:?}")
}

#[cfg(target_os = "macos")]
mod sb {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::{NSArray, NSString};

    #[link(name = "ScriptingBridge", kind = "framework")]
    unsafe extern "C" {}

    const fn fourcc(s: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*s)
    }

    pub(super) fn ghostty_pids() -> Vec<i32> {
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str("com.mitchellh.ghostty"));
        apps.iter().map(|a| a.processIdentifier()).collect()
    }

    fn value(obj: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
        let key = NSString::from_str(key);
        unsafe { msg_send![obj, valueForKey: &*key] }
    }

    fn text(obj: &AnyObject) -> Option<String> {
        obj.downcast_ref::<NSString>().map(|s| s.to_string())
    }

    /// Focuses the terminal with this tty in the Ghostty instance gpid. None if that instance doesn't have it
    pub(super) fn focus_tty(gpid: i32, tty: &str) -> Option<String> {
        // Called on a tokio worker, which has no autorelease pool
        objc2::rc::autoreleasepool(|_| focus_tty_inner(gpid, tty))
    }

    fn focus_tty_inner(gpid: i32, tty: &str) -> Option<String> {
        let cls = AnyClass::get(c"SBApplication")?;
        let app: Option<Retained<AnyObject>> = unsafe { msg_send![cls, applicationWithProcessIdentifier: gpid] };
        let app = app?;
        // A hung instance must not block the click for the default 2 minutes (the unit is 1/60 s)
        let _: () = unsafe { msg_send![&*app, setTimeout: 300isize] };
        let terminals = value(&app, "terminals")?;
        // One Apple Event for every terminal's tty
        let ttys = value(&terminals, "tty")?;
        let ttys = ttys.downcast_ref::<NSArray>()?;
        let index = ttys.iter().position(|t| text(&t).as_deref() == Some(tty))?;
        let terminal: Option<Retained<AnyObject>> = unsafe { msg_send![&*terminals, objectAtIndex: index] };
        let terminal = terminal?;
        // `focus` (GhstFcus) with the terminal as the direct parameter
        let _: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*terminal, sendEvent: fourcc(b"Ghst"), id: fourcc(b"Fcus"), parameters: 0u32] };
        if let Some(running) = NSRunningApplication::runningApplicationWithProcessIdentifier(gpid) {
            running.activateWithOptions(NSApplicationActivationOptions::empty());
        }
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let windows = value(&app, "windows")?;
        // objectAtIndex: on an empty list raises and aborts the process (the window may close during the wait)
        let count: usize = unsafe { msg_send![&*windows, count] };
        if count == 0 {
            return Some("?".to_string());
        }
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![&*windows, objectAtIndex: 0usize] };
        let window = window?;
        let front = value(&window, "selectedTab").and_then(|t| value(&t, "focusedTerminal")).and_then(|t| value(&t, "tty"));
        Some(front.as_deref().and_then(text).unwrap_or_else(|| "?".to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
mod sb {
    pub(super) fn ghostty_pids() -> Vec<i32> {
        Vec::new()
    }
    pub(super) fn focus_tty(_gpid: i32, _tty: &str) -> Option<String> {
        None
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionFile {
    pid: u32,
    session_id: String,
}

/// Finds the pid for session_id from `<config_dir>/sessions/<pid>.json` (an internal Claude Code file)
fn pid_of_session(config_dir: &Path, session_id: &str) -> Option<u32> {
    let dir = config_dir.join("sessions");
    for item in std::fs::read_dir(dir).ok()?.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(parsed) = serde_json::from_str::<ClaudeSessionFile>(&text) else { continue };
        if parsed.session_id == session_id {
            return Some(parsed.pid);
        }
    }
    None
}

/// The controlling terminal (/dev/ttysNNN) of a live pid. None if it has exited or has no terminal
fn tty_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "tty=", "-p", &pid.to_string()]).output().ok()?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || tty.is_empty() || tty == "??" {
        return None;
    }
    Some(format!("/dev/{tty}"))
}

fn focus_pid(pid: u32) -> String {
    match tty_of_pid(pid) {
        None => format!("pid={pid} no tty"),
        Some(tty) => format!("pid={pid} tty={tty} {}", ghostty_focus(&tty)),
    }
}

/// Moves to the Ghostty pane where the Claude Code session is running. Does nothing if no match is found
#[tauri::command]
pub(crate) async fn focus_session(config_dir: String, session_id: String) -> String {
    let result = match pid_of_session(&expand(&config_dir), &session_id) {
        None => "no session file".to_string(),
        Some(pid) => focus_pid(pid),
    };
    append_log(&format!("[focus] {config_dir} {session_id} -> {result}"));
    result
}

/// Moves to the Ghostty pane where the codex that has the thread open is running. Does nothing if no process
/// has the thread's lock open
#[tauri::command]
pub(crate) async fn focus_codex(codex_dir: String, thread_id: String) -> String {
    let scan = live_codex_threads(codex_dir.clone()).await;
    let result = match scan.threads.iter().find(|t| t.thread_id == thread_id) {
        None => "no process has the thread lock open".to_string(),
        Some(t) => focus_pid(t.pid),
    };
    append_log(&format!("[focus] {codex_dir} {thread_id} -> {result}"));
    result
}
