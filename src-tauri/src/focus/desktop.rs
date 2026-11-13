// Claude Code sessions run by the Claude desktop app (its Code tab) have no terminal pane; clicking one opens it in
// the desktop app (docs/design.md "Jumping to the terminal pane", Claude desktop app). The app keeps one record per
// session, `<claude-code-sessions>/<…>/<…>/local_<id>.json`, whose `cliSessionId` is the transcript's session id and
// whose `sessionId` is the `local_<id>` its link opens. Not a public spec, like the transcript formats
use std::path::{Path, PathBuf};

use super::{FocusLevel, FocusResult};
use crate::{append_log, home, is_host_session_id};

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

/// The `local_<id>` of a record whose `cliSessionId` is session_id
pub(super) fn local_id_of(record: &serde_json::Value, session_id: &str) -> Option<String> {
    if session_id.is_empty() || record.get("cliSessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return None;
    }
    let local = record.get("sessionId")?.as_str()?;
    is_host_session_id(local).then(|| local.to_string())
}

/// The link that opens a desktop session from outside the app (the app's own session list gives the same one)
pub(super) fn session_url(local_id: &str) -> String {
    format!("claude://claude.ai/epitaxy/{local_id}")
}

/// Goes through the records two folders under dir, one at a time: only those written at or after since (all with None),
/// and, of those, only the ones whose text names one of needles are parsed (most records are of other sessions). f
/// returns true to stop. Returns how many records were read, or None when dir can't be read
pub(crate) fn each_record(
    dir: &Path,
    since: Option<std::time::SystemTime>,
    needles: &[&str],
    mut f: impl FnMut(&serde_json::Value) -> bool,
) -> Option<usize> {
    let mut read = 0;
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
                if let Some(since) = since {
                    if file.metadata().and_then(|m| m.modified()).map_or(true, |m| m < since) {
                        continue;
                    }
                }
                let Ok(text) = std::fs::read_to_string(file.path()) else { continue };
                read += 1;
                if !needles.iter().any(|n| !n.is_empty() && text.contains(n)) {
                    continue;
                }
                let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                if f(&record) {
                    return Some(read);
                }
            }
        }
    }
    Some(read)
}

/// The `local_<id>` of the desktop session whose transcript is session_id, from the records two folders under dir
pub(super) fn find_local_id(dir: &Path, session_id: &str) -> Option<String> {
    let mut found = None;
    each_record(dir, None, &[session_id], |record| {
        found = local_id_of(record, session_id);
        found.is_some()
    })?;
    found
}

/// A session whose cards are asked about: its transcript's session id, and its `local_<id>` when known
#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardParent {
    pub(crate) cli: String,
    pub(crate) host: Option<String>,
}

/// A record of a session another session started: whose `local_<id>` started it (`spawnedFrom.sessionId`), given back
/// as that session's transcript id (cli), and the task id it came from (`spawnedFrom.taskId`: a proposal card's, or a
/// start_session call's)
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spawned {
    pub(crate) cli: String,
    pub(crate) task_id: String,
}

/// What desktop_started_cards found
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CardScan {
    /// The `local_<id>` of each parent asked without one, when its record was found
    pub(crate) hosts: Vec<(String, String)>,
    pub(crate) spawned: Vec<Spawned>,
    /// How many records were read: the next read asks only for those written since read_at_ms
    pub(crate) read: usize,
    /// When this read started (epoch ms)
    pub(crate) read_at_ms: u64,
    /// false when the desktop app's records can't be read (no data folder, or not there)
    pub(crate) reliable: bool,
}

/// The cards of parents that the user started, from the records under dir (docs/design.md "The "?" for sessions waiting
/// on you"). A parent without its `local_<id>` (no `hostSessionId` in its sessions/<pid>.json, e.g. its process ended)
/// is looked up by its transcript id in all records; then the records written at or after since_ms are read for the
/// sessions started from the parents' cards
pub(crate) fn started_cards(dir: &Path, parents: &[CardParent], since_ms: u64, now_ms: u64) -> CardScan {
    let none = |read| CardScan { hosts: Vec::new(), spawned: Vec::new(), read, read_at_ms: now_ms, reliable: false };
    let mut read = 0;
    let mut hosts: Vec<(String, String)> = Vec::new();
    // Each transcript id once: two parents may share one, and one transcript may have several records (a resumed
    // session), so the read stops once every id has a record, not after as many records as ids
    let mut unknown: Vec<&str> = parents.iter().filter(|p| p.host.is_none()).map(|p| p.cli.as_str()).collect();
    unknown.sort_unstable();
    unknown.dedup();
    if !unknown.is_empty() {
        let Some(n) = each_record(dir, None, &unknown, |record| {
            for cli in &unknown {
                if hosts.iter().any(|(c, _)| c == cli) {
                    continue;
                }
                if let Some(local) = local_id_of(record, cli) {
                    hosts.push((cli.to_string(), local));
                }
            }
            hosts.len() == unknown.len()
        }) else {
            return none(read);
        };
        read += n;
    }
    let by_host: Vec<(&str, &str)> = parents
        .iter()
        .filter_map(|p| {
            let host = p.host.as_deref().or_else(|| hosts.iter().find(|(c, _)| c == &p.cli).map(|(_, h)| h.as_str()))?;
            Some((host, p.cli.as_str()))
        })
        .collect();
    let mut spawned = Vec::new();
    if !by_host.is_empty() {
        // checked_add: a since far in the future can't overflow the clock (it would panic on some platforms)
        let since = std::time::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(since_ms))
            .unwrap_or(std::time::UNIX_EPOCH);
        let needles: Vec<&str> = by_host.iter().map(|(h, _)| *h).collect();
        let Some(n) = each_record(dir, Some(since), &needles, |record| {
            let parent = record.pointer("/spawnedFrom/sessionId").and_then(|v| v.as_str());
            let task_id = record.pointer("/spawnedFrom/taskId").and_then(|v| v.as_str());
            if let (Some(parent), Some(task_id)) = (parent, task_id) {
                if let Some((_, cli)) = by_host.iter().find(|(h, _)| *h == parent) {
                    spawned.push(Spawned { cli: cli.to_string(), task_id: task_id.to_string() });
                }
            }
            false
        }) else {
            return none(read);
        };
        read += n;
    }
    CardScan { hosts, spawned, read, read_at_ms: now_ms, reliable: true }
}

/// Whether a record is a side chat's (`btw` in the desktop app; docs/design.md "Side chats and forked sessions of the
/// Claude desktop app"): `spawnedFrom.btw` is true. A fork another session started has `spawnedFrom` and
/// `forkedFromSessionId` too, but no `btw`
pub(crate) fn is_side_chat_record(record: &serde_json::Value) -> bool {
    record.pointer("/spawnedFrom/btw").and_then(|v| v.as_bool()) == Some(true)
}

/// What desktop_side_chats found
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SideChatScan {
    /// Per id asked, whether its record is a side chat's; ids whose record isn't there or couldn't be read are left out
    pub(crate) answers: Vec<(String, bool)>,
    /// false when the desktop app's records can't be listed (no data folder, or not there)
    pub(crate) reliable: bool,
}

/// For each `local_<id>` in ids, whether its record (`local_<id>.json` two folders under dir) is a side chat's. The
/// records are found by name: only the folders are listed, and only the records asked for are opened
pub(crate) fn side_chats(dir: &Path, ids: &[String]) -> SideChatScan {
    let wanted: Vec<&str> = ids.iter().map(String::as_str).filter(|id| is_host_session_id(id)).collect();
    let Ok(a_items) = std::fs::read_dir(dir) else { return SideChatScan { answers: Vec::new(), reliable: false } };
    let mut answers: Vec<(String, bool)> = Vec::new();
    if wanted.is_empty() {
        return SideChatScan { answers, reliable: true };
    }
    'folders: for a in a_items.flatten() {
        let Ok(b_items) = std::fs::read_dir(a.path()) else { continue };
        for b in b_items.flatten() {
            for id in &wanted {
                if answers.iter().any(|(done, _)| done == id) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(b.path().join(format!("{id}.json"))) else { continue };
                let Ok(record) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                answers.push((id.to_string(), is_side_chat_record(&record)));
            }
            if answers.len() == wanted.len() {
                break 'folders;
            }
        }
    }
    SideChatScan { answers, reliable: true }
}

/// Which of the given desktop sessions (`local_<id>`) are side chats (side_chats)
#[tauri::command]
pub(crate) async fn desktop_side_chats(ids: Vec<String>) -> SideChatScan {
    tauri::async_runtime::spawn_blocking(move || match sessions_dir() {
        Some(dir) => side_chats(&dir, &ids),
        None => SideChatScan { answers: Vec::new(), reliable: false },
    })
    .await
    .unwrap_or(SideChatScan { answers: Vec::new(), reliable: false })
}

/// The proposal cards of the given sessions that the user started (started_cards)
#[tauri::command]
pub(crate) async fn desktop_started_cards(parents: Vec<CardParent>, since_ms: u64) -> CardScan {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let unreadable = CardScan { hosts: Vec::new(), spawned: Vec::new(), read: 0, read_at_ms: now_ms, reliable: false };
    tauri::async_runtime::spawn_blocking(move || match sessions_dir() {
        Some(dir) => started_cards(&dir, &parents, since_ms, now_ms),
        None => unreadable,
    })
    .await
    .unwrap_or(CardScan { hosts: Vec::new(), spawned: Vec::new(), read: 0, read_at_ms: now_ms, reliable: false })
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
        let dir = std::env::temp_dir().join(format!("tomarigi-desktop-cards-test-{}", std::process::id()));
        let deep = dir.join("org").join("account");
        std::fs::create_dir_all(&deep).unwrap();
        const P: &str = "local_0a1b2c3d-0000-4000-8000-000000000001";
        const OTHER: &str = "local_0a1b2c3d-0000-4000-8000-000000000009";
        let write = |name: &str, body: &str| std::fs::write(deep.join(name), body).unwrap();
        // The parent's own record: its transcript t-p and its local id
        write("local_0a1b2c3d-0000-4000-8000-000000000001.json", &format!(r#"{{"sessionId":"{P}","cliSessionId":"t-p"}}"#));
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
        let started = vec![Spawned { cli: "t-p".into(), task_id: "task_1".into() }];
        let known = [CardParent { cli: "t-p".into(), host: Some(P.into()) }];
        let first = started_cards(&dir, &known, 0, 7);
        assert_eq!((&first.spawned, first.hosts.is_empty(), first.reliable, first.read_at_ms), (&started, true, true, 7));
        assert_eq!(first.read, 6, "the first read goes through every record written since the card");
        // The next read asks only for records written since the last one: none were
        let later_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 60_000;
        let next = started_cards(&dir, &known, later_ms, 8);
        assert_eq!((next.read, next.spawned.len()), (0, 0));
        // A since too far in the future doesn't overflow the clock
        assert_eq!(started_cards(&dir, &known, u64::MAX, 9).read, 0);
        // A parent without its local id (its process ended): found by its transcript id in the records
        let unknown = [CardParent { cli: "t-p".into(), host: None }];
        let looked_up = started_cards(&dir, &unknown, 0, 10);
        assert_eq!(looked_up.hosts, vec![("t-p".to_string(), P.to_string())]);
        assert_eq!(looked_up.spawned, started);
        // Two records with the parent's transcript id (a resumed session), and another parent: each found once, and the
        // read doesn't stop before the other parent's record
        let more = dir.join("org").join("other-account");
        std::fs::create_dir_all(&more).unwrap();
        std::fs::write(more.join("local_0a1b2c3d-0000-4000-8000-0000000000a1.json"), r#"{"sessionId":"local_0a1b2c3d-0000-4000-8000-0000000000a1","cliSessionId":"t-p"}"#).unwrap();
        std::fs::write(more.join("local_0a1b2c3d-0000-4000-8000-0000000000a2.json"), r#"{"sessionId":"local_0a1b2c3d-0000-4000-8000-0000000000a2","cliSessionId":"t-q"}"#).unwrap();
        let two = [
            CardParent { cli: "t-p".into(), host: None },
            CardParent { cli: "t-p".into(), host: None },
            CardParent { cli: "t-q".into(), host: None },
        ];
        let mut found = started_cards(&dir, &two, 0, 13).hosts;
        found.sort();
        assert_eq!(found.iter().filter(|(c, _)| c == "t-p").count(), 1, "{found:?}");
        assert_eq!(found.iter().filter(|(c, _)| c == "t-q").map(|(_, h)| h.as_str()).collect::<Vec<_>>(), ["local_0a1b2c3d-0000-4000-8000-0000000000a2"]);
        std::fs::remove_dir_all(&more).unwrap();
        // A parent no record names: nothing started
        let missing = started_cards(&dir, &[CardParent { cli: "t-x".into(), host: None }], 0, 11);
        assert_eq!((missing.hosts.len(), missing.spawned.len(), missing.reliable), (0, 0, true));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!started_cards(Path::new("/nonexistent-tomarigi"), &known, 0, 12).reliable);
    }

    /// A local id is `local_` and hex digits and `-`, as HOST_SESSION_ID in src/lib/transcript.ts and in liveness.rs
    #[test]
    fn a_record_names_a_local_id_only_in_its_one_form() {
        let record = |local: &str| json!({ "sessionId": local, "cliSessionId": "t" });
        assert_eq!(local_id_of(&record("local_0a1b-2c"), "t"), Some("local_0a1b-2c".into()));
        assert_eq!(local_id_of(&record("local_zz"), "t"), None);
        assert_eq!(local_id_of(&record("local_"), "t"), None);
        assert_eq!(local_id_of(&record("local_ab/../x"), "t"), None);
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

    /// Side chats (docs/design.md "Side chats and forked sessions of the Claude desktop app"): records shaped like the
    /// desktop app's, ids made up
    #[test]
    fn a_side_chat_is_told_by_its_record() {
        let cases = [
            ("side chat", json!({ "sessionId": "local_a", "cliSessionId": "a", "btwLoweredFrom": "medium", "forkedFromSessionId": "local_p",
                "spawnedFrom": { "sessionId": "local_p", "taskId": "task_1", "sideSession": true, "userFork": true, "btw": true, "sharedFolder": true, "name": "x-fork" } }), true),
            ("fork started by another session", json!({ "sessionId": "local_b", "forkedFromSessionId": "local_p",
                "spawnedFrom": { "sessionId": "local_p", "taskId": "task_2", "title": "t", "sideSession": true, "sharedFolder": true, "name": "n" } }), false),
            ("session started by start_session", json!({ "sessionId": "local_c",
                "spawnedFrom": { "sessionId": "local_p", "taskId": "task_3", "title": "t", "sideSession": true, "name": "n" } }), false),
            ("session the user started", json!({ "sessionId": "local_d", "cliSessionId": "d", "title": "btw: x" }), false),
            ("btw not a bool", json!({ "spawnedFrom": { "btw": "true" } }), false),
            ("btw false", json!({ "spawnedFrom": { "btw": false, "userFork": true } }), false),
        ];
        for (name, record, expected) in cases {
            assert_eq!(is_side_chat_record(&record), expected, "{name}");
        }
    }

    #[test]
    fn side_chats_are_looked_up_by_their_record_name() {
        let dir = std::env::temp_dir().join(format!("tomarigi-desktop-side-chats-test-{}", std::process::id()));
        let deep = dir.join("org").join("account");
        let other = dir.join("org").join("other-account");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        const BTW: &str = "local_0a1b2c3d-0000-4000-8000-0000000000b1";
        const FORK: &str = "local_0a1b2c3d-0000-4000-8000-0000000000f1";
        const MAIN: &str = "local_0a1b2c3d-0000-4000-8000-0000000000a1";
        const HALF: &str = "local_0a1b2c3d-0000-4000-8000-0000000000c1";
        const MISSING: &str = "local_0a1b2c3d-0000-4000-8000-0000000000d1";
        std::fs::write(deep.join(format!("{BTW}.json")), format!(r#"{{"sessionId":"{BTW}","spawnedFrom":{{"sessionId":"{MAIN}","btw":true,"userFork":true}}}}"#)).unwrap();
        std::fs::write(other.join(format!("{FORK}.json")), format!(r#"{{"sessionId":"{FORK}","forkedFromSessionId":"{MAIN}","spawnedFrom":{{"sessionId":"{MAIN}","taskId":"task_1"}}}}"#)).unwrap();
        std::fs::write(deep.join(format!("{MAIN}.json")), format!(r#"{{"sessionId":"{MAIN}","cliSessionId":"t"}}"#)).unwrap();
        // Half written: no answer yet, asked again on the next load
        std::fs::write(deep.join(format!("{HALF}.json")), r#"{"sessionId":"local_0a1b2c3d-0000-4000-8000-0000000000c1","spawnedFrom":{"btw":tr"#).unwrap();
        // Directly under dir is not where records are
        std::fs::write(dir.join(format!("{MISSING}.json")), r#"{"spawnedFrom":{"btw":true}}"#).unwrap();
        let ids: Vec<String> = [BTW, FORK, MAIN, HALF, MISSING, "local_../org/account/x", "t-not-local"].iter().map(|s| s.to_string()).collect();
        let mut scan = side_chats(&dir, &ids);
        scan.answers.sort();
        let mut expected = vec![(BTW.to_string(), true), (FORK.to_string(), false), (MAIN.to_string(), false)];
        expected.sort();
        assert_eq!(scan, SideChatScan { answers: expected, reliable: true });
        assert_eq!(side_chats(&dir, &[]), SideChatScan { answers: Vec::new(), reliable: true });
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(side_chats(Path::new("/nonexistent-tomarigi"), &[BTW.to_string()]), SideChatScan { answers: Vec::new(), reliable: false });
    }
}
