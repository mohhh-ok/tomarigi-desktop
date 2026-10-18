// iTerm2: the session whose tty matches is selected, then its tab, then its window (AppleScript dictionary:
// `select` is "Make receiver visible and selected", event Itrm/slct)
use super::{sb, Target};

#[cfg(target_os = "macos")]
pub(super) fn focus(target: &Target) -> Result<String, String> {
    objc2::rc::autoreleasepool(|_| {
        let app = sb::app(target.app_pid).ok_or("no scripting bridge")?;
        let windows = sb::value(&app, "windows").ok_or("no windows")?;
        for w in 0..sb::count(&windows) {
            let Some(window) = sb::at(&windows, w) else { continue };
            // Selecting reorders the windows, so the window is addressed by id
            let window = sb::by_id(&windows, &window).unwrap_or(window);
            let Some(tabs) = sb::value(&window, "tabs") else { continue };
            for t in 0..sb::count(&tabs) {
                let Some(tab) = sb::at(&tabs, t) else { continue };
                let Some(sessions) = sb::value(&tab, "sessions") else { continue };
                let ttys = sb::texts(&sessions, "tty");
                let Some(s) = ttys.iter().position(|x| x.as_deref() == Some(target.tty)) else { continue };
                let Some(session) = sb::at(&sessions, s) else { continue };
                sb::send(&session, b"Itrm", b"slct");
                sb::send(&tab, b"Itrm", b"slct");
                sb::send(&window, b"Itrm", b"slct");
                // `activate` sent to the app makes it come forward itself, the same way Ghostty's `focus` does;
                // NSRunningApplication's activate alone sometimes left the other app in front in testing
                sb::send(&app, b"misc", b"actv");
                sb::activate(target.app_pid);
                // The tty of the current window's current session afterwards, for the log
                let front = sb::value(&app, "currentWindow")
                    .and_then(|w| sb::value(&w, "currentSession"))
                    .and_then(|s| sb::value(&s, "tty"));
                let front = front.as_deref().and_then(sb::text).unwrap_or_else(|| "?".to_string());
                return Ok(format!("iterm2 window={w} tab={t} session={s} front={front}"));
            }
        }
        Err("NOT FOUND in iterm2".to_string())
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn focus(_target: &Target) -> Result<String, String> {
    Err("macOS only".to_string())
}
