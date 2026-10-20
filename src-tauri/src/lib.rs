// Rust side of tomarigi-desktop. Design is in docs/design.md.
// - fs: reading watched folders for src/lib/native-fs.ts (fs_list / fs_stat / fs_read), saving downloads, and the
//   initial registration and adding of watched folders (default_roots / pick_folder)
// - keys: BYOK API keys and the API calls that use them
// - liveness: which sessions are alive (ps / lsof on macOS, /proc on Linux, sysinfo and the Restart Manager on Windows)
//   and the peer names of watching links
// - focus: jump to the terminal pane where an agent runs: focus_pid (pid → tty → owning terminal app → its adapter),
//   and focus_session / focus_codex that find the pid and go through focus_pid
// - opencode: OpenCode's sessions, read from its SQLite database (read-only)
// - window: switches on the fly between the floating window (NSPanel on macOS; transparent, borderless, always on top,
//   also shown above full-screen spaces) and the standard window (with title bar; can maximize and go full
//   screen). Saves and restores the mode, and the position and size per mode
// - garden_grow: grows the floating window when the Garden's birds don't fit, without saving the grown frame
// - fade: the floating window's Garden fades until a bird is hovered
// - tray: menu bar icon (show/hide, window mode, updates, quit). Shown in the Dock and Cmd+Tab only in standard window mode
// - updater: checks for, downloads, and installs app updates (docs/design.md "Updates")
// This file keeps the shared log / path helpers, startup (run), and the command registration
mod fade;
mod fs;
mod focus;
mod garden_grow;
mod keys;
mod liveness;
mod opencode;
mod tray;
mod updater;
mod window;
#[cfg(target_os = "linux")]
mod xconn;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, WindowEvent};

use focus::{focus_pid, focus_session, focus_tty_sync};
use keys::{import_key_from_stdin, init_key_store};
use window::{
    current_mode, load_mode, restore_window_state, schedule_save, set_dock_policy, show_window, switch_mode,
    WindowMode, WINDOW_MODE,
};

/// A folder of this user on every OS, since another user could plant a folder or a link in a shared /tmp:
/// ~/Library/Logs/tomarigi-desktop on macOS, `$XDG_STATE_HOME` (or ~/.local/state)/tomarigi-desktop on Linux, the user's
/// temp folder on Windows
fn log_dir() -> PathBuf {
    #[cfg(windows)]
    return std::env::temp_dir().join("tomarigi-desktop");
    #[cfg(target_os = "linux")]
    return std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home().join(".local/state"))
        .join("tomarigi-desktop");
    #[cfg(target_os = "macos")]
    home().join("Library/Logs/tomarigi-desktop")
}

/// The app log's size limit: past it the file becomes app-log.1.txt, so about twice this is kept (docs/design.md)
const LOG_LIMIT: u64 = 10 * 1024 * 1024;

pub(crate) fn append_log(line: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = log_dir();
    // Once per run, before the first line: logs written by older builds were readable by others
    static TIGHTEN: std::sync::Once = std::sync::Once::new();
    TIGHTEN.call_once(|| tighten_log_permissions(&dir));
    append_log_in(&dir, &format!("{ts} {line}\n"), LOG_LIMIT);
}

/// Appends text to app-log.txt in dir. When the text would take the file past limit, the file is first renamed to
/// app-log.1.txt (replacing an older one). The size is checked on each write, so every build sharing the file rolls it
/// over; a rename that loses a race to another build is ignored. The folder and files are the user's only (0700 and
/// 0600; docs/design.md), since the log holds advice text. Windows: %TEMP% is already the user's own folder
fn append_log_in(dir: &Path, text: &str, limit: u64) {
    let mut folder = std::fs::DirBuilder::new();
    folder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut folder, 0o700);
    let _ = folder.create(dir);
    let path = dir.join("app-log.txt");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 0 && m.len() + text.len() as u64 > limit) {
        let _ = std::fs::rename(&path, dir.join("app-log.1.txt"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Ok(mut f) = options.open(&path) {
        let _ = f.write_all(text.as_bytes());
    }
}

/// Makes a log folder and files that others can read the user's only. A link in their place is left alone, so a link
/// planted in a shared folder can't point this at another file
fn tighten_log_permissions(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (path, mode) in [
            (dir.to_path_buf(), 0o700),
            (dir.join("app-log.txt"), 0o600),
            (dir.join("app-log.1.txt"), 0o600),
        ] {
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if !meta.file_type().is_symlink() && meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[tauri::command]
fn log(line: &str) {
    append_log(line);
}

/// The home directory: HOME, or USERPROFILE on Windows (agent folders are under it on every OS; docs/design.md
/// "Platforms")
pub(crate) fn home() -> PathBuf {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    PathBuf::from(std::env::var(var).unwrap_or_else(|_| "/".into()))
}

/// Expands a leading "~/" to the home directory
pub(crate) fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Linux: on a Wayland session the app runs through Xwayland. Pure Wayland has no always-on-top, no global cursor
    // position, no window position restore, and no way to focus another app's window (docs/design.md "Platforms").
    // Set before GTK starts; a GDK_BACKEND the user set is kept
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    let builder = tauri::Builder::default()
        // Single instance. A second launch shows the existing window and exits (prevents two menu bar icons side by side)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // This callback is called off the main thread. AppKit window operations only work on the main thread
            // (calling them elsewhere crashes)
            let handle = app.clone();
            app.run_on_main_thread(move || show_window(&handle)).ok();
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .setup(|app| {
            // Decide the BYOK key store from the identifier (docs/design.md "BYOK API keys")
            init_key_store(&app.config().identifier);
            import_key_from_stdin(app.handle());
            let win = app.get_webview_window("main").expect("main window");
            // TOMARIGI_MOCK=1 enables mock mode (adds ?mock=1 to the page URL, read in src/perch/boot.tsx).
            // TOMARIGI_QUERY="tab=perch&settings=1" etc. sets the screen at launch (for screenshot checks; see the
            // initial state in App.tsx)
            let mut query: Vec<String> = Vec::new();
            if std::env::var("TOMARIGI_MOCK").is_ok_and(|v| v == "1") {
                query.push("mock=1".into());
            }
            if let Ok(q) = std::env::var("TOMARIGI_QUERY") {
                query.push(q);
            }
            if !query.is_empty() {
                if let Ok(url) = format!("tauri://localhost/index.html?{}", query.join("&")).parse() {
                    win.navigate(url).ok();
                }
            }
            let mode = load_mode(app.handle());
            *WINDOW_MODE.lock().unwrap() = mode;
            set_dock_policy(app.handle(), mode);
            // For the standard window, add the title bar before restoring the position (same order as switch_mode_step)
            match mode {
                WindowMode::Floating => {
                    restore_window_state(&win, mode);
                    window::make_panel(&win);
                }
                WindowMode::Normal => {
                    window::make_normal(&win);
                    restore_window_state(&win, mode);
                }
            }
            tray::setup_tray(app, mode)?;
            updater::start_update_checks(app.handle());
            // The window is created with visible:false and shown after it becomes a panel (showing it first pins it
            // to the original space)
            show_window(app.handle());
            fade::start_fade_watch(app.handle());
            append_log(&format!("[window] startup mode={mode:?}"));
            let w = win.clone();
            win.on_window_event(move |event| match event {
                // Moved / Resized caused by growing for the Garden aren't saved (garden_grow.rs)
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if garden_grow::on_frame_changed(&w) {
                        schedule_save(w.app_handle());
                    }
                }
                // The standard window's red traffic-light button hides the window without destroying it (same as the ×
                // in the header; bring it back from the menu bar icon)
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    w.hide().ok();
                }
                _ => {}
            });
            // Self-test: with TOMARIGI_FOCUS_TEST="<config_dir>|<session_id>|<return tty>" (or "pid=<pid>|<return tty>"
            // for any agent), moves to that session's pane 3 seconds after launch, then moves back to the return tty
            // 1.5 seconds later (for checking in environments where synthetic clicks can't be used)
            if let Ok(spec) = std::env::var("TOMARIGI_FOCUS_TEST") {
                let parts: Vec<String> = spec.split('|').map(str::to_string).collect();
                let target = match parts.as_slice() {
                    [config_dir, session_id, back] => Some((Err((config_dir.clone(), session_id.clone())), back.clone())),
                    [pid, back] => pid.strip_prefix("pid=").and_then(|p| p.parse::<u32>().ok()).map(|p| (Ok(p), back.clone())),
                    _ => None,
                };
                if let Some((target, back)) = target {
                    tauri::async_runtime::spawn(async move {
                        tokio_sleep(3000).await;
                        let r = match target {
                            Ok(pid) => focus_pid(pid, false).await,
                            Err((config_dir, session_id)) => focus_session(config_dir, session_id, false).await,
                        };
                        append_log(&format!("[focus-test] -> {:?} {}", r.level, r.detail));
                        tokio_sleep(1500).await;
                        let b = tauri::async_runtime::spawn_blocking(move || {
                            let r = focus_tty_sync(&back);
                            format!("{back} -> {:?} {}", r.level, r.detail)
                        });
                        append_log(&format!("[focus-test] back {}", b.await.unwrap_or_default()));
                    });
                }
            }
            // Self-test: with TOMARIGI_MODE_TEST=1, after launch goes standard window → floating window → standard
            // window → maximize → full screen → floating window, one step every 5 seconds,
            // and logs the state at each step (for checking in environments where synthetic clicks can't be used;
            // calls the same window operations instead of the traffic-light buttons).
            // TOMARIGI_MODE_TEST=normal only switches to the standard window (to check that the mode is kept after
            // a restart)
            let mode_test = std::env::var("TOMARIGI_MODE_TEST").unwrap_or_default();
            if mode_test == "1" || mode_test == "normal" {
                let only_normal = mode_test == "normal";
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let step = |name: &'static str, f: fn(&AppHandle)| {
                        std::thread::sleep(std::time::Duration::from_millis(5000));
                        let h = handle.clone();
                        handle
                            .run_on_main_thread(move || {
                                f(&h);
                                let Some(w) = h.get_webview_window("main") else { return };
                                append_log(&format!(
                                    "[mode-test] {name} mode={:?} maximized={} fullscreen={} decorated={} always_on_top={}",
                                    current_mode(),
                                    w.is_maximized().unwrap_or(false),
                                    w.is_fullscreen().unwrap_or(false),
                                    w.is_decorated().unwrap_or(false),
                                    w.is_always_on_top().unwrap_or(false)
                                ));
                            })
                            .ok();
                    };
                    step("normal", |h| switch_mode(h, WindowMode::Normal));
                    if only_normal {
                        return;
                    }
                    step("plain-floating", |h| switch_mode(h, WindowMode::Floating));
                    step("normal-again", |h| switch_mode(h, WindowMode::Normal));
                    step("maximize", |h| {
                        h.get_webview_window("main").map(|w| w.maximize());
                    });
                    step("fullscreen", |h| {
                        h.get_webview_window("main").map(|w| w.set_fullscreen(true));
                    });
                    step("floating", |h| switch_mode(h, WindowMode::Floating));
                    step("after-floating", |_| {});
                });
            }
            append_log("[app] started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log,
            fs::fs_list,
            fs::fs_stat,
            fs::fs_read,
            fs::default_roots,
            fs::pick_folder,
            focus::focus_pid,
            focus::focus_session,
            focus::focus_codex,
            liveness::live_codex_threads,
            window::hide_window,
            window::get_window_mode,
            window::set_window_mode,
            fade::set_garden_fade,
            fade::reveal_garden,
            garden_grow::garden_fit,
            garden_grow::garden_grow_anchor,
            garden_grow::window_user_size,
            fs::save_download,
            keys::anthropic_messages,
            keys::openai_responses,
            keys::local_chat,
            keys::local_models,
            keys::local_ai_import,
            keys::key_backend,
            keys::key_status,
            keys::key_set,
            keys::key_delete,
            liveness::live_sessions,
            liveness::scan_peer_names,
            liveness::tty_processes,
            liveness::process_cwds,
            liveness::alive_pids,
            opencode::opencode_sessions,
            opencode::opencode_tail,
            updater::update_status,
            updater::update_check,
            updater::update_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_log_rolls_over_past_its_limit() {
        let dir = std::env::temp_dir().join(format!("tomarigi-app-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap_or_default();
        append_log_in(&dir, "aaaa\n", 10);
        append_log_in(&dir, "bbbb\n", 10);
        // Within the limit the lines stay in one file
        assert_eq!(read("app-log.txt"), "aaaa\nbbbb\n");
        assert!(!dir.join("app-log.1.txt").exists());
        // A line that would go past it starts a new file; the old one is kept as app-log.1.txt
        append_log_in(&dir, "cccc\n", 10);
        assert_eq!(read("app-log.txt"), "cccc\n");
        assert_eq!(read("app-log.1.txt"), "aaaa\nbbbb\n");
        // The next roll replaces the older app-log.1.txt
        append_log_in(&dir, "dddd\n", 10);
        append_log_in(&dir, "eeee\n", 10);
        assert_eq!(read("app-log.txt"), "eeee\n");
        assert_eq!(read("app-log.1.txt"), "cccc\ndddd\n");
        // A single line longer than the limit is still written, to a file of its own
        append_log_in(&dir, "0123456789abc\n", 10);
        assert_eq!(read("app-log.txt"), "0123456789abc\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn app_log_is_the_users_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("tomarigi-app-log-perm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mode = |name: &str| std::fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777;
        // New folder and file
        append_log_in(&dir, "aaaa\n", 10);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(mode("app-log.txt"), 0o600);
        // The file started after a roll-over too
        append_log_in(&dir, "bbbbbbbb\n", 10);
        assert_eq!(mode("app-log.txt"), 0o600);
        assert_eq!(mode("app-log.1.txt"), 0o600);
        // Files and a folder left readable by an older build are tightened
        let loose = std::fs::Permissions::from_mode;
        std::fs::set_permissions(&dir, loose(0o755)).unwrap();
        std::fs::set_permissions(dir.join("app-log.txt"), loose(0o644)).unwrap();
        std::fs::set_permissions(dir.join("app-log.1.txt"), loose(0o644)).unwrap();
        tighten_log_permissions(&dir);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(mode("app-log.txt"), 0o600);
        assert_eq!(mode("app-log.1.txt"), 0o600);
        // A link in a file's place is left alone
        let other = std::env::temp_dir().join(format!("tomarigi-app-log-perm-other-{}", std::process::id()));
        std::fs::write(&other, "x").unwrap();
        std::fs::set_permissions(&other, loose(0o644)).unwrap();
        std::fs::remove_file(dir.join("app-log.1.txt")).unwrap();
        std::os::unix::fs::symlink(&other, dir.join("app-log.1.txt")).unwrap();
        tighten_log_permissions(&dir);
        assert_eq!(std::fs::metadata(&other).unwrap().permissions().mode() & 0o777, 0o644);
        let _ = std::fs::remove_file(&other);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
