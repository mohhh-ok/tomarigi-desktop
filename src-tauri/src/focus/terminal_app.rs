// Terminal.app: the tab whose tty matches becomes the selected tab of its window, the window becomes frontmost with
// index 1 (after the app is activated) (AppleScript dictionary: tab `tty` / `selected`, window `frontmost` / `index`)
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
            let window = sb::by_id(&windows, &window).unwrap_or(window);
            let Some(tab) = sb::value(&window, "tabs").and_then(|tabs| sb::at(&tabs, t)) else { continue };
            // Activate first: activating Terminal brings back the window that was key before, so the window order
            // is set after it
            sb::send(&app, b"misc", b"actv");
            sb::activate(target.app_pid);
            sb::set_bool(&tab, "selected", true);
            sb::set_bool(&window, "frontmost", true);
            sb::set_int(&window, "index", 1);
            // The window's index afterwards (1 = front), for the log
            let index = sb::value(&window, "index").and_then(|v| v.downcast_ref::<objc2_foundation::NSNumber>().map(|n| n.as_isize()));
            return Ok(format!("terminal window={w} tab={t} index={index:?}"));
        }
        Err("NOT FOUND in terminal".to_string())
    })
}

#[cfg(not(target_os = "macos"))]
pub(super) fn focus(_target: &Target) -> Result<String, String> {
    Err("macOS only".to_string())
}
