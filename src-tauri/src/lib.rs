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
use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager, WindowEvent};

use focus::{focus_pid, focus_session, focus_tty_sync};
use keys::{import_key_from_stdin, init_key_store};
use window::{
    current_mode, load_mode, restore_window_state, schedule_save, set_dock_policy, show_window, switch_mode,
    WindowMode, WINDOW_MODE,
};

/// /tmp/tomarigi-desktop on macOS. Elsewhere a folder of this user, since another user could plant a link in a shared
/// /tmp: `$XDG_STATE_HOME` (or ~/.local/state)/tomarigi-desktop on Linux, the user's temp folder on Windows
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
    PathBuf::from("/tmp/tomarigi-desktop")
}

pub(crate) fn append_log(line: &str) {
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app-log.txt")) {
        let ts = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "{ts} {line}");
    }
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
            keys::typesafe_systemone,
            keys::anthropic_messages,
            keys::openai_responses,
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
