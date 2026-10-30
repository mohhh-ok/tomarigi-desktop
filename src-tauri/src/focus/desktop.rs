// Claude Code sessions run by the Claude desktop app (its Code tab) have no terminal pane; clicking one opens it in
// the desktop app (docs/design.md "Jumping to the terminal pane", Claude desktop app). The app keeps one record per
// session, `<claude-code-sessions>/<…>/<…>/local_<id>.json`, whose `cliSessionId` is the transcript's session id and
// whose `sessionId` is the `local_<id>` its link opens. Not a public spec, like the transcript formats
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use super::FocusLevel;
use super::FocusResult;
#[cfg(target_os = "macos")]
use crate::append_log;
use crate::home;

/// Where the desktop app keeps its session records (macOS)
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sessions_dir() -> PathBuf {
    home().join("Library/Application Support/Claude/claude-code-sessions")
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
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

/// Opens the Claude Code session in the desktop app when it is one of the app's: Pane when opened, None when it isn't
/// a desktop session (the caller then jumps to its terminal pane as before)
#[tauri::command]
pub(crate) async fn open_desktop_session(session_id: String) -> FocusResult {
    tauri::async_runtime::spawn_blocking(move || open_blocking(&session_id))
        .await
        .unwrap_or_else(|e| FocusResult::none(e.to_string()))
}

#[cfg(target_os = "macos")]
fn open_blocking(session_id: &str) -> FocusResult {
    let Some(local) = find_local_id(&sessions_dir(), session_id) else {
        return FocusResult::none("not a desktop session");
    };
    let url = session_url(&local);
    // `open` hands the URL to LaunchServices, which gives it to the app registered for claude:// (Claude's own
    // decision: the same path the parent session checked by hand)
    match std::process::Command::new("/usr/bin/open").arg(&url).status() {
        Ok(status) if status.success() => {
            append_log(&format!("[focus] {session_id} -> desktop {local}"));
            FocusResult { level: FocusLevel::Pane, detail: format!("desktop {local}") }
        }
        result => {
            append_log(&format!("[focus] {session_id} -> desktop {local} failed to open: {result:?}"));
            FocusResult::none(format!("open {url} failed"))
        }
    }
}

/// macOS only at first: where the records are on Windows and Linux isn't checked
#[cfg(not(target_os = "macos"))]
fn open_blocking(_session_id: &str) -> FocusResult {
    FocusResult::none("desktop sessions are opened on macOS only")
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
    fn the_link_is_the_apps_own() {
        assert_eq!(session_url("local_5d22a81d"), "claude://claude.ai/epitaxy/local_5d22a81d");
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
