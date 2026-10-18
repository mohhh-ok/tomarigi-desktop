// Terminal.app: the tab whose tty matches becomes the selected tab of its window, the window becomes frontmost with
// index 1, and the app is activated (AppleScript dictionary: tab `tty` / `selected`, window `frontmost` / `index`)
use super::{sb, Target};

#[cfg(target_os = "macos")]
pub(super) fn focus(target: &Target) -> Result<String, String> {
    objc2::rc::autoreleasepool(|_| {
        let app = sb::app(target.app_pid).ok_or("no scripting bridge")?;
        let windows = sb::value(&app, "windows").ok_or("no windows")?;
        for w in 0..sb::count(&windows) {
            let Some(window) = sb::at(&windows, w) else { continue };
            let Some(tabs) = sb::value(&window, "tabs") else { continue };
            let ttys = sb::texts(&tabs, "tty");
            let Some(t) = ttys.iter().position(|x| x.as_deref() == Some(target.tty)) else { continue };
            let Some(tab) = sb::at(&tabs, t) else { continue };
            sb::set_bool(&tab, "selected", true);
            sb::set_bool(&window, "frontmost", true);
            sb::set_int(&window, "index", 1);
            sb::activate(target.app_pid);
            return Ok(format!("terminal window={w} tab={t}"));
        }
        Err("NOT FOUND in terminal".to_string())
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn focus(_target: &Target) -> Result<String, String> {
    Err("macOS only".to_string())
}
