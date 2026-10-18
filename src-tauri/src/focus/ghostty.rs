// Ghostty: every running instance is asked by pid for the terminal whose tty matches, then `focus` + activate.
// `tell application "Ghostty"` reaches only one of several instances (`open -n`), so osascript is not used
use super::{sb, Target};

const BUNDLE_ID: &str = "com.mitchellh.ghostty";

/// The owning instance is asked first, then the others
pub(super) fn focus(target: &Target) -> Result<String, String> {
    let mut instances = sb::pids_of_bundle(BUNDLE_ID);
    instances.sort_by_key(|p| *p != target.app_pid);
    for gpid in &instances {
        if let Some(front) = focus_tty(*gpid, target.tty) {
            return Ok(format!("ghostty={gpid} front={front}"));
        }
    }
    Err(format!("NOT FOUND in ghostty={instances:?}"))
}

#[cfg(target_os = "macos")]
fn focus_tty(gpid: u32, tty: &str) -> Option<String> {
    // Called on a worker thread, which has no autorelease pool
    objc2::rc::autoreleasepool(|_| {
        let app = sb::app(gpid)?;
        let terminals = sb::value(&app, "terminals")?;
        // One Apple Event for every terminal's tty
        let index = sb::texts(&terminals, "tty").iter().position(|t| t.as_deref() == Some(tty))?;
        let terminal = sb::at(&terminals, index)?;
        sb::send(&terminal, b"Ghst", b"Fcus");
        sb::activate(gpid);
        std::thread::sleep(std::time::Duration::from_millis(1000));
        // The window may close during the wait
        let window = sb::value(&app, "windows").and_then(|w| sb::at(&w, 0));
        let front = window
            .and_then(|w| sb::value(&w, "selectedTab"))
            .and_then(|t| sb::value(&t, "focusedTerminal"))
            .and_then(|t| sb::value(&t, "tty"));
        Some(front.as_deref().and_then(sb::text).unwrap_or_else(|| "?".to_string()))
    })
}

#[cfg(not(target_os = "macos"))]
fn focus_tty(_gpid: u32, _tty: &str) -> Option<String> {
    None
}
