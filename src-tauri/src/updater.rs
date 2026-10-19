// ---- Updates (docs/design.md "Updates") ----
// Checks latest.json on the newest GitHub Release at launch and every 6 hours, and through "Check for updates" in the
// menu bar menu and settings. A found update is only installed when "Update to v<version>" is clicked: download,
// install, relaunch. The state goes to the settings screen through the "update-status" event (src/perch/use-updates.ts)
// and to the menu bar item (tray.rs)

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::append_log;

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What the settings screen and the menu bar item show. UpToDate / CheckFailed only come from a manual check;
/// automatic checks leave the status as it was when nothing new is found or the check fails
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum UpdateStatus {
    Idle,
    Checking,
    UpToDate,
    CheckFailed,
    Available { version: String },
    Downloading { version: String, downloaded: u64, total: Option<u64> },
    Installing { version: String },
    InstallFailed { version: String },
}

#[derive(Default)]
pub(crate) struct UpdateState {
    status: Mutex<Option<UpdateStatus>>,
    /// The update found by the last check, kept for "Update to v<version>"
    pending: Mutex<Option<Update>>,
}

impl UpdateStatus {
    fn busy(&self) -> bool {
        matches!(self, UpdateStatus::Checking | UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. })
    }
}

/// Whether a finished check may write its result, given the status at that moment. A check only looks at busy() when it
/// starts, so a download started meanwhile must not be overwritten by Available (a second click would download again).
/// A manual check set Checking itself and writes over it
fn should_apply(now: &UpdateStatus, manual: bool) -> bool {
    !now.busy() || (manual && *now == UpdateStatus::Checking)
}

fn current(app: &AppHandle) -> UpdateStatus {
    app.state::<UpdateState>().status.lock().unwrap().clone().unwrap_or(UpdateStatus::Idle)
}

fn set_status(app: &AppHandle, status: UpdateStatus) {
    *app.state::<UpdateState>().status.lock().unwrap() = Some(status.clone());
    crate::tray::show_update_status(app, &status);
    app.emit("update-status", status).ok();
}

/// The updater. A debug build reads TOMARIGI_UPDATER_ENDPOINT to check a local latest.json instead of GitHub (for
/// trying the whole flow before a release; the plugin allows http only in debug builds too)
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let builder = app.updater_builder();
    #[cfg(debug_assertions)]
    let builder = match std::env::var("TOMARIGI_UPDATER_ENDPOINT").ok().and_then(|u| u.parse().ok()) {
        Some(url) => builder.endpoints(vec![url])?,
        None => builder,
    };
    builder.build()
}

async fn check(app: AppHandle, manual: bool) {
    let before = current(&app);
    if before.busy() {
        return;
    }
    if manual {
        set_status(&app, UpdateStatus::Checking);
    }
    let result = match updater(&app) {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    if !should_apply(&current(&app), manual) {
        return;
    }
    match result {
        Ok(Some(update)) => {
            append_log(&format!("[update] found {} (running {})", update.version, update.current_version));
            let version = update.version.clone();
            *app.state::<UpdateState>().pending.lock().unwrap() = Some(update);
            set_status(&app, UpdateStatus::Available { version });
            // Self-test: a debug build with TOMARIGI_UPDATE_TEST=1 installs what it finds, as if "Update to v<version>"
            // were clicked (with TOMARIGI_UPDATER_ENDPOINT, for checking the flow where synthetic clicks can't be used)
            #[cfg(debug_assertions)]
            if std::env::var("TOMARIGI_UPDATE_TEST").is_ok_and(|v| v == "1") {
                install_now(&app);
            }
        }
        Ok(None) => {
            append_log("[update] up to date");
            *app.state::<UpdateState>().pending.lock().unwrap() = None;
            if manual {
                set_status(&app, UpdateStatus::UpToDate);
            } else if matches!(before, UpdateStatus::Available { .. } | UpdateStatus::InstallFailed { .. }) {
                // The found version was withdrawn
                set_status(&app, UpdateStatus::Idle);
            }
        }
        Err(e) => {
            append_log(&format!("[update] check failed: {e}"));
            if manual {
                set_status(&app, UpdateStatus::CheckFailed);
            }
        }
    }
}

/// Checks at launch, then every 6 hours
pub(crate) fn start_update_checks(app: &AppHandle) {
    app.manage(UpdateState::default());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            check(app.clone(), false).await;
            crate::tokio_sleep(CHECK_EVERY.as_millis() as u64).await;
        }
    });
}

/// "Check for updates" (menu bar menu and settings)
pub(crate) fn check_now(app: &AppHandle) {
    tauri::async_runtime::spawn(check(app.clone(), true));
}

/// "Update to v<version>": download, install, relaunch. On Windows the NSIS installer closes the app and starts it again
/// itself
pub(crate) fn install_now(app: &AppHandle) {
    if current(app).busy() {
        return;
    }
    let Some(update) = app.state::<UpdateState>().pending.lock().unwrap().clone() else { return };
    // Set before spawning, so a second click right after this one sees it busy
    set_status(app, UpdateStatus::Downloading { version: update.version.clone(), downloaded: 0, total: None });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let version = update.version.clone();
        let mut downloaded: u64 = 0;
        let mut last_percent: Option<u64> = None;
        let progress_app = app.clone();
        let progress_version = version.clone();
        let installing_app = app.clone();
        let installing_version = version.clone();
        let result = update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    // One event per percent, not per chunk
                    let percent = total.map(|t| downloaded * 100 / t.max(1));
                    if percent.is_none() || percent != last_percent {
                        last_percent = percent;
                        set_status(
                            &progress_app,
                            UpdateStatus::Downloading { version: progress_version.clone(), downloaded, total },
                        );
                    }
                },
                move || set_status(&installing_app, UpdateStatus::Installing { version: installing_version }),
            )
            .await;
        match result {
            Ok(()) => {
                append_log(&format!("[update] installed {version}, restarting"));
                app.restart();
            }
            Err(e) => {
                append_log(&format!("[update] install failed: {e}"));
                set_status(&app, UpdateStatus::InstallFailed { version });
            }
        }
    });
}

#[tauri::command]
pub(crate) fn update_status(app: AppHandle) -> UpdateStatus {
    current(&app)
}

#[tauri::command]
pub(crate) fn update_check(app: AppHandle) {
    check_now(&app);
}

#[tauri::command]
pub(crate) fn update_install(app: AppHandle) {
    install_now(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An automatic check that ends while "Update to v<version>" is downloading or installing leaves the status alone,
    /// so the update isn't offered (and downloaded) a second time
    #[test]
    fn a_check_that_ends_during_an_install_does_not_overwrite_it() {
        let downloading = UpdateStatus::Downloading { version: "1.2.0".into(), downloaded: 10, total: Some(100) };
        let installing = UpdateStatus::Installing { version: "1.2.0".into() };
        assert!(!should_apply(&downloading, false));
        assert!(!should_apply(&installing, false));
        // Another check's "Checking" is not ours to overwrite either
        assert!(!should_apply(&UpdateStatus::Checking, false));
        // A manual check set "Checking" itself, so it writes its result over it
        assert!(should_apply(&UpdateStatus::Checking, true));
        assert!(should_apply(&UpdateStatus::Available { version: "1.2.0".into() }, false));
        assert!(should_apply(&UpdateStatus::Idle, false));
    }
}
