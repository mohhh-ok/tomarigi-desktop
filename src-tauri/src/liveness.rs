// ---- Liveness of sessions and watching links ----
// The process lookups behind liveness are one implementation per OS (docs/design.md "Platforms"): ps and lsof on
// macOS; /proc on Linux (ps only for the list of processes with a terminal); sysinfo and the Restart Manager on
// Windows, which has neither ps nor lsof

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::process::Command;

use crate::expand;
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
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    started_at: Option<f64>,
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


#[derive(Serialize)]
pub(crate) struct PeerScan {
    /// (peer name, timestamp string of that trace)
    names: Vec<(String, String)>,
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
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).map_err(|e| io_err(&p, e))?;
    let complete = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    let mut names = Vec::new();
    for line in buf[..complete].split(|&b| b == b'\n') {
        let is_send = line.windows(13).any(|w| w == b"\"SendMessage\"");
        let is_peer = line.windows(8).any(|w| w == b"\"origin\"")
            || line.windows(21).any(|w| w == b"cross-session-message");
        if !is_send && !is_peer {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<serde_json::Value>(line) else { continue };
        let Some(at) = entry.get("timestamp").and_then(|t| t.as_str()) else { continue };
        if entry.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        match entry.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                let blocks = entry.pointer("/message/content").and_then(|c| c.as_array());
                for block in blocks.into_iter().flatten() {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_use")
                        || block.get("name").and_then(|n| n.as_str()) != Some("SendMessage")
                    {
                        continue;
                    }
                    if let Some(name) = block.pointer("/input/to").and_then(|t| t.as_str()).and_then(peer_name_of) {
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
                }
            }
            Some("user") if entry.get("isMeta").and_then(|v| v.as_bool()) == Some(true) => {
                let origin_name = (entry.pointer("/origin/kind").and_then(|k| k.as_str()) == Some("peer"))
                    .then(|| entry.pointer("/origin/name").and_then(|n| n.as_str()))
                    .flatten()
                    .filter(|n| !n.is_empty());
                if let Some(name) = origin_name {
                    names.push((name.to_string(), at.to_string()));
                    continue;
                }
                let text = entry.pointer("/message/content").and_then(|c| c.as_str()).unwrap_or_default();
                let mut rest = text;
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
            _ => {}
        }
    }
    Ok(PeerScan { names, end: start + complete as u64 })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexThread {
    pub(crate) thread_id: String,
    pub(crate) pid: u32,
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
/// codex-cli 0.156.1; not a public Codex spec)
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
            let mut threads: Vec<CodexThread> = Vec::new();
            for (file, pid) in held {
                if let Some(thread_id) = thread_of_lock(&file) {
                    if !threads.iter().any(|t| t.thread_id == thread_id) {
                        threads.push(CodexThread { thread_id: thread_id.to_string(), pid });
                    }
                }
            }
            CodexLiveScan { threads, reliable: true }
        }
        None => CodexLiveScan { threads: Vec::new(), reliable: false },
    }
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

        holder.kill().unwrap();
        holder.wait().unwrap();
        let scan = live_codex_threads_blocking(dir.to_str().unwrap());
        assert!(scan.reliable);
        assert!(scan.threads.is_empty());
        assert!(locks.join(format!("{held}.lock")).exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn live_codex_threads_without_the_lock_folder_is_reliable_and_empty() {
        let scan = live_codex_threads_blocking("/nonexistent/tomarigi-codex");
        assert!(scan.reliable);
        assert!(scan.threads.is_empty());
    }
}
