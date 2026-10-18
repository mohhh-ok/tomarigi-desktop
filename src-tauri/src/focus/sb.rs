// ScriptingBridge and NSRunningApplication helpers shared by the AppleScript-dictionary adapters (Ghostty, iTerm2,
// Terminal.app). Apps are addressed by pid (`SBApplication applicationWithProcessIdentifier:`), so the instance that
// owns the agent is the one asked even when an app runs several times
#[cfg(target_os = "macos")]
mod imp {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::{NSArray, NSNumber, NSString};

    #[link(name = "ScriptingBridge", kind = "framework")]
    unsafe extern "C" {}

    pub(crate) type Obj = Retained<AnyObject>;

    pub(crate) const fn fourcc(s: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*s)
    }

    pub(crate) fn pids_of_bundle(bundle_id: &str) -> Vec<u32> {
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id));
        apps.iter().map(|a| a.processIdentifier() as u32).collect()
    }

    pub(crate) fn bundle_id_of(pid: u32) -> Option<String> {
        objc2::rc::autoreleasepool(|_| {
            let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)?;
            app.bundleIdentifier().map(|b| b.to_string())
        })
    }

    pub(crate) fn activate(pid: u32) {
        objc2::rc::autoreleasepool(|_| {
            if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32) {
                app.activateWithOptions(NSApplicationActivationOptions::empty());
            }
        })
    }

    /// The scripting object of the app running as pid
    pub(crate) fn app(pid: u32) -> Option<Obj> {
        let cls = AnyClass::get(c"SBApplication")?;
        let app: Option<Obj> = unsafe { msg_send![cls, applicationWithProcessIdentifier: pid as i32] };
        let app = app?;
        // A hung app must not block the click for the default 2 minutes (the unit is 1/60 s)
        let _: () = unsafe { msg_send![&*app, setTimeout: 300isize] };
        Some(app)
    }

    pub(crate) fn value(obj: &AnyObject, key: &str) -> Option<Obj> {
        let key = NSString::from_str(key);
        unsafe { msg_send![obj, valueForKey: &*key] }
    }

    pub(crate) fn set_bool(obj: &AnyObject, key: &str, v: bool) {
        let key = NSString::from_str(key);
        let n = NSNumber::new_bool(v);
        let _: () = unsafe { msg_send![obj, setValue: &*n, forKey: &*key] };
    }

    pub(crate) fn set_int(obj: &AnyObject, key: &str, v: isize) {
        let key = NSString::from_str(key);
        let n = NSNumber::new_isize(v);
        let _: () = unsafe { msg_send![obj, setValue: &*n, forKey: &*key] };
    }

    pub(crate) fn text(obj: &AnyObject) -> Option<String> {
        obj.downcast_ref::<NSString>().map(|s| s.to_string())
    }

    /// The strings of an element array's property, fetched with one Apple Event (`tty of every terminal`)
    pub(crate) fn texts(elements: &AnyObject, key: &str) -> Vec<Option<String>> {
        let Some(list) = value(elements, key) else { return Vec::new() };
        let Some(list) = list.downcast_ref::<NSArray>() else { return Vec::new() };
        list.iter().map(|t| text(&t)).collect()
    }

    pub(crate) fn count(elements: &AnyObject) -> usize {
        unsafe { msg_send![elements, count] }
    }

    /// objectAtIndex: past the end raises and aborts the process, so the count is checked first
    pub(crate) fn at(elements: &AnyObject, index: usize) -> Option<Obj> {
        if index >= count(elements) {
            return None;
        }
        unsafe { msg_send![elements, objectAtIndex: index] }
    }

    /// Sends a command (event class + id) with obj as the direct parameter
    pub(crate) fn send(obj: &AnyObject, class: &[u8; 4], id: &[u8; 4]) {
        let _: Option<Obj> = unsafe { msg_send![obj, sendEvent: fourcc(class), id: fourcc(id), parameters: 0u32] };
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub(crate) fn pids_of_bundle(_bundle_id: &str) -> Vec<u32> {
        Vec::new()
    }
    pub(crate) fn bundle_id_of(_pid: u32) -> Option<String> {
        None
    }
    pub(crate) fn activate(_pid: u32) {}
}

pub(crate) use imp::*;
