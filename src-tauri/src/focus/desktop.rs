// Claude Code sessions run by the Claude desktop app (its Code tab) have no terminal pane; clicking one opens it in
// the desktop app (docs/design.md "Jumping to the terminal pane", Claude desktop app). The app keeps one record per
// session, `<claude-code-sessions>/<…>/<…>/local_<id>.json`, whose `cliSessionId` is the transcript's session id and
// whose `sessionId` is the `local_<id>` its link opens. Not a public spec, like the transcript formats
use std::path::{Path, PathBuf};

use super::{FocusLevel, FocusResult};
use crate::{append_log, home};

/// The OS a record folder and an open command are chosen for
#[derive(Clone, Copy, Debug)]
pub(super) enum Os {
    MacOs,
    Windows,
    Linux,
}

const THIS_OS: Os = if cfg!(target_os = "macos") {
    Os::MacOs
} else if cfg!(windows) {
    Os::Windows
} else {
    Os::Linux
};

/// Where the desktop app keeps its session records: under the app's data folder, `claude-code-sessions`. Seen on macOS
/// (`~/Library/Application Support/Claude`). On Windows (`%APPDATA%\Claude`) and Linux (`$XDG_CONFIG_HOME/Claude`, else
/// `~/.config/Claude`) it is Electron's usual data folder for an app named Claude, not checked on a real install
/// (Claude's guess). None when the variable it needs is missing
pub(super) fn sessions_dir_for(os: Os, home: &Path, appdata: Option<&str>, xdg_config_home: Option<&str>) -> Option<PathBuf> {
    let app = match os {
        Os::MacOs => home.join("Library/Application Support/Claude"),
        Os::Windows => PathBuf::from(appdata.filter(|v| !v.is_empty())?).join("Claude"),
        // XDG says a relative value is ignored
        Os::Linux => match xdg_config_home.filter(|v| v.starts_with('/')) {
            Some(config) => PathBuf::from(config).join("Claude"),
            None => home.join(".config/Claude"),
        },
    };
    Some(app.join("claude-code-sessions"))
}

fn sessions_dir() -> Option<PathBuf> {
    sessions_dir_for(
        THIS_OS,
        &home(),
        std::env::var("APPDATA").ok().as_deref(),
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
    )
}

/// The command that hands a link to the app registered for its scheme: LaunchServices (`open`) on macOS, the shell's
/// URL protocol handler (`rundll32 url.dll,FileProtocolHandler`) on Windows, xdg-open on Linux. Whether the desktop app
/// registers claude:// on Windows and Linux is not checked (Claude's guess)
pub(super) fn open_command(os: Os, url: &str) -> (&'static str, Vec<String>) {
    match os {
        Os::MacOs => ("/usr/bin/open", vec![url.to_string()]),
        // Not `cmd /C start`: its quoting rules aren't Rust's, and it opens a console window
        Os::Windows => ("rundll32", vec!["url.dll,FileProtocolHandler".into(), url.to_string()]),
        Os::Linux => ("xdg-open", vec![url.to_string()]),
    }
}

/// A `local_<id>` a link may carry as is: letters, digits and `-` after the prefix
fn is_local_id(id: &str) -> bool {
    id.strip_prefix("local_")
        .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

/// The `local_<id>` of a record whose `cliSessionId` is session_id
pub(super) fn local_id_of(record: &serde_json::Value, session_id: &str) -> Option<String> {
    if session_id.is_empty() || record.get("cliSessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return None;
    }
    let local = record.get("sessionId")?.as_str()?;
    is_local_id(local).then(|| local.to_string())
}

/// The link that opens a desktop session from outside the app (the app's own session list gives the same one)
pub(super) fn session_url(local_id: &str) -> String {
    format!("claude://claude.ai/epitaxy/{local_id}")
}

/// The `local_<id>` of the desktop session whose transcript is session_id, from the records two folders under dir
pub(super) fn find_local_id(dir: &Path, session_id: &str) -> Option<String> {
    for a in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(b_items) = std::fs::read_dir(a.path()) else { continue };
        for b in b_items.flatten() {
            let Ok(files) = std::fs::read_dir(b.path()) else { continue };
            for file in files.flatten() {
                let name = file.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("local_") || !name.ends_with(".json") {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(file.path()) else { continue };
                // Most records are of other sessions: parse only one that names this id
                if !text.contains(session_id) {
                    continue;
                }
                let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if let Some(local) = local_id_of(&record, session_id) {
                    return Some(local);
                }
            }
        }
    }
    None
}

/// A record of a session another session started: whose `local_<id>` started it (`spawnedFrom.sessionId`) and, for one
/// started from a proposal card or by start_session, the task id it came from (`spawnedFrom.taskId`)
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spawned {
    pub(crate) parent: String,
    pub(crate) task_id: String,
}

/// The records, two folders under dir, of sessions that the given sessions started and that were written at or after
/// since (epoch ms; a session started from a card has its record written when the user starts it). None when dir
/// can't be read (docs/design.md "The "?" for sessions waiting on you")
pub(crate) fn spawned_from(dir: &Path, parents: &[String], since_ms: u64) -> Option<Vec<Spawned>> {
    let since = std::time::UNIX_EPOCH + std::time::Duration::from_millis(since_ms);
    let mut found = Vec::new();
    for a in std::fs::read_dir(dir).ok()?.flatten() {
        let Ok(b_items) = std::fs::read_dir(a.path()) else { continue };
        for b in b_items.flatten() {
            let Ok(files) = std::fs::read_dir(b.path()) else { continue };
            for file in files.flatten() {
                let name = file.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("local_") || !name.ends_with(".json") {
                    continue;
                }
                if file.metadata().and_then(|m| m.modified()).map_or(true, |m| m < since) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(file.path()) else { continue };
                // Most records are of other sessions: parse only one that names a parent
                if !parents.iter().any(|p| text.contains(p.as_str())) {
                    continue;
                }
                let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let parent = record.pointer("/spawnedFrom/sessionId").and_then(|v| v.as_str());
                let task_id = record.pointer("/spawnedFrom/taskId").and_then(|v| v.as_str());
                if let (Some(parent), Some(task_id)) = (parent, task_id) {
                    if parents.iter().any(|p| p == parent) {
                        found.push(Spawned { parent: parent.to_string(), task_id: task_id.to_string() });
                    }
                }
            }
        }
    }
    Some(found)
}

#[derive(serde::Serialize)]
pub(crate) struct SpawnedScan {
    spawned: Vec<Spawned>,
    /// false when the desktop app's records can't be read (no data folder, or not there)
    reliable: bool,
}

/// The proposal cards of the given sessions (their `local_<id>`) that the user started: the records of the sessions
/// started from them, written at or after since (epoch ms)
#[tauri::command]
pub(crate) async fn desktop_spawned_from(parents: Vec<String>, since_ms: u64) -> SpawnedScan {
    tauri::async_runtime::spawn_blocking(move || {
        match sessions_dir().and_then(|dir| spawned_from(&dir, &parents, since_ms)) {
            Some(spawned) => SpawnedScan { spawned, reliable: true },
            None => SpawnedScan { spawned: Vec::new(), reliable: false },
        }
    })
    .await
    .unwrap_or(SpawnedScan { spawned: Vec::new(), reliable: false })
}

/// Opens the Claude Code session in the desktop app when it is one of the app's: Pane when opened, None when it isn't
/// a desktop session (the caller then jumps to its terminal pane as before)
#[tauri::command]
pub(crate) async fn open_desktop_session(session_id: String) -> FocusResult {
    tauri::async_runtime::spawn_blocking(move || open_blocking(&session_id))
        .await
        .unwrap_or_else(|e| FocusResult::none(e.to_string()))
}

fn open_blocking(session_id: &str) -> FocusResult {
    let Some(dir) = sessions_dir() else { return FocusResult::none("no data folder for the desktop app") };
    let Some(local) = find_local_id(&dir, session_id) else {
        return FocusResult::none("not a desktop session");
    };
    let url = session_url(&local);
    let (program, args) = open_command(THIS_OS, &url);
    let mut command = std::process::Command::new(program);
    command.args(&args);
    match command.status() {
        Ok(status) if status.success() => {
            append_log(&format!("[focus] {session_id} -> desktop {local}"));
            FocusResult { level: FocusLevel::Pane, detail: format!("desktop {local}") }
        }
        // Not opened (no app takes claude://, say): the caller jumps to the terminal as before
        result => {
            append_log(&format!("[focus] {session_id} -> desktop {local} failed to open: {result:?}"));
            FocusResult::none(format!("{program} {url} failed"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_record_names_the_desktop_session_of_its_transcript() {
        let cases = [
            (json!({ "sessionId": "local_5d22a81d-7257", "cliSessionId": "t1" }), "t1", Some("local_5d22a81d-7257")),
            (json!({ "sessionId": "local_a", "cliSessionId": "t1" }), "t2", None),
            // An earlier transcript of the session isn't its id (only cliSessionId counts)
            (json!({ "sessionId": "local_a", "cliSessionId": "t2", "priorCliSessionIds": ["t1"] }), "t1", None),
            (json!({ "sessionId": "x", "cliSessionId": "t1" }), "t1", None),
            (json!({ "sessionId": "local_a)b", "cliSessionId": "t1" }), "t1", None),
            (json!({ "sessionId": "local_", "cliSessionId": "t1" }), "t1", None),
            (json!({ "cliSessionId": "t1" }), "t1", None),
            (json!({ "sessionId": "local_a", "cliSessionId": "" }), "", None),
        ];
        for (record, id, expected) in cases {
            assert_eq!(local_id_of(&record, id).as_deref(), expected, "{record} {id}");
        }
    }

    #[test]
    fn the_records_folder_of_each_os() {
        let home = Path::new("/home/u");
        let cases = [
            (Os::MacOs, None, None, Some("/home/u/Library/Application Support/Claude/claude-code-sessions")),
            (Os::Windows, Some(r"C:\Users\u\AppData\Roaming"), None, Some(r"C:\Users\u\AppData\Roaming/Claude/claude-code-sessions")),
            (Os::Windows, None, None, None),
            (Os::Windows, Some(""), None, None),
            (Os::Linux, None, None, Some("/home/u/.config/Claude/claude-code-sessions")),
            (Os::Linux, None, Some("/xdg"), Some("/xdg/Claude/claude-code-sessions")),
            (Os::Linux, None, Some("relative"), Some("/home/u/.config/Claude/claude-code-sessions")),
        ];
        for (os, appdata, xdg, expected) in cases {
            let got = sessions_dir_for(os, home, appdata, xdg);
            assert_eq!(got.as_deref().map(|p| p.to_string_lossy().replace('\\', "/")), expected.map(|e| e.replace('\\', "/")), "{os:?} {appdata:?} {xdg:?}");
        }
    }

    #[test]
    fn the_command_that_opens_the_link() {
        let url = "claude://claude.ai/epitaxy/local_a";
        assert_eq!(open_command(Os::MacOs, url), ("/usr/bin/open", vec![url.to_string()]));
        assert_eq!(open_command(Os::Windows, url), ("rundll32", vec!["url.dll,FileProtocolHandler".into(), url.to_string()]));
        assert_eq!(open_command(Os::Linux, url), ("xdg-open", vec![url.to_string()]));
    }

    #[test]
    fn the_link_is_the_apps_own() {
        assert_eq!(session_url("local_5d22a81d"), "claude://claude.ai/epitaxy/local_5d22a81d");
    }

    #[test]
    fn the_cards_a_session_proposed_that_were_started() {
        let dir = std::env::temp_dir().join(format!("tomarigi-desktop-spawned-test-{}", std::process::id()));
        let deep = dir.join("org").join("account");
        std::fs::create_dir_all(&deep).unwrap();
        const P: &str = "local_0a1b2c3d-0000-4000-8000-000000000001";
        const OTHER: &str = "local_0a1b2c3d-0000-4000-8000-000000000009";
        let write = |name: &str, body: &str| std::fs::write(deep.join(name), body).unwrap();
        // Started from P's card task_1
        write("local_c1.json", &format!(r#"{{"sessionId":"local_c1","spawnedFrom":{{"sessionId":"{P}","taskId":"task_1","sideSession":true}}}}"#));
        // Started by another session
        write("local_c2.json", &format!(r#"{{"sessionId":"local_c2","spawnedFrom":{{"sessionId":"{OTHER}","taskId":"task_2"}}}}"#));
        // Started by another session; its title only mentions P
        write("local_c5.json", &format!(r#"{{"sessionId":"local_c5","title":"after {P}","spawnedFrom":{{"sessionId":"{OTHER}","taskId":"task_5"}}}}"#));
        // The user started it; it only mentions P
        write("local_c3.json", &format!(r#"{{"sessionId":"local_c3","title":"about {P}"}}"#));
        // Half written
        write("local_c4.json", &format!(r#"{{"sessionId":"local_c4","spawnedFrom":{{"sessionId":"{P}""#));
        let got = spawned_from(&dir, &[P.to_string()], 0).unwrap();
        // Written before since: not read
        let later = spawned_from(&dir, &[P.to_string()], u64::MAX / 2).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(got, vec![Spawned { parent: P.into(), task_id: "task_1".into() }]);
        assert_eq!(later, vec![]);
        assert_eq!(spawned_from(Path::new("/nonexistent-tomarigi"), &[P.to_string()], 0), None);
    }

    #[test]
    fn records_are_found_two_folders_down() {
        let dir = std::env::temp_dir().join(format!("tomarigi-desktop-sessions-test-{}", std::process::id()));
        let deep = dir.join("org").join("account");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("local_aa.json"), r#"{"sessionId":"local_aa","cliSessionId":"t-a"}"#).unwrap();
        std::fs::write(deep.join("local_bb.json"), r#"{"sessionId":"local_bb","cliSessionId":"t-b"}"#).unwrap();
        // Half written, and not a record
        std::fs::write(deep.join("local_cc.json"), r#"{"sessionId":"local_cc","cliSess"#).unwrap();
        std::fs::write(deep.join("other.json"), r#"{"sessionId":"local_dd","cliSessionId":"t-d"}"#).unwrap();
        // Directly under dir is not where records are
        std::fs::write(dir.join("local_ee.json"), r#"{"sessionId":"local_ee","cliSessionId":"t-e"}"#).unwrap();
        let found: Vec<_> = ["t-a", "t-b", "t-c", "t-d", "t-e"].iter().map(|id| find_local_id(&dir, id)).collect();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(found, [Some("local_aa".into()), Some("local_bb".into()), None, None, None]);
        assert_eq!(find_local_id(Path::new("/nonexistent-tomarigi"), "t-a"), None);
    }
}
