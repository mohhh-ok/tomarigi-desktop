// ---- Liveness of sessions and watching links ----
// The process lookups behind liveness are one implementation per OS (docs/design.md "Platforms"): ps and lsof on
// macOS; /proc on Linux (ps only for the list of processes with a terminal); sysinfo and the Restart Manager on
// Windows, which has neither ps nor lsof

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::process::Command;

use crate::{expand, is_host_session_id};
use crate::fs::io_err;

/// A running Claude Code session, used to look up names for watching links (docs/design.md "Watching").
/// Part of `<config>/sessions/<pid>.json`
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSession {
    pid: u32,
    session_id: String,
    #[serde(default)]
    name: Option<String>,
    /// Who gave the name: "user" (/rename, --name) or "derived" (made up from the project's name)
    /// (docs/design.md "Display names")
    #[serde(default)]
    name_source: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    status: Option<String>,
    /// What a waiting session waits on, e.g. "input needed" (a question tool) or "permission prompt"
    /// (docs/design.md "Concierge")
    #[serde(default)]
    waiting_for: Option<String>,
    #[serde(default)]
    started_at: Option<f64>,
    /// The Claude desktop app's `local_…` id of this session (watching links; docs/design.md "Watching")
    #[serde(default)]
    host_session_id: Option<String>,
}

/// Result of live_sessions. present is whether `<config_dir>/sessions` exists (older versions without it are not
/// supported: there is no pid to check, so their sessions get no birds. docs/design.md "Removing birds of ended
/// sessions").
/// reliable is whether this run's result can be used to say "not alive". It is false on runs where ps didn't
/// work and on runs where reading or parsing some sessions/*.json file failed (Claude Code rewrites this file on
/// every state change, so a half-written file may be read). Birds are not removed on runs where it is false
#[derive(Serialize)]
pub(crate) struct LiveScan {
    present: bool,
    sessions: Vec<LiveSession>,
    reliable: bool,
}

/// How long ps / lsof may take for a liveness check (lsof on thread-writer-locks measured 0.16–0.18s). A run that
/// takes longer is killed and treated as unreliable, so a hung command neither blocks the poll nor removes birds
#[cfg_attr(windows, allow(dead_code))]
const LIVENESS_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Runs cmd and collects its output, or None if it couldn't be launched or didn't finish within timeout (it is
/// killed then)
#[cfg_attr(windows, allow(dead_code))]
fn output_with_timeout(cmd: &mut Command, timeout: std::time::Duration) -> Option<std::process::Output> {
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    // Read the pipes on their own threads so a large output can't fill the pipe and stall the child
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some(std::process::Output { status, stdout: out_reader.join().ok()?, stderr: err_reader.join().ok()? })
}

/// The `<config_dir>/sessions/*.json` entries whose process is alive. Calls ps once and narrows to live pids, so
/// that files left behind by crashed processes are not counted as watching peers and their birds can be removed.
/// Runs off the main thread (it is polled every few seconds)
#[tauri::command]
pub(crate) async fn live_sessions(config_dir: String) -> LiveScan {
    tauri::async_runtime::spawn_blocking(move || live_sessions_blocking(&config_dir))
        .await
        .unwrap_or(LiveScan { present: true, sessions: Vec::new(), reliable: false })
}

fn live_sessions_blocking(config_dir: &str) -> LiveScan {
    let dir = expand(config_dir).join("sessions");
    let items = match std::fs::read_dir(&dir) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LiveScan { present: false, sessions: Vec::new(), reliable: true };
        }
        // Exists but couldn't be read: don't conclude anything (birds stay)
        Err(_) => return LiveScan { present: true, sessions: Vec::new(), reliable: false },
    };
    let mut unreadable = 0;
    let mut sessions: Vec<LiveSession> = Vec::new();
    for path in items.flatten().map(|item| item.path()) {
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<LiveSession>(&text).ok()) {
            Some(session) => sessions.push(session),
            None => unreadable += 1,
        }
    }
    if sessions.is_empty() {
        return LiveScan { present: true, sessions, reliable: unreadable == 0 };
    }
    let pids: Vec<u32> = sessions.iter().map(|s| s.pid).collect();
    let Some((alive, ps_ok)) = running_pids(&pids) else {
        return LiveScan { present: true, sessions: Vec::new(), reliable: false };
    };
    sessions.retain(|s| alive.contains(&s.pid));
    LiveScan { present: true, sessions, reliable: ps_ok && unreadable == 0 }
}

/// Which of pids are running, and whether the answer can be trusted. None when the lookup couldn't be made at all
#[cfg(target_os = "macos")]
fn running_pids(pids: &[u32]) -> Option<(std::collections::HashSet<u32>, bool)> {
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    // ps -p returns exit code 1 when some of the given pids don't exist (the output is correct). Failing to
    // launch, timing out, or dying from a signal (no exit code) counts as failure
    let out = output_with_timeout(Command::new("ps").args(["-o", "pid=", "-p", &list]), LIVENESS_CMD_TIMEOUT)?;
    let alive = String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|p| p.parse().ok()).collect();
    Some((alive, out.status.code().is_some_and(|c| c == 0 || c == 1)))
}

/// Linux: a running process has /proc/<pid>
#[cfg(target_os = "linux")]
fn running_pids(pids: &[u32]) -> Option<(std::collections::HashSet<u32>, bool)> {
    if !std::path::Path::new("/proc/self").exists() {
        return None;
    }
    Some((pids.iter().copied().filter(|p| std::path::Path::new(&format!("/proc/{p}")).exists()).collect(), true))
}

#[cfg(windows)]
fn running_pids(pids: &[u32]) -> Option<(std::collections::HashSet<u32>, bool)> {
    let sys = win::snapshot(win::Detail::Bare);
    Some((pids.iter().copied().filter(|p| sys.process(sysinfo::Pid::from_u32(*p)).is_some()).collect(), true))
}

/// sysinfo on Windows: a snapshot of the processes, with only the details a caller needs
#[cfg(windows)]
pub(crate) mod win {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    pub(crate) enum Detail {
        /// pid and parent only
        Bare,
        /// with command lines (tty_processes)
        Command,
        /// with working directories (process_cwds)
        Cwd,
    }

    pub(crate) fn snapshot(detail: Detail) -> System {
        let kind = ProcessRefreshKind::nothing();
        let kind = match detail {
            Detail::Bare => kind,
            Detail::Command => kind.with_cmd(UpdateKind::Always).with_exe(UpdateKind::Always),
            Detail::Cwd => kind.with_cwd(UpdateKind::Always),
        };
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        sys
    }
}


/// The transcript's first prompt, for telling a session started by another session (docs/design.md "Watching").
/// Read only when the scan starts at the top of the file
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirstPrompt {
    /// turnOrigin of the first prompt ("human", "sdk", "host_synthetic", ...), when written
    turn_origin: Option<String>,
    /// An agent-name line came before it (the session was given a name when it was launched)
    named_at_launch: bool,
    /// Timestamp of the SessionStart hook's line before it, when there is one
    session_start_at: Option<String>,
    /// Timestamp of the first prompt
    at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerScan {
    /// (peer name, timestamp string of that trace)
    names: Vec<(String, String)>,
    /// Set when this scan read the first prompt (it starts at the top of the file)
    first_prompt: Option<FirstPrompt>,
    /// Whether the last prompt that started a turn after the first prompt, in the part read, was typed by the user
    /// (turn_prompt_typed); None when the part read has none, so the previous answer stands. A session started by
    /// another session whose latest turn the user started isn't taken over by its parent (docs/design.md "Watching")
    last_turn_typed: Option<bool>,
    /// Position read up to (the next read starts here). Does not include a last line cut off midway
    end: u64,
}

/// Drops the display " [ref]" from a SendMessage recipient. "main" (the parent conversation) is not a link between
/// sessions
fn peer_name_of(to: &str) -> Option<String> {
    let name = match to.rfind(" [") {
        Some(i) if to.ends_with(']') => &to[..i],
        _ => to,
    }
    .trim();
    (!name.is_empty() && name != "main").then(|| name.to_string())
}

/// Whether a line is a prompt that starts a turn, and if so whether the user typed it. A prompt is a user line, not a
/// subagent's or a tool result, and not meta unless it is a message from another session (written as a meta line with
/// turnOrigin "peer"). It is typed when its turnOrigin is "human" (or, in transcripts without turnOrigin, its
/// origin.kind). Messages from other sessions are "peer", task notifications "task_notification", and the desktop
/// app's own turns "sdk" / "host_synthetic". What arrives while it works is an attachment (queued_command): a prompt
/// the user typed into it then (origin.kind "human") counts as typed; messages from other sessions and task
/// notifications don't count
fn turn_prompt_typed(entry: &serde_json::Value) -> Option<bool> {
    if entry.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return None;
    }
    match entry.get("type").and_then(|t| t.as_str()) {
        Some("user") => {}
        Some("attachment") => {
            let typed = entry.pointer("/attachment/type").and_then(|t| t.as_str()) == Some("queued_command")
                && entry.pointer("/attachment/origin/kind").and_then(|k| k.as_str()) == Some("human");
            return typed.then_some(true);
        }
        _ => return None,
    }
    let turn_origin = entry.get("turnOrigin").and_then(|t| t.as_str());
    let origin_kind = entry.pointer("/origin/kind").and_then(|k| k.as_str());
    if entry.get("isMeta").and_then(|v| v.as_bool()) == Some(true) && turn_origin != Some("peer") && origin_kind != Some("peer") {
        return None;
    }
    let blocks = entry.pointer("/message/content").and_then(|c| c.as_array());
    if blocks.into_iter().flatten().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result")) {
        return None;
    }
    match (turn_origin, origin_kind) {
        (Some(origin), _) => Some(!written_by_app(Some(origin))),
        (None, Some(kind)) => Some(kind == "human"),
        // A line that says nothing of where it came from isn't counted (as before turnOrigin was read)
        (None, None) => None,
    }
}

/// The id in the text of the desktop app's start_session result: `Started session "…" (session_id: local_…, …)`
fn started_session_id(text: &str) -> Option<String> {
    if !text.starts_with("Started session ") {
        return None;
    }
    let i = text.find("(session_id: ")?;
    let rest = &text[i + 13..];
    let end = rest.find(|c: char| c == ',' || c == ')').unwrap_or(rest.len());
    let id = rest[..end].trim();
    is_host_session_id(id).then(|| id.to_string())
}

/// The id in the shared notes folder the desktop app names in the first prompt of a session another session started:
/// `…/side-session-notes/local_…`, the starter's id (docs/design.md "Watching"). The id is `local_` and the hex digits
/// and `-` after it, as NOTES_FOLDER_ID in lib/transcript.ts
fn notes_folder_host_id(text: &str) -> Option<String> {
    // The first place the folder is named with an id, as the regex does (not only the first place it is named)
    text.match_indices("side-session-notes/").find_map(|(i, mark)| {
        let rest = text[i + mark.len()..].strip_prefix("local_")?;
        let end = rest.find(|c: char| !(c.is_ascii_hexdigit() || c == '-')).unwrap_or(rest.len());
        let id = format!("local_{}", &rest[..end]);
        is_host_session_id(&id).then_some(id)
    })
}

/// Whether a prompt's turnOrigin says the app wrote it, not the user: anything but "human" (the desktop app's "sdk" /
/// "host_synthetic", another session's "peer", ...). Same rule as writtenByApp in lib/watching.ts
fn written_by_app(turn_origin: Option<&str>) -> bool {
    turn_origin.is_some_and(|o| o != "human")
}

/// The text of a message's content: a string, or its text blocks joined by newlines (messageText in lib/transcript.ts)
fn message_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(t)) => t.clone(),
        Some(serde_json::Value::Array(items)) => {
            items.iter().filter_map(|i| i.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n")
        }
        _ => String::new(),
    }
}

/// Whether a transcript line is another session's: its `sessionId` is a string other than own. A transcript started as a
/// fork (a side chat, or a fork another session started) begins with a copy of its parent's lines, which keep the
/// parent's `sessionId`; they aren't the session's own (docs/design.md "Side chats and forked sessions of the Claude
/// desktop app"). A line without `sessionId` counts as own. isForeignLine in lib/transcript.ts is the same rule
fn is_foreign_line(entry: &serde_json::Value, own: &str) -> bool {
    entry.get("sessionId").and_then(|v| v.as_str()).is_some_and(|id| id != own)
}

/// Picks up, from [start, end of file) of the transcript, the names of peers exchanged with via cross-session
/// messages (watching links; same rules as collectPeerNames in lib/transcript.ts). To also catch traces outside
/// the tail window, the caller remembers end and reads only what was added. Does not read message bodies; returns
/// only names and times
#[tauri::command]
pub(crate) fn scan_peer_names(path: &str, start: u64) -> Result<PeerScan, String> {
    let p = expand(path);
    let mut f = std::fs::File::open(&p).map_err(|e| io_err(&p, e))?;
    let len = f.metadata().map_err(|e| io_err(&p, e))?.len();
    let start = if start > len { 0 } else { start };
    f.seek(SeekFrom::Start(start)).map_err(|e| io_err(&p, e))?;
    // The session's own id is the transcript's file name; only its own lines are read
    let own = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).map_err(|e| io_err(&p, e))?;
    let complete = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    let mut names = Vec::new();
    // Until the first prompt is found, every line at the top is looked at (start 0 only)
    let mut looking_for_first = start == 0;
    let mut first_prompt = None;
    let mut named_at_launch = false;
    let mut session_start_at: Option<String> = None;
    let mut last_turn_typed: Option<bool> = None;
    for line in buf[..complete].split(|&b| b == b'\n') {
        // After the first prompt (read in an earlier scan when start isn't 0), the prompts that start a turn; the last
        // one read decides
        if !looking_for_first
            && (line.windows(12).any(|w| w == b"\"turnOrigin\"") || line.windows(8).any(|w| w == b"\"origin\""))
        {
            if let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) {
                if is_foreign_line(&entry, &own) {
                    continue;
                }
                if let Some(typed) = turn_prompt_typed(&entry) {
                    last_turn_typed = Some(typed);
                }
            }
        }
        if looking_for_first {
            if let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) {
                if is_foreign_line(&entry, &own) {
                    continue;
                }
                match entry.get("type").and_then(|t| t.as_str()) {
                    Some("agent-name") => named_at_launch = true,
                    Some("attachment")
                        if session_start_at.is_none()
                            && entry.pointer("/attachment/hookEvent").and_then(|h| h.as_str()) == Some("SessionStart") =>
                    {
                        session_start_at = entry.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
                    }
                    Some("user")
                        if entry.get("isMeta").and_then(|v| v.as_bool()) != Some(true)
                            && entry.get("isSidechain").and_then(|v| v.as_bool()) != Some(true) =>
                    {
                        if let Some(at) = entry.get("timestamp").and_then(|t| t.as_str()) {
                            // The first prompt of a session another session started (written by the app) names the
                            // starter's shared notes folder: a link from the start. Only the first prompt: a later
                            // notice may quote another session's folder
                            let turn_origin = entry.get("turnOrigin").and_then(|t| t.as_str());
                            if written_by_app(turn_origin) {
                                if let Some(id) = notes_folder_host_id(&message_text(entry.pointer("/message/content"))) {
                                    names.push((id, at.to_string()));
                                }
                            }
                            first_prompt = Some(FirstPrompt {
                                turn_origin: entry.get("turnOrigin").and_then(|t| t.as_str()).map(str::to_string),
                                named_at_launch,
                                session_start_at: session_start_at.clone(),
                                at: at.to_string(),
                            });
                            looking_for_first = false;
                        }
                    }
                    _ => {}
                }
            }
        }
        let is_send = line.windows(13).any(|w| w == b"\"SendMessage\"");
        let is_peer = line.windows(8).any(|w| w == b"\"origin\"")
            || line.windows(21).any(|w| w == b"cross-session-message");
        // The desktop app's traces all carry a local_… id (start_session's result, send_message's input)
        let is_host = line.windows(6).any(|w| w == b"local_");
        if !is_send && !is_peer && !is_host {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
        if is_foreign_line(&entry, &own) {
            continue;
        }
        let Some(at) = entry.get("timestamp").and_then(|t| t.as_str()) else { continue };
        if entry.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        match entry.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                let blocks = entry.pointer("/message/content").and_then(|c| c.as_array());
                for block in blocks.into_iter().flatten() {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                        continue;
                    }
                    let tool = block.get("name").and_then(|n| n.as_str()).unwrap_or_default();
                    let name = if tool == "SendMessage" {
                        block.pointer("/input/to").and_then(|t| t.as_str()).and_then(peer_name_of)
                    } else if tool.ends_with("__send_message") {
                        // The desktop app's send_message to one of its sessions
                        block
                            .pointer("/input/session_id")
                            .and_then(|t| t.as_str())
                            .filter(|id| is_host_session_id(id))
                            .map(str::to_string)
                    } else {
                        None
                    };
                    if let Some(name) = name {
                        names.push((name, at.to_string()));
                    }
                }
            }
            // Messages that arrive while working are recorded in an attachment (queued_command) with the same origin
            Some("attachment") => {
                if entry.pointer("/attachment/origin/kind").and_then(|k| k.as_str()) == Some("peer") {
                    if let Some(name) = entry.pointer("/attachment/origin/name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()) {
                        names.push((name.to_string(), at.to_string()));
                    }
                    if let Some(from) = entry.pointer("/attachment/origin/from").and_then(|n| n.as_str()).filter(|n| is_host_session_id(n)) {
                        names.push((from.to_string(), at.to_string()));
                    }
                }
            }
            Some("user") if entry.get("isMeta").and_then(|v| v.as_bool()) == Some(true) => {
                let origin_name = (entry.pointer("/origin/kind").and_then(|k| k.as_str()) == Some("peer"))
                    .then(|| entry.pointer("/origin/name").and_then(|n| n.as_str()))
                    .flatten()
                    .filter(|n| !n.is_empty());
                if let Some(name) = origin_name {
                    names.push((name.to_string(), at.to_string()));
                    if let Some(from) = entry.pointer("/origin/from").and_then(|n| n.as_str()).filter(|n| is_host_session_id(n)) {
                        names.push((from.to_string(), at.to_string()));
                    }
                    continue;
                }
                let text = message_text(entry.pointer("/message/content"));
                let mut rest = text.as_str();
                while let Some(i) = rest.find("<cross-session-message") {
                    rest = &rest[i..];
                    let tag_end = rest.find('>').unwrap_or(rest.len());
                    let tag = &rest[..tag_end];
                    if let Some(j) = tag.find("from-name=\"") {
                        let value = &tag[j + 11..];
                        if let Some(k) = value.find('"') {
                            names.push((value[..k].to_string(), at.to_string()));
                        }
                    }
                    rest = &rest[tag_end..];
                }
            }
            // The tool result that started a desktop app session carries its id in the text
            Some("user") => {
                let blocks = entry.pointer("/message/content").and_then(|c| c.as_array());
                for block in blocks.into_iter().flatten() {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    if let Some(id) = started_session_id(&message_text(block.get("content"))) {
                        names.push((id, at.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(PeerScan { names, first_prompt, last_turn_typed, end: start + complete as u64 })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexThread {
    pub(crate) thread_id: String,
    pub(crate) pid: u32,
    /// The lock is held by the `codex app-server` that codex TUIs share (from codex-cli 0.162.1 or earlier, measured
    /// with 0.163.0): pid is that server's, not the TUI's, and the lock stays held after the TUI exits
    pub(crate) shared: bool,
}

/// Result of live_codex_threads. reliable is false when lsof couldn't be run or reported an error; birds are
/// not removed on such runs (docs/design.md "Removing birds of ended sessions")
#[derive(Serialize)]
pub(crate) struct CodexLiveScan {
    pub(crate) threads: Vec<CodexThread>,
    reliable: bool,
}

/// Codex threads whose process is alive. A running codex keeps `<codex_dir>/thread-writer-locks/<threadId>.lock`
/// open; the lock file stays after codex exits, so only files some process has open count (measured with
/// codex-cli 0.156.1; not a public Codex spec). When TUIs share a `codex app-server` (measured with 0.163.0), that
/// server holds the locks, also of threads whose TUI has exited; those are marked shared and the JS side matches
/// them to TUI processes instead
/// Runs off the main thread (it is polled every few seconds)
#[tauri::command]
pub(crate) async fn live_codex_threads(codex_dir: String) -> CodexLiveScan {
    tauri::async_runtime::spawn_blocking(move || live_codex_threads_blocking(&codex_dir))
        .await
        .unwrap_or(CodexLiveScan { threads: Vec::new(), reliable: false })
}

fn live_codex_threads_blocking(codex_dir: &str) -> CodexLiveScan {
    let dir = expand(codex_dir).join("thread-writer-locks");
    match std::fs::metadata(&dir) {
        Ok(_) => {}
        // No codex has created a thread yet
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return CodexLiveScan { threads: Vec::new(), reliable: true };
        }
        Err(_) => return CodexLiveScan { threads: Vec::new(), reliable: false },
    }
    match lock_holders(&dir) {
        Some(held) => {
            let mut pids: Vec<u32> = held.iter().map(|(_, pid)| *pid).collect();
            pids.sort_unstable();
            pids.dedup();
            let servers = app_server_pids(&pids);
            let mut threads: Vec<CodexThread> = Vec::new();
            for (file, pid) in held {
                if let Some(thread_id) = thread_of_lock(&file) {
                    if !threads.iter().any(|t| t.thread_id == thread_id) {
                        threads.push(CodexThread { thread_id: thread_id.to_string(), pid, shared: servers.contains(&pid) });
                    }
                }
            }
            CodexLiveScan { threads, reliable: true }
        }
        None => CodexLiveScan { threads: Vec::new(), reliable: false },
    }
}

/// Whether a command line runs `codex app-server` (an `app-server` argument; argv[0] may hold spaces when renamed)
fn is_app_server(command: &str) -> bool {
    command.split_whitespace().any(|arg| arg == "app-server")
}

/// The pids among pids whose command line is a `codex app-server`. A pid whose command line can't be read counts as
/// not one (the lock is then read as before: its holder is the codex that has the thread open)
#[cfg(target_os = "macos")]
fn app_server_pids(pids: &[u32]) -> Vec<u32> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let Some(out) = output_with_timeout(Command::new("ps").args(["-ww", "-o", "pid=,command=", "-p", &list]), LIVENESS_CMD_TIMEOUT) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (pid, command) = line.trim_start().split_once(char::is_whitespace)?;
            is_app_server(command).then(|| pid.parse().ok()).flatten()
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn app_server_pids(pids: &[u32]) -> Vec<u32> {
    pids.iter()
        .copied()
        .filter(|pid| {
            std::fs::read(format!("/proc/{pid}/cmdline"))
                .map(|raw| is_app_server(&String::from_utf8_lossy(&raw).replace('\0', " ")))
                .unwrap_or(false)
        })
        .collect()
}

/// Windows: the holder's command line isn't read; locks are read as before
#[cfg(windows)]
fn app_server_pids(_pids: &[u32]) -> Vec<u32> {
    Vec::new()
}

/// The thread id of a lock file name: only `<threadId>.lock` (not .coordination.lock etc.)
fn thread_of_lock(file: &str) -> Option<&str> {
    let thread_id = file.strip_suffix(".lock")?;
    (!thread_id.is_empty() && !thread_id.starts_with('.')).then_some(thread_id)
}

/// (file name, pid) for each file in dir that a process has open. None when the lookup failed
#[cfg(target_os = "macos")]
fn lock_holders(dir: &std::path::Path) -> Option<Vec<(String, u32)>> {
    // lsof exits with 1 both when nothing is open and when something is found (measured on macOS), so the exit
    // code value isn't used. -w silences warnings, so anything on stderr is a failure. Failing to launch, timing
    // out, or dying from a signal (no exit code) is a failure too
    let out = output_with_timeout(Command::new("lsof").arg("-w").args(["-F", "pn", "+d"]).arg(dir), LIVENESS_CMD_TIMEOUT)?;
    if !out.stderr.is_empty() || out.status.code().is_none() {
        return None;
    }
    let mut held = Vec::new();
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(name), Some(pid)) = (line.strip_prefix('n'), pid) {
            held.push((name.rsplit('/').next().unwrap_or("").to_string(), pid));
        }
    }
    Some(held)
}

/// Linux: the open files of every process this user can read, from the /proc/<pid>/fd links
#[cfg(target_os = "linux")]
fn lock_holders(dir: &std::path::Path) -> Option<Vec<(String, u32)>> {
    let dir = dir.canonicalize().ok()?;
    let mut held = Vec::new();
    for item in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = item.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        // Other users' processes can't be read; codex runs as this user
        let Ok(fds) = std::fs::read_dir(item.path().join("fd")) else { continue };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            if target.parent() == Some(dir.as_path()) {
                if let Some(name) = target.file_name().and_then(|n| n.to_str()) {
                    held.push((name.to_string(), pid));
                }
            }
        }
    }
    Some(held)
}

/// Windows: a file some process has open can't be opened without sharing (ERROR_SHARING_VIOLATION); the Restart
/// Manager then names the process for those files only (one session per file, since its list isn't per file)
#[cfg(windows)]
fn lock_holders(dir: &std::path::Path) -> Option<Vec<(String, u32)>> {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let mut held = Vec::new();
    for item in std::fs::read_dir(dir).ok()?.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if thread_of_lock(&name).is_none() {
            continue;
        }
        let path = item.path();
        match std::fs::OpenOptions::new().read(true).share_mode(0).open(&path) {
            Ok(_) => continue,
            Err(e) if e.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => {}
            Err(_) => continue,
        }
        if let Some(pid) = win_rm::holders(&path)?.first() {
            held.push((name, *pid));
        }
    }
    Some(held)
}

/// The Restart Manager (RmGetList): which processes have a file open
#[cfg(windows)]
mod win_rm {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_MORE_DATA, WIN32_ERROR};
    use windows::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY, RM_PROCESS_INFO,
    };

    /// pids that have path open. None when the Restart Manager failed
    pub(super) fn holders(path: &std::path::Path) -> Option<Vec<u32>> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut session = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        unsafe {
            if RmStartSession(&mut session, None, PWSTR(key.as_mut_ptr())) != WIN32_ERROR(0) {
                return None;
            }
            let result = (|| {
                let files = [PCWSTR(wide.as_ptr())];
                if RmRegisterResources(session, Some(&files), None, None) != WIN32_ERROR(0) {
                    return None;
                }
                let mut infos: Vec<RM_PROCESS_INFO> = vec![RM_PROCESS_INFO::default(); 4];
                loop {
                    let mut needed = 0u32;
                    let mut count = infos.len() as u32;
                    let mut reasons = 0u32;
                    let r = RmGetList(session, &mut needed, &mut count, Some(infos.as_mut_ptr()), &mut reasons);
                    if r == ERROR_MORE_DATA {
                        infos.resize(needed as usize + 1, RM_PROCESS_INFO::default());
                        continue;
                    }
                    if r != WIN32_ERROR(0) {
                        return None;
                    }
                    return Some(infos[..count as usize].iter().map(|i| i.Process.dwProcessId).collect());
                }
            })();
            let _ = RmEndSession(session);
            result
        }
    }
}

// ---- Agents without a pid file (docs/design.md "Agents") ----

/// A process with a terminal. started_at_ms is derived from ps's elapsed time, so it is accurate to the second
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TtyProcess {
    pid: u32,
    tty: String,
    started_at_ms: f64,
    command: String,
}

#[derive(Serialize)]
pub(crate) struct ProcessScan {
    processes: Vec<TtyProcess>,
    reliable: bool,
}

/// Every process that has a tty (`ps axww -o pid=,tty=,etime=,command=`). The JS side (src/lib/agent-processes.ts)
/// picks each agent's processes out of the command lines; processes without a tty (`??`) are left out here
#[tauri::command]
pub(crate) async fn tty_processes() -> ProcessScan {
    tauri::async_runtime::spawn_blocking(tty_processes_blocking)
        .await
        .unwrap_or(ProcessScan { processes: Vec::new(), reliable: false })
}

#[cfg(windows)]
fn tty_processes_blocking() -> ProcessScan {
    // Windows has no ttys, so every process with a command line is listed (tty is left empty)
    let sys = win::snapshot(win::Detail::Command);
    let processes = sys
        .processes()
        .iter()
        .filter(|(_, p)| !p.cmd().is_empty())
        .map(|(pid, p)| {
            // Arguments with spaces (C:\Program Files\..., a user name with a space) are quoted, so argvOf in
            // src/lib/agent-processes.ts reads them as one
            let command = p
                .cmd()
                .iter()
                .map(|a| {
                    let a = a.to_string_lossy();
                    if a.contains(char::is_whitespace) { format!("\"{a}\"") } else { a.into_owned() }
                })
                .collect::<Vec<_>>()
                .join(" ");
            TtyProcess {
                pid: pid.as_u32(),
                tty: String::new(),
                started_at_ms: p.start_time() as f64 * 1000.0,
                command: command.chars().take(400).collect(),
            }
        })
        .collect();
    ProcessScan { processes, reliable: true }
}

/// `ps` on macOS and Linux (procps prints the same columns; a process without a tty shows "?" there)
#[cfg(not(windows))]
fn tty_processes_blocking() -> ProcessScan {
    let Some(out) =
        output_with_timeout(Command::new("ps").args(["axww", "-o", "pid=,tty=,etime=,command="]), LIVENESS_CMD_TIMEOUT)
    else {
        return ProcessScan { processes: Vec::new(), reliable: false };
    };
    if !out.status.success() {
        return ProcessScan { processes: Vec::new(), reliable: false };
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let processes = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| parse_ps_line(line, now_ms))
        .collect();
    ProcessScan { processes, reliable: true }
}

/// One line of `ps -o pid=,tty=,etime=,command=`. None for processes without a tty and for lines that don't parse
#[cfg_attr(windows, allow(dead_code))]
fn parse_ps_line(line: &str, now_ms: f64) -> Option<TtyProcess> {
    let mut rest = line.trim_start();
    let mut field = || {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let value = &rest[..end];
        rest = rest[end..].trim_start();
        value
    };
    let pid = field().parse().ok()?;
    let tty = field().to_string();
    let elapsed = elapsed_secs(field())?;
    if tty == "??" || tty == "?" || tty == "-" || rest.is_empty() {
        return None;
    }
    // Long command lines (a prompt passed as an argument) are cut; only the program and its first arguments are used
    let command: String = rest.chars().take(400).collect();
    Some(TtyProcess { pid, tty, started_at_ms: now_ms - elapsed as f64 * 1000.0, command })
}

/// ps's etime: `[[dd-]hh:]mm:ss`
#[cfg_attr(windows, allow(dead_code))]
fn elapsed_secs(etime: &str) -> Option<u64> {
    let (days, clock) = match etime.split_once('-') {
        Some((d, c)) => (d.parse::<u64>().ok()?, c),
        None => (0, etime),
    };
    let mut secs = 0;
    for part in clock.split(':') {
        secs = secs * 60 + part.parse::<u64>().ok()?;
    }
    Some(days * 86_400 + secs)
}

#[derive(Serialize)]
pub(crate) struct CwdScan {
    /// (pid, cwd)
    cwds: Vec<(u32, String)>,
    reliable: bool,
}

/// The working directory of each pid (`lsof -a -d cwd -p <pids> -Fn`). A pid that ended in the meantime is just
/// missing from the result
#[tauri::command]
pub(crate) async fn process_cwds(pids: Vec<u32>) -> CwdScan {
    tauri::async_runtime::spawn_blocking(move || process_cwds_blocking(&pids))
        .await
        .unwrap_or(CwdScan { cwds: Vec::new(), reliable: false })
}

/// Linux: the /proc/<pid>/cwd link
#[cfg(target_os = "linux")]
fn process_cwds_blocking(pids: &[u32]) -> CwdScan {
    let cwds = pids
        .iter()
        .filter_map(|p| std::fs::read_link(format!("/proc/{p}/cwd")).ok().map(|d| (*p, d.to_string_lossy().into_owned())))
        .collect();
    CwdScan { cwds, reliable: true }
}

#[cfg(windows)]
fn process_cwds_blocking(pids: &[u32]) -> CwdScan {
    if pids.is_empty() {
        return CwdScan { cwds: Vec::new(), reliable: true };
    }
    let sys = win::snapshot(win::Detail::Cwd);
    let cwds = pids
        .iter()
        .filter_map(|p| {
            let cwd = sys.process(sysinfo::Pid::from_u32(*p))?.cwd()?;
            Some((*p, cwd.to_string_lossy().into_owned()))
        })
        .collect();
    CwdScan { cwds, reliable: true }
}

#[cfg(target_os = "macos")]
fn process_cwds_blocking(pids: &[u32]) -> CwdScan {
    if pids.is_empty() {
        return CwdScan { cwds: Vec::new(), reliable: true };
    }
    let list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    // lsof exits with 1 when one of the pids is gone, with the rest still listed, so the exit code isn't used.
    // -w silences warnings; a run that couldn't launch, timed out, or died from a signal is a failure
    let Some(out) = output_with_timeout(
        Command::new("lsof").args(["-w", "-a", "-d", "cwd", "-p", &list, "-Fn"]),
        LIVENESS_CMD_TIMEOUT,
    ) else {
        return CwdScan { cwds: Vec::new(), reliable: false };
    };
    if out.status.code().is_none() {
        return CwdScan { cwds: Vec::new(), reliable: false };
    }
    let mut cwds = Vec::new();
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(name), Some(p)) = (line.strip_prefix('n'), pid) {
            cwds.push((p, name.to_string()));
        }
    }
    CwdScan { cwds, reliable: true }
}

#[derive(Serialize)]
pub(crate) struct PidScan {
    alive: Vec<u32>,
    reliable: bool,
}

/// Which of the pids are running (Qwen Code's `<sessionId>.runtime.json` stays after the process ends)
#[tauri::command]
pub(crate) async fn alive_pids(pids: Vec<u32>) -> PidScan {
    tauri::async_runtime::spawn_blocking(move || alive_pids_blocking(&pids))
        .await
        .unwrap_or(PidScan { alive: Vec::new(), reliable: false })
}

fn alive_pids_blocking(pids: &[u32]) -> PidScan {
    if pids.is_empty() {
        return PidScan { alive: Vec::new(), reliable: true };
    }
    // Same as live_sessions (on macOS ps -p exits with 1 when some pids don't exist)
    let Some((alive, ok)) = running_pids(pids) else {
        return PidScan { alive: Vec::new(), reliable: false };
    };
    // In the order asked for
    PidScan { alive: pids.iter().copied().filter(|p| alive.contains(p)).collect(), reliable: ok }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Watching links (docs/design.md "Watching"): each kind of trace, one line each, and the names it gives
    #[test]
    fn scan_peer_names_reads_each_kind_of_trace() {
        const ID: &str = "local_3f97c278-cf60-45f9-b227-66ded583d16f";
        let cases: Vec<(&str, String, Vec<&str>)> = vec![
            (
                "SendMessage to a name",
                r#"{"type":"assistant","timestamp":"T","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"to":"web-build [3fa9c1]"}}]}}"#.into(),
                vec!["web-build"],
            ),
            (
                "SendMessage to the desktop app's id",
                format!(r#"{{"type":"assistant","timestamp":"T","message":{{"content":[{{"type":"tool_use","name":"SendMessage","input":{{"to":"{ID}"}}}}]}}}}"#),
                vec![ID],
            ),
            (
                "the desktop app's send_message",
                format!(r#"{{"type":"assistant","timestamp":"T","message":{{"content":[{{"type":"tool_use","name":"mcp__ccd_session_mgmt__send_message","input":{{"session_id":"{ID}","message":"x"}}}}]}}}}"#),
                vec![ID],
            ),
            (
                "start_session's result",
                format!(r#"{{"type":"user","timestamp":"T","message":{{"content":[{{"type":"tool_result","tool_use_id":"t","content":[{{"type":"text","text":"Started session \"Fix it\" (session_id: {ID}, name: fix-it). It runs on its own"}}]}}]}}}}"#),
                vec![ID],
            ),
            (
                "a tool result that only mentions an id is not a start",
                format!(r#"{{"type":"user","timestamp":"T","message":{{"content":[{{"type":"tool_result","tool_use_id":"t","content":"see {ID}"}}]}}}}"#),
                vec![],
            ),
            (
                "a received message: name and the desktop app's id",
                format!(r#"{{"type":"user","isMeta":true,"timestamp":"T","origin":{{"kind":"peer","from":"{ID}","name":"Fix it"}},"message":{{"content":"x"}}}}"#),
                vec!["Fix it", ID],
            ),
            (
                "a received message from a terminal session: name only",
                r#"{"type":"user","isMeta":true,"timestamp":"T","origin":{"kind":"peer","from":"uds:/tmp/cc-socks/1.sock","name":"web-build"},"message":{"content":"x"}}"#.into(),
                vec!["web-build"],
            ),
            (
                "a message that arrived mid-work",
                format!(r#"{{"type":"attachment","timestamp":"T","attachment":{{"origin":{{"kind":"peer","from":"{ID}","name":"Fix it"}}}}}}"#),
                vec!["Fix it", ID],
            ),
            (
                "the starter's notes folder in a prompt the desktop app wrote (a session started from a proposal card)",
                format!(r#"{{"type":"user","timestamp":"T","turnOrigin":"host_synthetic","message":{{"content":"Shared notes folder for this group of sessions: /Users/x/Library/Application Support/Claude/side-session-notes/{ID}\n"}}}}"#),
                vec![ID],
            ),
            (
                "the notes folder in text blocks of a prompt started by start_session",
                format!(r#"{{"type":"user","timestamp":"T","turnOrigin":"sdk","message":{{"content":[{{"type":"text","text":"notes: /a/side-session-notes/{ID}"}}]}}}}"#),
                vec![ID],
            ),
            (
                "a grandchild names only its direct starter (the child), not the session that started the child",
                r#"{"type":"user","timestamp":"T","turnOrigin":"sdk","message":{"content":"notes: /a/side-session-notes/local_0a1b2c3d-0000-4000-8000-0000000000bb\nThe top session is local_0a1b2c3d-0000-4000-8000-0000000000aa"}}"#.into(),
                vec!["local_0a1b2c3d-0000-4000-8000-0000000000bb"],
            ),
            (
                "the notes folder in a prompt the user typed is not a link",
                format!(r#"{{"type":"user","timestamp":"T","turnOrigin":"human","message":{{"content":"look at /a/side-session-notes/{ID}"}}}}"#),
                vec![],
            ),
            (
                "a subagent's line is not a link",
                format!(r#"{{"type":"assistant","isSidechain":true,"timestamp":"T","message":{{"content":[{{"type":"tool_use","name":"SendMessage","input":{{"to":"{ID}"}}}}]}}}}"#),
                vec![],
            ),
        ];
        let dir = std::env::temp_dir().join(format!("tomarigi-peer-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, (scene, line, want)) in cases.iter().enumerate() {
            let path = dir.join(format!("{i}.jsonl"));
            std::fs::write(&path, format!("{line}\n")).unwrap();
            let scan = scan_peer_names(path.to_str().unwrap(), 0).unwrap();
            let got: Vec<&str> = scan.names.iter().map(|(n, _)| n.as_str()).collect();
            assert_eq!(&got, want, "{scene}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The starter's notes folder links only from the first prompt, and only when the app wrote it
    #[test]
    fn scan_peer_names_reads_the_notes_folder_of_the_first_prompt_only() {
        const CHILD: &str = "local_0a1b2c3d-0000-4000-8000-0000000000bb";
        const TOP: &str = "local_0a1b2c3d-0000-4000-8000-0000000000aa";
        let first_by_app = format!(r#"{{"type":"user","timestamp":"T","turnOrigin":"sdk","message":{{"content":"notes: /a/side-session-notes/{CHILD}"}}}}"#);
        let later_notice = format!(r#"{{"type":"user","timestamp":"T","turnOrigin":"sdk","message":{{"content":"<side-sessions-event>notes are in /a/side-session-notes/{TOP}</side-sessions-event>"}}}}"#);
        let typed_first = r#"{"type":"user","timestamp":"T","turnOrigin":"human","message":{"content":"x"}}"#.to_string();
        let meta = r#"{"type":"user","isMeta":true,"timestamp":"T","message":{"content":"x"}}"#.to_string();
        let later_form = format!(r#"{{"type":"user","timestamp":"T","turnOrigin":"sdk","message":{{"content":"see side-session-notes/README, then notes: /a/side-session-notes/{CHILD}"}}}}"#);
        let odd = r#"{"type":"user","timestamp":"T","turnOrigin":"sdk","message":{"content":"notes: /a/side-session-notes/local_0a1b2c3dzz/x"}}"#.to_string();
        let cases: Vec<(&str, Vec<String>, Vec<&str>)> = vec![
            ("a later notice naming another folder doesn't link (the first prompt's does)", vec![first_by_app.clone(), later_notice.clone()], vec![CHILD]),
            ("a session the user started: a later notice naming a folder doesn't link", vec![typed_first, later_notice], vec![]),
            ("a meta line before the first prompt isn't the first prompt", vec![meta, first_by_app], vec![CHILD]),
            ("the id is local_ and hex digits and - only (as in lib/transcript.ts)", vec![odd], vec!["local_0a1b2c3d"]),
            ("the folder named first without an id, then with one: the one with an id (as in lib/transcript.ts)", vec![later_form], vec![CHILD]),
        ];
        let dir = std::env::temp_dir().join(format!("tomarigi-notes-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, (scene, lines, want)) in cases.iter().enumerate() {
            let path = dir.join(format!("{i}.jsonl"));
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            let scan = scan_peer_names(path.to_str().unwrap(), 0).unwrap();
            let got: Vec<&str> = scan.names.iter().map(|(n, _)| n.as_str()).collect();
            assert_eq!(&got, want, "{scene}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The first prompt is read from the top of the file only, with what came before it
    #[test]
    fn scan_peer_names_reads_the_first_prompt() {
        let dir = std::env::temp_dir().join(format!("tomarigi-first-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let lines = [
            r#"{"type":"agent-name","agentName":"web-build"}"#,
            r#"{"type":"attachment","timestamp":"2026-11-09T04:45:58.312Z","attachment":{"hookEvent":"SessionStart"}}"#,
            r#"{"type":"user","isMeta":true,"timestamp":"2026-11-09T04:45:58.320Z","message":{"content":"x"}}"#,
            r#"{"type":"user","timestamp":"2026-11-09T04:45:58.331Z","turnOrigin":"human","message":{"content":"do it"}}"#,
            r#"{"type":"user","timestamp":"2026-11-09T04:46:00.000Z","turnOrigin":"sdk","message":{"content":"later"}}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let p = path.to_str().unwrap();
        let scan = scan_peer_names(p, 0).unwrap();
        assert_eq!(
            scan.first_prompt,
            Some(FirstPrompt {
                turn_origin: Some("human".into()),
                named_at_launch: true,
                session_start_at: Some("2026-11-09T04:45:58.312Z".into()),
                at: "2026-11-09T04:45:58.331Z".into(),
            })
        );
        // A scan that goes on from where the last one stopped doesn't read it again
        assert_eq!(scan_peer_names(p, 10).unwrap().first_prompt, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A transcript started as a fork begins with its parent's lines, copied with the parent's sessionId; only the
    /// session's own lines (sessionId = the file name) are read (docs/design.md "Side chats and forked sessions of the
    /// Claude desktop app"). Scenes shaped like the real records on this machine, ids and names made up
    #[test]
    fn scan_peer_names_reads_only_the_sessions_own_lines() {
        let dir = std::env::temp_dir().join(format!("tomarigi-fork-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        const OWN: &str = "0a1b2c3d-0000-4000-8000-00000000f0f0";
        const PARENT: &str = "0a1b2c3d-0000-4000-8000-00000000aaaa";
        const SIBLING: &str = "local_0a1b2c3d-0000-4000-8000-0000000000bb";
        const PARENT_HOST: &str = "local_0a1b2c3d-0000-4000-8000-0000000000aa";
        // The parent's lines as a fork's transcript copies them
        let copied = vec![
            format!(r#"{{"type":"queue-operation","sessionId":"{PARENT}","timestamp":"2026-01-01T00:00:00.000Z"}}"#),
            format!(r#"{{"type":"agent-name","agentName":"parent","sessionId":"{PARENT}"}}"#),
            format!(r#"{{"type":"user","sessionId":"{PARENT}","timestamp":"2026-01-01T00:00:01.000Z","turnOrigin":"human","origin":{{"kind":"human"}},"isSidechain":false,"message":{{"content":"task"}}}}"#),
            format!(r#"{{"type":"assistant","sessionId":"{PARENT}","timestamp":"2026-01-01T00:00:02.000Z","isSidechain":false,"message":{{"content":[{{"type":"tool_use","name":"mcp__ccd_session__send_message","input":{{"session_id":"{SIBLING}"}}}}]}}}}"#),
            format!(r#"{{"type":"user","sessionId":"{PARENT}","timestamp":"2026-01-01T00:00:03.000Z","isSidechain":false,"message":{{"content":[{{"type":"tool_result","tool_use_id":"t","content":"Started session \"x\" (session_id: {SIBLING}, name: x)"}}]}}}}"#),
            format!(r#"{{"type":"user","isMeta":true,"sessionId":"{PARENT}","timestamp":"2026-01-01T00:00:04.000Z","turnOrigin":"peer","origin":{{"kind":"peer","name":"sibling","from":"{SIBLING}"}},"message":{{"content":"report"}}}}"#),
            format!(r#"{{"type":"user","sessionId":"{PARENT}","timestamp":"2026-01-01T00:00:05.000Z","turnOrigin":"human","origin":{{"kind":"human"}},"isSidechain":false,"message":{{"content":"again"}}}}"#),
        ];
        let own = |line: &str| line.replace("@OWN@", OWN);
        // A side chat the user typed in: the app's notice of the parent's stopped task, then the typed question
        let side_chat_typed = vec![
            own(r#"{"type":"custom-title","customTitle":"side chat","sessionId":"@OWN@"}"#),
            own(r#"{"type":"assistant","sessionId":"@OWN@","timestamp":"2026-01-01T01:00:00.000Z","isSidechain":false,"message":{"content":[{"type":"text","text":"ok"}]}}"#),
            own(r#"{"type":"user","sessionId":"@OWN@","timestamp":"2026-01-01T01:00:01.000Z","origin":{"kind":"task-notification"},"isSidechain":false,"message":{"content":"<task-notification>x</task-notification>"}}"#),
            own(r#"{"type":"user","sessionId":"@OWN@","timestamp":"2026-01-01T01:00:02.000Z","turnOrigin":"human","origin":{"kind":"human"},"isSidechain":false,"message":{"content":[{"type":"text","text":"<system-reminder>\n## The user forked this session from another session\n</system-reminder>\n\nwhat is X"}]}}"#),
            own(r#"{"type":"system","subtype":"stop_hook_summary","sessionId":"@OWN@","timestamp":"2026-01-01T01:00:08.000Z"}"#),
        ];
        // A side chat closed without typing: only untimed lines of its own
        let side_chat_closed = vec![
            own(r#"{"type":"custom-title","customTitle":"side chat","sessionId":"@OWN@"}"#),
            own(r#"{"type":"mode","mode":"normal","sessionId":"@OWN@"}"#),
        ];
        // A fork another session started: its own first prompt is the app's, naming the starter's notes folder
        let fork = vec![
            own(&format!(r#"{{"type":"user","sessionId":"@OWN@","timestamp":"2026-01-01T01:00:00.000Z","turnOrigin":"sdk","isSidechain":false,"message":{{"content":"<system-reminder>\n## You are a session started from another session\nnotes: /a/side-session-notes/{PARENT_HOST}\n</system-reminder>"}}}}"#)),
            own(&format!(r#"{{"type":"assistant","sessionId":"@OWN@","timestamp":"2026-01-01T01:00:05.000Z","isSidechain":false,"message":{{"content":[{{"type":"tool_use","name":"mcp__ccd_session__send_message","input":{{"session_id":"{PARENT_HOST}"}}}}]}}}}"#)),
        ];
        let first = |origin: Option<&str>, at: &str| FirstPrompt { turn_origin: origin.map(str::to_string), named_at_launch: false, session_start_at: None, at: at.into() };
        let names = |scan: &PeerScan| {
            let mut n: Vec<String> = scan.names.iter().map(|(name, _)| name.clone()).collect();
            n.sort();
            n.dedup();
            n
        };
        let cases: Vec<(&str, Vec<String>, Option<FirstPrompt>, Vec<&str>, Option<bool>)> = vec![
            ("side chat the user typed in", [copied.clone(), side_chat_typed].concat(), Some(first(None, "2026-01-01T01:00:01.000Z")), vec![], Some(true)),
            ("side chat closed without typing", [copied.clone(), side_chat_closed].concat(), None, vec![], None),
            ("fork started by another session", [copied.clone(), fork].concat(), Some(first(Some("sdk"), "2026-01-01T01:00:00.000Z")), vec![PARENT_HOST], None),
        ];
        for (name, lines, expected_first, expected_names, expected_typed) in cases {
            let path = dir.join(format!("{OWN}.jsonl"));
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            let scan = scan_peer_names(path.to_str().unwrap(), 0).unwrap();
            assert_eq!(scan.first_prompt, expected_first, "{name}");
            assert_eq!(names(&scan), expected_names, "{name}");
            assert_eq!(scan.last_turn_typed, expected_typed, "{name}");
        }
        // The same copied lines in the parent's own transcript are all read, as before
        let path = dir.join(format!("{PARENT}.jsonl"));
        std::fs::write(&path, copied.join("\n") + "\n").unwrap();
        let scan = scan_peer_names(path.to_str().unwrap(), 0).unwrap();
        assert_eq!(scan.first_prompt, Some(FirstPrompt { named_at_launch: true, ..first(Some("human"), "2026-01-01T00:00:01.000Z") }));
        assert_eq!(names(&scan), vec![SIBLING, "sibling"]);
        assert_eq!(scan.last_turn_typed, Some(true));
        // Lines without sessionId (older transcripts, tests) are read as the session's own
        let path = dir.join("no-ids.jsonl");
        let unmarked: Vec<String> = copied.iter().map(|l| l.replace(&format!(r#""sessionId":"{PARENT}","#), "").replace(&format!(r#","sessionId":"{PARENT}""#), "")).collect();
        std::fs::write(&path, unmarked.join("\n") + "\n").unwrap();
        assert_eq!(names(&scan_peer_names(path.to_str().unwrap(), 0).unwrap()), vec![SIBLING, "sibling"]);
        // A later scan from after the copy reads only what the fork wrote since
        let path = dir.join(format!("{OWN}.jsonl"));
        let copy_end = (copied.join("\n") + "\n").len() as u64;
        let late = own(&format!(r#"{{"type":"assistant","sessionId":"@OWN@","timestamp":"2026-01-01T02:00:00.000Z","isSidechain":false,"message":{{"content":[{{"type":"tool_use","name":"SendMessage","input":{{"to":"helper"}}}}]}}}}"#));
        std::fs::write(&path, [copied.clone(), vec![late]].concat().join("\n") + "\n").unwrap();
        assert_eq!(names(&scan_peer_names(path.to_str().unwrap(), copy_end).unwrap()), vec!["helper"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Whether the latest turn after the first prompt was started by a prompt the user typed, scene by scene: what
    /// a scan from the top reads, and what a later scan reads from after the first `from` lines (None: no prompt in
    /// that part, the previous answer stands)
    #[test]
    fn scan_peer_names_reads_who_started_the_latest_turn() {
        let dir = std::env::temp_dir().join(format!("tomarigi-turn-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Lines as transcripts write them
        const DESKTOP_FIRST: &str = r#"{"type":"user","timestamp":"T0","turnOrigin":"sdk","message":{"content":"task"}}"#;
        const NAME: &str = r#"{"type":"agent-name","agentName":"c"}"#;
        const SESSION_START: &str = r#"{"type":"attachment","timestamp":"T0","attachment":{"hookEvent":"SessionStart"}}"#;
        const GHOSTTY_FIRST: &str = r#"{"type":"user","timestamp":"T0","turnOrigin":"human","origin":{"kind":"human"},"message":{"content":"task"}}"#;
        const TYPED: &str = r#"{"type":"user","timestamp":"T1","turnOrigin":"human","origin":{"kind":"human"},"message":{"content":"hi"}}"#;
        const TYPED_OLD: &str = r#"{"type":"user","timestamp":"T1","origin":{"kind":"human"},"message":{"content":"hi"}}"#;
        const PEER: &str = r#"{"type":"user","isMeta":true,"timestamp":"T2","turnOrigin":"peer","origin":{"kind":"peer","name":"p"},"message":{"content":"x"}}"#;
        const SIDE_EVENT: &str = r#"{"type":"user","timestamp":"T2","turnOrigin":"sdk","message":{"content":"<side-sessions-event>x"}}"#;
        const HOST_SYNTHETIC: &str = r#"{"type":"user","timestamp":"T2","turnOrigin":"host_synthetic","message":{"content":"x"}}"#;
        const TASK_TURN: &str = r#"{"type":"user","timestamp":"T2","turnOrigin":"task_notification","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>x"}}"#;
        const TASK_MIDWORK: &str = r#"{"type":"attachment","timestamp":"T2","attachment":{"type":"queued_command","commandMode":"task-notification","origin":{"kind":"task-notification"},"prompt":"x"}}"#;
        const TYPED_MIDWORK: &str = r#"{"type":"attachment","timestamp":"T2","attachment":{"type":"queued_command","commandMode":"prompt","origin":{"kind":"human"},"humanTurn":true,"prompt":"x"}}"#;
        const PEER_MIDWORK: &str = r#"{"type":"attachment","timestamp":"T2","attachment":{"type":"queued_command","origin":{"kind":"peer","name":"p"},"prompt":"x"}}"#;
        const TOOL_RESULT: &str = r#"{"type":"user","timestamp":"T2","turnOrigin":"human","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}"#;
        const META: &str = r#"{"type":"user","isMeta":true,"timestamp":"T2","turnOrigin":"system","message":{"content":"x"}}"#;
        const SIDECHAIN: &str = r#"{"type":"user","isSidechain":true,"timestamp":"T2","turnOrigin":"human","origin":{"kind":"human"},"message":{"content":"x"}}"#;
        const REPLY: &str = r#"{"type":"assistant","timestamp":"T3","message":{"content":[{"type":"text","text":"ok"}]}}"#;
        // (scene, lines, from top, (from, later scan))
        let scenes: Vec<(&str, Vec<&str>, Option<bool>, (usize, Option<bool>))> = vec![
            ("desktop: only its parent's task so far", vec![DESKTOP_FIRST, REPLY], None, (1, None)),
            ("desktop: the user typed and the turn ended", vec![DESKTOP_FIRST, TYPED, REPLY], Some(true), (1, Some(true))),
            ("desktop: then a turn started by its parent's message", vec![DESKTOP_FIRST, TYPED, REPLY, PEER, REPLY], Some(false), (3, Some(false))),
            ("desktop: a side-sessions-event starts the turn", vec![DESKTOP_FIRST, TYPED, REPLY, SIDE_EVENT, REPLY], Some(false), (3, Some(false))),
            ("desktop: a turn the app starts (host_synthetic)", vec![DESKTOP_FIRST, TYPED, REPLY, HOST_SYNTHETIC], Some(false), (3, Some(false))),
            ("desktop: a task notification starts the turn", vec![DESKTOP_FIRST, TYPED, REPLY, TASK_TURN, REPLY], Some(false), (3, Some(false))),
            ("desktop: a task notification arrives while it works on a typed turn", vec![DESKTOP_FIRST, TYPED, TOOL_RESULT, TASK_MIDWORK, REPLY], Some(true), (1, Some(true))),
            ("desktop: a later read sees only the notification while it works", vec![DESKTOP_FIRST, TYPED, TASK_MIDWORK, REPLY], Some(true), (2, None)),
            ("desktop: its parent's message arrives while it works on a typed turn", vec![DESKTOP_FIRST, TYPED, PEER_MIDWORK, REPLY], Some(true), (2, None)),
            ("desktop: tool results, meta lines and a subagent's lines don't start a turn", vec![DESKTOP_FIRST, PEER, TOOL_RESULT, META, SIDECHAIN], Some(false), (2, None)),
            ("desktop: the user typed into it while it worked on its parent's turn", vec![DESKTOP_FIRST, PEER, TOOL_RESULT, TYPED_MIDWORK, REPLY], Some(true), (2, Some(true))),
            ("desktop: typed into it while it worked, then its parent's next turn", vec![DESKTOP_FIRST, PEER, TYPED_MIDWORK, REPLY, PEER, REPLY], Some(false), (3, Some(false))),
            ("desktop: the user typed again after its parent's turn", vec![DESKTOP_FIRST, TYPED, PEER, REPLY, TYPED], Some(true), (4, Some(true))),
            ("an older transcript without turnOrigin, typed", vec![DESKTOP_FIRST, TYPED_OLD], Some(true), (1, Some(true))),
            ("ghostty: only its first prompt, which is human too", vec![NAME, SESSION_START, GHOSTTY_FIRST, REPLY], None, (3, None)),
            ("ghostty: the user typed in its pane", vec![NAME, SESSION_START, GHOSTTY_FIRST, REPLY, TYPED, REPLY], Some(true), (4, Some(true))),
            ("ghostty: then its parent's message", vec![NAME, SESSION_START, GHOSTTY_FIRST, TYPED, REPLY, PEER, REPLY], Some(false), (5, Some(false))),
            ("ghostty: the user typed into it while it worked on its parent's turn", vec![NAME, SESSION_START, GHOSTTY_FIRST, PEER, TYPED_MIDWORK, REPLY], Some(true), (4, Some(true))),
            ("ghostty: a task notification arrives while it works on a typed turn", vec![NAME, SESSION_START, GHOSTTY_FIRST, TYPED, TASK_MIDWORK, REPLY], Some(true), (4, None)),
        ];
        for (i, (scene, lines, want, (from, want_later))) in scenes.iter().enumerate() {
            let path = dir.join(format!("{i}.jsonl"));
            std::fs::write(&path, lines.join("\n") + "\n").unwrap();
            let p = path.to_str().unwrap();
            assert_eq!(scan_peer_names(p, 0).unwrap().last_turn_typed, *want, "{scene}");
            let offset: usize = lines[..*from].iter().map(|l| l.len() + 1).sum();
            assert_eq!(scan_peer_names(p, offset as u64).unwrap().last_turn_typed, *want_later, "{scene} (later scan from line {from})");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ps_lines_keep_only_processes_with_a_tty() {
        let p = parse_ps_line("  4242 ttys010    01:02:03 /opt/homebrew/bin/opencode --model x", 10_000_000.0).unwrap();
        assert_eq!((p.pid, p.tty.as_str(), p.command.as_str()), (4242, "ttys010", "/opt/homebrew/bin/opencode --model x"));
        assert_eq!(p.started_at_ms, 10_000_000.0 - 3723.0 * 1000.0);
        assert!(parse_ps_line("  77 ??  00:05 /usr/sbin/cfprefsd agent", 0.0).is_none());
        assert_eq!(elapsed_secs("2-00:00:01"), Some(172_801));
        assert_eq!(elapsed_secs("00:07"), Some(7));
    }

    /// A shell started in a temp folder is found with that folder as its cwd, and a pid that has ended is missing
    #[test]
    #[cfg(unix)]
    fn process_cwds_and_alive_pids_follow_the_process() {
        let dir = std::env::temp_dir().join(format!("tomarigi-cwd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let mut child = Command::new("sh").arg("-c").arg("exec sleep 600").current_dir(&dir).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let scan = process_cwds_blocking(&[child.id()]);
        assert!(scan.reliable);
        assert_eq!(scan.cwds, vec![(child.id(), dir.to_string_lossy().into_owned())]);
        let pids = alive_pids_blocking(&[child.id()]);
        assert!(pids.reliable);
        assert_eq!(pids.alive, vec![child.id()]);

        child.kill().unwrap();
        child.wait().unwrap();
        let scan = process_cwds_blocking(&[child.id()]);
        assert!(scan.reliable);
        assert!(scan.cwds.is_empty());
        let pids = alive_pids_blocking(&[child.id()]);
        assert!(pids.reliable && pids.alive.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A codex that has a thread open keeps its lock open. Once it exits the lock file stays but no longer counts
    /// (docs/design.md "Removing birds of ended sessions")
    #[test]
    #[cfg(unix)]
    fn live_codex_threads_follows_the_process_holding_the_lock() {
        let dir = std::env::temp_dir().join(format!("tomarigi-codex-test-{}", std::process::id()));
        let locks = dir.join("thread-writer-locks");
        std::fs::create_dir_all(&locks).unwrap();
        let held = "01a0ead5-4f95-7763-a6fe-2d9f9d8e7b0c";
        let stale = "01a0ead5-5023-76e0-ad34-c3651a23004f";
        for name in [format!("{held}.lock"), format!("{stale}.lock"), ".coordination.lock".to_string()] {
            std::fs::write(locks.join(name), "").unwrap();
        }
        let mut holder = Command::new("sh")
            .arg("-c")
            .arg(format!("exec 3<\"{}\"; exec sleep 600", locks.join(format!("{held}.lock")).display()))
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));

        let scan = live_codex_threads_blocking(dir.to_str().unwrap());
        assert!(scan.reliable);
        let found: Vec<(&str, u32)> = scan.threads.iter().map(|t| (t.thread_id.as_str(), t.pid)).collect();
        assert_eq!(found, vec![(held, holder.id())]);
        assert!(!scan.threads[0].shared);

        holder.kill().unwrap();
        holder.wait().unwrap();
        let scan = live_codex_threads_blocking(dir.to_str().unwrap());
        assert!(scan.reliable);
        assert!(scan.threads.is_empty());
        assert!(locks.join(format!("{held}.lock")).exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// codex 0.163.0 TUIs share one `codex app-server`, which holds every thread's lock
    #[test]
    #[cfg(unix)]
    fn live_codex_threads_marks_locks_held_by_the_shared_app_server() {
        let dir = std::env::temp_dir().join(format!("tomarigi-codex-server-test-{}", std::process::id()));
        let locks = dir.join("thread-writer-locks");
        std::fs::create_dir_all(&locks).unwrap();
        let held = "01a156c9-cc30-70f3-a3c5-c4c883e914b1";
        std::fs::write(locks.join(format!("{held}.lock")), "").unwrap();
        let mut server = Command::new("bash")
            .arg("-c")
            .arg(format!(
                "exec 3<\"{}\"; exec -a 'codex app-server --listen unix:// --managed-daemon' sleep 600",
                locks.join(format!("{held}.lock")).display()
            ))
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));

        let scan = live_codex_threads_blocking(dir.to_str().unwrap());
        server.kill().unwrap();
        server.wait().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(scan.reliable);
        let found: Vec<(&str, u32, bool)> = scan.threads.iter().map(|t| (t.thread_id.as_str(), t.pid, t.shared)).collect();
        assert_eq!(found, vec![(held, server.id(), true)]);
    }

    #[test]
    fn app_server_is_an_argument_not_a_substring() {
        assert!(is_app_server("/Users/me/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex app-server --listen unix://"));
        assert!(!is_app_server("/Users/me/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex"));
        assert!(!is_app_server("codex resume"));
    }

    #[test]
    fn live_codex_threads_without_the_lock_folder_is_reliable_and_empty() {
        let scan = live_codex_threads_blocking("/nonexistent/tomarigi-codex");
        assert!(scan.reliable);
        assert!(scan.threads.is_empty());
    }
}
