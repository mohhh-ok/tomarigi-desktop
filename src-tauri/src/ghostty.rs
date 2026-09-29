use serde::Deserialize;
use std::path::Path;
use std::process::Command;

use crate::liveness::live_codex_threads;
use crate::{append_log, expand};

// ---- Ghostty ----

fn osascript(script: &str) -> String {
    match Command::new("osascript").arg("-e").arg(script).output() {
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout).trim_end().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim_end().to_string();
            if o.status.success() {
                out
            } else {
                format!("ERROR rc={:?} {err}", o.status.code())
            }
        }
        Err(e) => format!("ERROR spawn {e}"),
    }
}

/// Focuses the Ghostty terminal whose tty matches, and returns the tty of the front pane after focusing
pub(crate) fn ghostty_focus(tty: &str) -> String {
    // tty is embedded in an AppleScript string, so only the /dev/ttysNNN form is accepted
    if !tty.starts_with("/dev/ttys") || tty.len() <= 9 || !tty[9..].chars().all(|c| c.is_ascii_digit()) {
        return format!("ERROR invalid tty {tty}");
    }
    osascript(&format!(
        r#"tell application "Ghostty"
set hit to false
repeat with t in terminals
if tty of t is "{tty}" then
focus t
activate
set hit to true
exit repeat
end if
end repeat
if not hit then return "NOT FOUND"
delay 1.0
return "front=" & (tty of focused terminal of selected tab of front window)
end tell"#
    ))
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
