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
                sb::activate(target.app_pid);
                return Ok(format!("iterm2 window={w} tab={t} session={s}"));
            }
        }
        Err("NOT FOUND in iterm2".to_string())
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn focus(_target: &Target) -> Result<String, String> {
    Err("macOS only".to_string())
}
