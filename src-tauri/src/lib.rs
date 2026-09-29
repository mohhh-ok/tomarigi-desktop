// Rust side of tomarigi-desktop. Design is in docs/design.md.
// - Reading watched folders (instead of the File System Access API used by the tomarigi Chrome extension):
//   fs_list / fs_stat / fs_read
// - Initial registration and adding of watched folders: default_roots / pick_folder
// - Window: switches on the fly between the floating window (NSPanel; transparent, borderless, always on top,
//   also shown above full-screen spaces) and the standard window (with title bar; can maximize and go full
//   screen). Saves and restores the mode, and the position and size per mode
// - Menu bar icon (show/hide, window mode, quit). Shown in the Dock and Cmd+Tab only in standard window mode
// - Focus a Ghostty pane: focus_session (sessionId → pid → tty → Ghostty)
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

const LOG_PATH: &str = "/tmp/tomarigi-desktop/app-log.txt";

fn append_log(line: &str) {
    let _ = std::fs::create_dir_all("/tmp/tomarigi-desktop");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(LOG_PATH) {
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

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

/// Expands a leading "~/" to the home directory
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

// ---- File reading ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    kind: &'static str,
    size: u64,
    mtime_ms: f64,
}

fn entry_of(name: String, meta: &std::fs::Metadata) -> Entry {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Entry {
        name,
        kind: if meta.is_dir() { "directory" } else { "file" },
        size: meta.len(),
        mtime_ms,
    }
}

/// The JS side (src/lib/native-fs.ts) converts errors starting with "NotFound" into DOMException NotFoundError
fn io_err(path: &Path, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("NotFound: {}", path.display())
    } else {
        format!("{}: {e}", path.display())
    }
}

#[tauri::command]
fn fs_list(path: &str) -> Result<Vec<Entry>, String> {
    let dir = expand(path);
    let mut out = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|e| io_err(&dir, e))? {
        let Ok(item) = item else { continue };
        // Judge symlinks by their target (the config directory is sometimes a symlink)
        let Ok(meta) = std::fs::metadata(item.path()) else { continue };
        out.push(entry_of(item.file_name().to_string_lossy().into_owned(), &meta));
    }
    Ok(out)
}

#[tauri::command]
fn fs_stat(path: &str) -> Result<Entry, String> {
    let p = expand(path);
    let meta = std::fs::metadata(&p).map_err(|e| io_err(&p, e))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(entry_of(name, &meta))
}

/// Reads the byte range [start, end) as UTF-8. Characters cut at the edges of the range become replacement
/// characters (same behavior as Blob.slice().text())
#[tauri::command]
fn fs_read(path: &str, start: u64, end: u64) -> Result<String, String> {
    let p = expand(path);
    let mut f = std::fs::File::open(&p).map_err(|e| io_err(&p, e))?;
    f.seek(SeekFrom::Start(start)).map_err(|e| io_err(&p, e))?;
    let mut buf = Vec::with_capacity(end.saturating_sub(start) as usize);
    f.take(end.saturating_sub(start)).read_to_end(&mut buf).map_err(|e| io_err(&p, e))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Saves the event log from the debug dialog. Writes to ~/Downloads/<name> and returns the path
#[tauri::command]
fn save_download(name: &str, content: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.starts_with('.') {
        return Err(format!("invalid name {name}"));
    }
    // If the name exists, append " (1)" " (2)" … like Chrome downloads, instead of overwriting
    let dir = home().join("Downloads");
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    let mut path = dir.join(name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&path, content).map_err(|e| io_err(&path, e))?;
    append_log(&format!("[debug] saved {}", path.display()));
    Ok(path.to_string_lossy().into_owned())
}

// ---- Watched folders ----

#[derive(Serialize)]
struct DefaultRoot {
    key: &'static str,
    kind: &'static str,
    path: String,
    exists: bool,
}

/// Folders always watched by default (docs/design.md "How the desktop app works"). Ones that don't exist are
/// also returned, with exists=false (used to decide whether to drop registrations of the same path saved by
/// earlier versions)
#[tauri::command]
fn default_roots() -> Vec<DefaultRoot> {
    [
        ("claude", "claude", ".claude/projects"),
        ("codex", "codex", ".codex/sessions"),
    ]
    .into_iter()
    .map(|(key, kind, rel)| {
        let p = home().join(rel);
        DefaultRoot { key, kind, exists: p.is_dir(), path: p.to_string_lossy().into_owned() }
    })
    .collect()
}

/// Native folder picker. None if cancelled
#[tauri::command]
async fn pick_folder(default_path: String) -> Option<String> {
    let start = expand(&default_path);
    let mut dialog = rfd::AsyncFileDialog::new();
    if start.is_dir() {
        dialog = dialog.set_directory(&start);
    }
    let picked = dialog.pick_folder().await?;
    Some(picked.path().to_string_lossy().into_owned())
}

// ---- BYOK API keys and the API calls that use them ----
// docs/design.md "BYOK API keys". Key values are handled only inside Rust and never returned to the WebView JS.
// The store is decided once at startup from the identifier: everyday use and verify use the macOS Keychain
// (items per identifier); dev (identifier ending in .dev) uses the WebView's IndexedDB. This is because the dev
// signature changes on every build, and Keychain permission would be asked every time. In dev, JS keeps the keys
// in IndexedDB and passes them to Rust at startup and on save (Rust keeps them only in memory). API calls that
// use keys are made from Rust with either store

const KEY_PROVIDERS: [&str; 3] = ["anthropic", "openai", "typesafe"];

enum KeyStore {
    /// Keychain generic password. service is `<identifier>.byok`, account is the provider name
    Keychain { service: String },
    /// dev: IndexedDB is the source of truth; Rust only keeps a copy in memory
    WebView,
}

static KEY_STORE: std::sync::OnceLock<KeyStore> = std::sync::OnceLock::new();
/// Copy of keys that were read or saved (so the Keychain isn't read over and over)
static KEY_CACHE: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

fn key_store() -> &'static KeyStore {
    KEY_STORE.get_or_init(|| KeyStore::WebView)
}

/// Called once at startup. TOMARIGI_KEY_BACKEND=webview is an override for verifying migration from IndexedDB
fn init_key_store(identifier: &str) {
    let store = if identifier.ends_with(".dev")
        || std::env::var("TOMARIGI_KEY_BACKEND").is_ok_and(|v| v == "webview")
    {
        KeyStore::WebView
    } else {
        KeyStore::Keychain { service: format!("{identifier}.byok") }
    };
    let name = match &store {
        KeyStore::Keychain { service } => format!("keychain service={service}"),
        KeyStore::WebView => "webview".to_string(),
    };
    let _ = KEY_STORE.set(store);
    append_log(&format!("[keys] store={name}"));
}

fn check_provider(provider: &str) -> Result<(), String> {
    if KEY_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("unknown provider {provider}"))
    }
}

fn cache_get(provider: &str) -> Option<String> {
    KEY_CACHE.lock().unwrap().as_ref().and_then(|m| m.get(provider).cloned())
}

fn cache_set(provider: &str, value: Option<String>) {
    let mut guard = KEY_CACHE.lock().unwrap();
    let map = guard.get_or_insert_with(Default::default);
    match value {
        Some(v) => {
            map.insert(provider.to_string(), v);
        }
        None => {
            map.remove(provider);
        }
    }
}

/// The key value. Used only inside Rust (never returned to JS by a command)
fn key_of(provider: &str) -> Option<String> {
    if let Some(v) = cache_get(provider) {
        return Some(v);
    }
    match key_store() {
        KeyStore::Keychain { service } => {
            let bytes = security_framework::passwords::get_generic_password(service, provider).ok()?;
            let value = String::from_utf8(bytes).ok()?;
            cache_set(provider, Some(value.clone()));
            Some(value)
        }
        KeyStore::WebView => None,
    }
}

fn store_key(provider: &str, value: &str) -> Result<(), String> {
    check_provider(provider)?;
    let value = value.trim();
    if value.is_empty() {
        return Err("empty key".into());
    }
    if let KeyStore::Keychain { service } = key_store() {
        security_framework::passwords::set_generic_password(service, provider, value.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    cache_set(provider, Some(value.to_string()));
    Ok(())
}

/// The store. JS checks this and saves to IndexedDB only for dev (webview)
#[tauri::command]
fn key_backend() -> &'static str {
    match key_store() {
        KeyStore::Keychain { .. } => "keychain",
        KeyStore::WebView => "webview",
    }
}

/// Whether a key is saved, per provider. Values are not returned
#[tauri::command]
fn key_status() -> std::collections::HashMap<String, bool> {
    KEY_PROVIDERS.iter().map(|p| (p.to_string(), key_of(p).is_some())).collect()
}

/// Saves a key (replacing works the same way). The value is only received from JS, never returned
#[tauri::command]
fn key_set(provider: String, value: String) -> Result<(), String> {
    store_key(&provider, &value)?;
    append_log(&format!("[keys] saved {provider}"));
    Ok(())
}

#[tauri::command]
fn key_delete(provider: String) -> Result<(), String> {
    check_provider(&provider)?;
    if let KeyStore::Keychain { service } = key_store() {
        // Deleting something that doesn't exist counts as success
        let _ = security_framework::passwords::delete_generic_password(service, &provider);
    }
    cache_set(&provider, None);
    append_log(&format!("[keys] deleted {provider}"));
    Ok(())
}

#[derive(Serialize)]
struct HttpReply {
    status: u16,
    body: String,
}

/// A call without a key is treated the same as a 401 (JS shows it as an auth failure)
const NO_KEY: &str = "no-key";

async fn post_json(
    url: &str,
    headers: Vec<(&'static str, String)>,
    body: String,
) -> Result<HttpReply, String> {
    let mut req = reqwest::Client::new()
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .timeout(std::time::Duration::from_secs(30));
    for (name, value) in headers {
        req = req.header(name, value);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpReply { status, body })
}

/// TypeSafe evaluation API (docs/design.md "The "?" for sessions waiting on you"). api.typesafe.ai rejects the
/// WKWebView origin (tauri://localhost) via CORS, and keys are not passed to JS, so it is called here.
/// body is the JSON built by the JS side, sent as is; the reply's status and body are also returned as is
/// (interpreted in lib/jev.ts)
#[tauri::command]
async fn typesafe_systemone(body: String) -> Result<HttpReply, String> {
    let key = key_of("typesafe").ok_or_else(|| {
        append_log("[keys] send typesafe: no key");
        NO_KEY.to_string()
    })?;
    let diag = key_diag(&key);
    let reply =
        post_json("https://api.typesafe.ai/v1/systemone", vec![("authorization", format!("Bearer {key}"))], body).await;
    match &reply {
        Ok(r) => append_log(&format!("[keys] send typesafe {diag} status={}", r.status)),
        Err(e) => append_log(&format!("[keys] send typesafe {diag} error={e}")),
    }
    reply
}

/// Non-secret diagnostics for investigating auth failures (length, first 4 characters, presence of surrounding
/// whitespace or quotes)
fn key_diag(key: &str) -> String {
    let prefix: String = key.chars().take(4).collect();
    let quoted = key.starts_with('"') || key.starts_with('\'') || key.ends_with('"') || key.ends_with('\'');
    let ascii = key.chars().all(|c| c.is_ascii_graphic());
    format!("len={} prefix={prefix} quoted={quoted} ascii_graphic={ascii}", key.len())
}

/// Anthropic Messages API (summary and connection test; lib/judge.ts)
#[tauri::command]
async fn anthropic_messages(body: String) -> Result<HttpReply, String> {
    let key = key_of("anthropic").ok_or(NO_KEY)?;
    post_json(
        "https://api.anthropic.com/v1/messages",
        vec![("x-api-key", key), ("anthropic-version", "2023-06-01".to_string())],
        body,
    )
    .await
}

/// OpenAI Responses API (summary and connection test; lib/openai-judge.ts)
#[tauri::command]
async fn openai_responses(body: String) -> Result<HttpReply, String> {
    let key = key_of("openai").ok_or(NO_KEY)?;
    post_json("https://api.openai.com/v1/responses", vec![("authorization", format!("Bearer {key}"))], body).await
}

/// For verification: when launched with TOMARIGI_IMPORT_KEY=<provider>, saves the first line of stdin as that
/// provider's key (to verify saving, restarting, and migration in environments where settings can't be operated
/// by hand. The value is not logged, only its length).
/// When the store is webview, passes it to JS via "key-imported" so it goes into IndexedDB (same path as dev)
fn import_key_from_stdin(app: &AppHandle) {
    let Ok(provider) = std::env::var("TOMARIGI_IMPORT_KEY") else { return };
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return;
    }
    let value = line.trim().to_string();
    match store_key(&provider, &value) {
        Ok(()) => {
            append_log(&format!("[keys] imported {provider} len={}", value.len()));
            if matches!(key_store(), KeyStore::WebView) {
                let handle = app.clone();
                std::thread::spawn(move || {
                    // Wait for the WebView to load before passing it
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    handle.emit("key-imported", (provider, value)).ok();
                });
            }
        }
        Err(e) => append_log(&format!("[keys] import failed {provider}: {e}")),
    }
}

// ---- Ghostty ----

fn osascript(script: &str) -> String {
    match Command::new("osascript").arg("-e").arg(script).output() {
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout).trim_end().to_string();
            let err = String::from_utf8_lossy(&o.stderr).trim_end().to_string();
            if o.status.success() {
                out
            } else {
                format!("ERROR rc={:?} {err}", o.status.code())
            }
        }
        Err(e) => format!("ERROR spawn {e}"),
    }
}

/// Focuses the Ghostty terminal whose tty matches, and returns the tty of the front pane after focusing
fn ghostty_focus(tty: &str) -> String {
    // tty is embedded in an AppleScript string, so only the /dev/ttysNNN form is accepted
    if !tty.starts_with("/dev/ttys") || tty.len() <= 9 || !tty[9..].chars().all(|c| c.is_ascii_digit()) {
        return format!("ERROR invalid tty {tty}");
    }
    osascript(&format!(
        r#"tell application "Ghostty"
set hit to false
repeat with t in terminals
if tty of t is "{tty}" then
focus t
activate
set hit to true
exit repeat
end if
end repeat
if not hit then return "NOT FOUND"
delay 1.0
return "front=" & (tty of focused terminal of selected tab of front window)
end tell"#
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionFile {
    pid: u32,
    session_id: String,
}

/// Finds the pid for session_id from `<config_dir>/sessions/<pid>.json` (an internal Claude Code file)
fn pid_of_session(config_dir: &Path, session_id: &str) -> Option<u32> {
    let dir = config_dir.join("sessions");
    for item in std::fs::read_dir(dir).ok()?.flatten() {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(parsed) = serde_json::from_str::<ClaudeSessionFile>(&text) else { continue };
        if parsed.session_id == session_id {
            return Some(parsed.pid);
        }
    }
    None
}

/// A running Claude Code session, used to look up names for watching links (docs/design.md "Watching").
/// Part of `<config>/sessions/<pid>.json`
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveSession {
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
struct LiveScan {
    present: bool,
    sessions: Vec<LiveSession>,
    reliable: bool,
    /// Number of files that failed to read or parse (for logging)
    unreadable: usize,
}

/// How long ps / lsof may take for a liveness check (lsof on thread-writer-locks measured 0.16–0.18s). A run that
/// takes longer is killed and treated as unreliable, so a hung command neither blocks the poll nor removes birds
const LIVENESS_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Runs cmd and collects its output, or None if it couldn't be launched or didn't finish within timeout (it is
/// killed then)
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
async fn live_sessions(config_dir: String) -> LiveScan {
    tauri::async_runtime::spawn_blocking(move || live_sessions_blocking(&config_dir))
        .await
        .unwrap_or(LiveScan { present: true, sessions: Vec::new(), reliable: false, unreadable: 0 })
}

fn live_sessions_blocking(config_dir: &str) -> LiveScan {
    let dir = expand(config_dir).join("sessions");
    let items = match std::fs::read_dir(&dir) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return LiveScan { present: false, sessions: Vec::new(), reliable: true, unreadable: 0 };
        }
        // Exists but couldn't be read: don't conclude anything (birds stay)
        Err(_) => return LiveScan { present: true, sessions: Vec::new(), reliable: false, unreadable: 0 },
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
        return LiveScan { present: true, sessions, reliable: unreadable == 0, unreadable };
    }
    let pids = sessions.iter().map(|s| s.pid.to_string()).collect::<Vec<_>>().join(",");
    // ps -p returns exit code 1 when some of the given pids don't exist (the output is correct). Failing to
    // launch, timing out, or dying from a signal (no exit code) counts as failure
    let Some(out) = output_with_timeout(Command::new("ps").args(["-o", "pid=", "-p", &pids]), LIVENESS_CMD_TIMEOUT) else {
        return LiveScan { present: true, sessions: Vec::new(), reliable: false, unreadable };
    };
    let alive: std::collections::HashSet<u32> =
        String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|p| p.parse().ok()).collect();
    let ps_ok = out.status.code().is_some_and(|c| c == 0 || c == 1);
    sessions.retain(|s| alive.contains(&s.pid));
    LiveScan { present: true, sessions, reliable: ps_ok && unreadable == 0, unreadable }
}

/// Whether to write a per-scan record (for the fix18 investigation) to app-log. Only when the TOMARIGI_SCAN_LOG
/// environment variable is set
#[tauri::command]
fn scan_log_enabled() -> bool {
    std::env::var_os("TOMARIGI_SCAN_LOG").is_some()
}

#[derive(Serialize)]
struct PeerScan {
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
fn scan_peer_names(path: &str, start: u64) -> Result<PeerScan, String> {
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

/// The controlling terminal (/dev/ttysNNN) of a live pid. None if it has exited or has no terminal
fn tty_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "tty=", "-p", &pid.to_string()]).output().ok()?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || tty.is_empty() || tty == "??" {
        return None;
    }
    Some(format!("/dev/{tty}"))
}

fn focus_pid(pid: u32) -> String {
    match tty_of_pid(pid) {
        None => format!("pid={pid} no tty"),
        Some(tty) => format!("pid={pid} tty={tty} {}", ghostty_focus(&tty)),
    }
}

/// Moves to the Ghostty pane where the Claude Code session is running. Does nothing if no match is found
#[tauri::command]
async fn focus_session(config_dir: String, session_id: String) -> String {
    let result = match pid_of_session(&expand(&config_dir), &session_id) {
        None => "no session file".to_string(),
        Some(pid) => focus_pid(pid),
    };
    append_log(&format!("[focus] {config_dir} {session_id} -> {result}"));
    result
}

/// Moves to the Ghostty pane where the codex that has the thread open is running. Does nothing if no process
/// has the thread's lock open
#[tauri::command]
async fn focus_codex(codex_dir: String, thread_id: String) -> String {
    let scan = live_codex_threads(codex_dir.clone()).await;
    let result = match scan.threads.iter().find(|t| t.thread_id == thread_id) {
        None => "no process has the thread lock open".to_string(),
        Some(t) => focus_pid(t.pid),
    };
    append_log(&format!("[focus] {codex_dir} {thread_id} -> {result}"));
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexThread {
    thread_id: String,
    pid: u32,
}

/// Result of live_codex_threads. reliable is false when lsof couldn't be run or reported an error; birds are
/// not removed on such runs (docs/design.md "Removing birds of ended sessions")
#[derive(Serialize)]
struct CodexLiveScan {
    threads: Vec<CodexThread>,
    reliable: bool,
}

/// Codex threads whose process is alive. A running codex keeps `<codex_dir>/thread-writer-locks/<threadId>.lock`
/// open; the lock file stays after codex exits, so only files some process has open count (measured with
/// codex-cli 0.156.1; not a public Codex spec)
/// Runs off the main thread (it is polled every few seconds)
#[tauri::command]
async fn live_codex_threads(codex_dir: String) -> CodexLiveScan {
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
    // lsof exits with 1 both when nothing is open and when something is found (measured on macOS), so the exit
    // code value isn't used. -w silences warnings, so anything on stderr is a failure. Failing to launch, timing
    // out, or dying from a signal (no exit code) is a failure too
    let Some(out) =
        output_with_timeout(Command::new("lsof").arg("-w").args(["-F", "pn", "+d"]).arg(&dir), LIVENESS_CMD_TIMEOUT)
    else {
        return CodexLiveScan { threads: Vec::new(), reliable: false };
    };
    if !out.stderr.is_empty() || out.status.code().is_none() {
        return CodexLiveScan { threads: Vec::new(), reliable: false };
    }
    let mut threads: Vec<CodexThread> = Vec::new();
    let mut pid: Option<u32> = None;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let Some(name) = line.strip_prefix('n') {
            let file = name.rsplit('/').next().unwrap_or("");
            // Only <threadId>.lock (not .coordination.lock etc.)
            let Some(thread_id) = file.strip_suffix(".lock") else { continue };
            if thread_id.is_empty() || thread_id.starts_with('.') {
                continue;
            }
            if let Some(pid) = pid {
                if !threads.iter().any(|t| t.thread_id == thread_id) {
                    threads.push(CodexThread { thread_id: thread_id.to_string(), pid });
                }
            }
        }
    }
    CodexLiveScan { threads, reliable: true }
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

// ---- Window ----

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(TomarigiPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

#[derive(Serialize, Deserialize, Clone, Copy)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Window mode (docs/design.md "Window mode")
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum WindowMode {
    /// NSPanel. Transparent, borderless, always on top, also shown above full-screen spaces
    Floating,
    /// Ordinary window with a title bar. Can maximize and go full screen. Not pinned on top
    Normal,
}

/// The current mode. Overwritten with the saved value at startup
static WINDOW_MODE: Mutex<WindowMode> = Mutex::new(WindowMode::Floating);
/// While switching modes, don't save the Moved / Resized caused by adding/removing the window frame (so the other
/// mode's position doesn't overwrite it)
static SUPPRESS_SAVE: AtomicBool = AtomicBool::new(false);
/// Sequence number of Moved / Resized. Save only when nothing changed for SAVE_SETTLE_MS after the last change
/// (the frame midway through the enter-full-screen animation was being saved; observed)
static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);
const SAVE_SETTLE_MS: u64 = 600;

fn schedule_save(app: &AppHandle) {
    let generation = SAVE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(SAVE_SETTLE_MS));
        if SAVE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                if let Some(w) = h.get_webview_window("main") {
                    save_window_state(&w);
                }
            })
            .ok();
    });
}

fn current_mode() -> WindowMode {
    *WINDOW_MODE.lock().unwrap()
}

fn mode_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window-mode.json"))
}

fn load_mode(app: &AppHandle) -> WindowMode {
    mode_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<WindowMode>(&text).ok())
        .unwrap_or(WindowMode::Floating)
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(value) {
        let _ = std::fs::write(path, json);
    }
}

/// Position and size are kept separately per mode (so a maximized size isn't carried into the floating window).
/// The floating window uses the existing window.json
fn state_path(app: &AppHandle, mode: WindowMode) -> Option<PathBuf> {
    let name = match mode {
        WindowMode::Floating => "window.json",
        WindowMode::Normal => "window-normal.json",
    };
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

fn save_window_state(win: &WebviewWindow) {
    if SUPPRESS_SAVE.load(Ordering::SeqCst) {
        return;
    }
    // Don't save the size while maximized or full screen (so restoring goes back to the original size)
    // Also don't save the frame while entering full screen (tao's is_fullscreen can still be false; observed)
    if win.is_maximized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false) || in_fullscreen_transition(win) {
        return;
    }
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) else { return };
    let state = WindowState { x: pos.x, y: pos.y, width: size.width, height: size.height };
    let Some(path) = state_path(win.app_handle(), current_mode()) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, json);
    }
}

/// On first launch (no saved state), place it at the top right of the main display (so it doesn't hide the
/// terminal in the middle of the screen)
fn place_top_right(win: &WebviewWindow) {
    let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else { return };
    let (p, s, scale) = (monitor.position(), monitor.size(), monitor.scale_factor());
    let margin = (16.0 * scale) as i32;
    let menu_bar = (40.0 * scale) as i32;
    let x = p.x + s.width as i32 - size.width as i32 - margin;
    win.set_position(tauri::PhysicalPosition::new(x, p.y + menu_bar)).ok();
}

/// Restores the saved position and size. If the position isn't on any display (e.g. a disconnected display),
/// places it at the top right
fn restore_window_state(win: &WebviewWindow, mode: WindowMode) {
    let saved = state_path(win.app_handle(), mode)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<WindowState>(&text).ok());
    let Some(state) = saved else {
        place_top_right(win);
        return;
    };
    win.set_size(tauri::PhysicalSize::new(state.width, state.height)).ok();
    let on_screen = win.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        state.x >= p.x
            && state.y >= p.y
            && state.x < p.x + s.width as i32
            && state.y < p.y + s.height as i32
    });
    if on_screen {
        win.set_position(tauri::PhysicalPosition::new(state.x, state.y)).ok();
    } else {
        place_top_right(win);
    }
    append_log(&format!(
        "[window] restore mode={mode:?} x={} y={} w={} h={} on_screen={on_screen}",
        state.x, state.y, state.width, state.height
    ));
}

#[cfg(target_os = "macos")]
fn make_panel(win: &WebviewWindow) {
    use objc2_app_kit::NSWindowStyleMask;
    use tauri_nspanel::{CollectionBehavior, WebviewWindowExt};
    let panel = win.to_panel::<TomarigiPanel>().expect("to_panel");
    // Non-activating panel: clicking doesn't steal focus from Ghostty. Resizable lets you resize from the edges
    panel
        .set_style_mask(
            NSWindowStyleMask::Borderless
                | NSWindowStyleMask::NonactivatingPanel
                | NSWindowStyleMask::Resizable,
        )
        .ok();
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .into(),
    );
    // NSStatusWindowLevel (25). Above floating (3)
    panel.set_level(25);
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    // The shadow shows that it is floating above the terminal. For a transparent window, macOS builds the shadow
    // from the shape of the content (the rounded panel)
    panel.set_has_shadow(true);
    // Match the frosted glass corners to the rounded corners of .page (border-radius 12px in perch.css)
    set_backdrop(win, 12.0);
}

#[cfg(target_os = "macos")]
fn ns_window(win: &WebviewWindow) -> Option<&objc2_app_kit::NSWindow> {
    let ptr = win.ns_window().ok()? as *const objc2_app_kit::NSWindow;
    unsafe { ptr.as_ref() }
}

/// Make the window itself transparent. The content's .page paints a translucent color, and set_backdrop's frosted
/// glass blurs what is behind it (for both floating and standard windows; docs/design.md "Window mode")
#[cfg(target_os = "macos")]
fn set_window_clear(win: &WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let Some(ns) = ns_window(win) else { return };
    unsafe {
        let color: *mut AnyObject = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns, setBackgroundColor: color];
        let _: () = msg_send![ns, setOpaque: false];
    }
}

/// Marker for the frosted glass view (looked up among contentView's children)
#[cfg(target_os = "macos")]
const BACKDROP_ID: &str = "tomarigi.backdrop";

/// Frosted glass that blurs what is behind the window. Lays one NSVisualEffectView at the bottom of contentView
/// (behind the WKWebView) and shows it through the translucent color of the content's .page. The goal is to make
/// the window feel less heavy, not to let you read what is behind it.
/// Tauri's set_effects (window-vibrancy 0.6) adds a view on every call and has no way to remove it on macOS, so
/// here, which is called on every mode switch, a single view is reused and only its corner radius changes. Switching
/// to NSPanel (tauri-nspanel) only changes the window's class and keeps contentView, so the same view remains
/// before and after the switch
#[cfg(target_os = "macos")]
fn set_backdrop(win: &WebviewWindow, radius: f64) {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSRect, NSString};
    let Some(ns) = ns_window(win) else { return };
    unsafe {
        let content: *mut AnyObject = msg_send![ns, contentView];
        let Some(content) = content.as_ref() else { return };
        let subviews: *mut AnyObject = msg_send![content, subviews];
        let count: usize = msg_send![subviews, count];
        let mut found: Option<&AnyObject> = None;
        for i in 0..count {
            let v: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
            let ident: *mut NSString = msg_send![v, identifier];
            if ident.as_ref().is_some_and(|id| id.to_string() == BACKDROP_ID) {
                found = v.as_ref();
                break;
            }
        }
        let view = match found {
            Some(v) => v,
            None => {
                let bounds: NSRect = msg_send![content, bounds];
                let alloc: Allocated<AnyObject> = msg_send![class!(NSVisualEffectView), alloc];
                let created: Retained<AnyObject> = msg_send![alloc, initWithFrame: bounds];
                let _: () = msg_send![&*created, setIdentifier: &*NSString::from_str(BACKDROP_ID)];
                // NSVisualEffectMaterialHUDWindow (13): dark frosted glass. BlendingMode BehindWindow (0): blur what is
                // behind the window. State Active (1): the floating window never becomes key (NonactivatingPanel), so
                // following the window's state would make the blur disappear
                let _: () = msg_send![&*created, setMaterial: 13isize];
                let _: () = msg_send![&*created, setBlendingMode: 0isize];
                let _: () = msg_send![&*created, setState: 1isize];
                // Use dark glass regardless of the window's appearance (the floating window has no theme set)
                let dark: *mut AnyObject =
                    msg_send![class!(NSAppearance), appearanceNamed: &*NSString::from_str("NSAppearanceNameDarkAqua")];
                let _: () = msg_send![&*created, setAppearance: dark];
                // NSViewWidthSizable (2) | NSViewHeightSizable (16). Follows the window size and the title bar being
                // added or removed
                let _: () = msg_send![&*created, setAutoresizingMask: 18usize];
                // NSWindowBelow (-1). Behind the content (WKWebView)
                let _: () = msg_send![content, addSubview: &*created, positioned: -1isize, relativeTo: std::ptr::null::<AnyObject>()];
                // The parent view retains it, so the reference here can be dropped
                let ptr: *const AnyObject = &*created;
                &*ptr
            }
        };
        // Corner radius uses setCornerRadius:, same as window-vibrancy (a private NSVisualEffectView method). On OS
        // versions without it, corners stay square
        let responds: bool = msg_send![view, respondsToSelector: sel!(setCornerRadius:)];
        if responds {
            let _: () = msg_send![view, setCornerRadius: radius];
        }
        append_log(&format!("[window] backdrop radius={radius} corner={responds} reused={}", found.is_some()));
    }
}

/// Turns the floating window (NSPanel) back into an ordinary window. Adds the title bar and traffic-light buttons,
/// and removes always-on-top and showing on all spaces
#[cfg(target_os = "macos")]
fn make_normal(win: &WebviewWindow) {
    use objc2_app_kit::NSWindowCollectionBehavior;
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = win.app_handle().get_webview_panel("main") {
        panel.to_window();
    }
    win.set_always_on_top(false).ok();
    win.set_visible_on_all_workspaces(false).ok();
    // tao's set_decorations takes effect later on the main queue, so add the title bar synchronously before
    // restoring the position (if it is added afterwards, the window grows upward, gets pushed back below the menu
    // bar, and the position shifts; observed)
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        ns.setStyleMask(
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Miniaturizable
                | NSWindowStyleMask::Resizable,
        );
    }
    win.set_decorations(true).ok();
    win.set_resizable(true).ok();
    win.set_maximizable(true).ok();
    // The content is dark, so make the title bar dark too
    win.set_theme(Some(tauri::Theme::Dark)).ok();
    set_window_clear(win);
    // The standard window has its own corners, so the frosted glass fills the window with no corner radius
    set_backdrop(win, 0.0);
    if let Some(ns) = ns_window(win) {
        // NSNormalWindowLevel (0). With FullScreenPrimary, the green traffic-light button goes full screen
        ns.setLevel(0);
        ns.setCollectionBehavior(NSWindowCollectionBehavior::Managed | NSWindowCollectionBehavior::FullScreenPrimary);
        ns.setHasShadow(true);
    }
}

#[cfg(target_os = "macos")]
/// The title bar must be removed first (has_titlebar in switch_mode_step). Switching to NSPanel with it still
/// attached crashes with NSRangeException because the title bar view can't remove the KVO it added to the original
/// class (observed)
fn make_floating(win: &WebviewWindow) {
    win.set_theme(None).ok();
    set_window_clear(win);
    make_panel(win);
}

/// Whether the title bar is attached in AppKit. tao's set_decorations takes effect later on the main queue, so look
/// at the actual styleMask
fn has_titlebar(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        return ns.styleMask().contains(NSWindowStyleMask::Titled);
    }
    let _ = win;
    false
}

/// The "floating window / standard window" items in the menu bar menu. The check marks are reset on every mode change
struct ModeMenu {
    floating: CheckMenuItem<tauri::Wry>,
    normal: CheckMenuItem<tauri::Wry>,
}

/// Syncs the menu check marks and settings (the "window-mode" event in App.tsx) to the current mode
fn sync_mode_ui(app: &AppHandle, mode: WindowMode) {
    if let Some(menu) = app.try_state::<ModeMenu>() {
        menu.floating.set_checked(mode == WindowMode::Floating).ok();
        menu.normal.set_checked(mode == WindowMode::Normal).ok();
    }
    app.emit("window-mode", mode).ok();
}

/// Switches the mode on the fly. Call on the main thread, since it operates on AppKit windows
fn switch_mode(app: &AppHandle, mode: WindowMode) {
    switch_mode_step(app, mode, SwitchProgress::default());
}

/// Progress state for switching only after full screen and the title bar have been removed. Maximize is not undone
/// (undoing it takes effect later on the main queue, and sometimes it didn't undo even after waiting; observed.
/// Position and size are restored directly by restore_window_state)
#[derive(Default, Clone, Copy)]
struct SwitchProgress {
    attempt: u32,
    exited_fullscreen: bool,
    undecorated: bool,
    settled: bool,
}

/// Whether AppKit is midway through entering or leaving full screen. Switching to NSPanel midway runs tao's
/// windowDidResize with the content view detached, and it crashes on the contentView unwrap (observed). tao's
/// is_fullscreen becomes false as soon as the exit is requested, so look at AppKit's styleMask
fn in_fullscreen_transition(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        return ns.styleMask().contains(NSWindowStyleMask::FullScreen) || ns.contentView().is_none();
    }
    let _ = win;
    false
}

fn retry_switch(app: &AppHandle, mode: WindowMode, progress: SwitchProgress) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let h = handle.clone();
        handle.run_on_main_thread(move || switch_mode_step(&h, mode, progress)).ok();
    });
}

/// Show in the Dock, Cmd+Tab, and the app-name menu bar only for the standard window (so it can be brought back when
/// buried under other windows). The floating window stays hidden from them as before. LSUIElement in Info.plist is
/// kept to prevent a brief Dock appearance right after launch
fn set_dock_policy(app: &AppHandle, mode: WindowMode) {
    #[cfg(target_os = "macos")]
    {
        let policy = match mode {
            WindowMode::Floating => tauri::ActivationPolicy::Accessory,
            WindowMode::Normal => tauri::ActivationPolicy::Regular,
        };
        app.set_activation_policy(policy).ok();
        append_log(&format!("[window] activation policy for {mode:?}"));
    }
    let _ = (app, mode);
}

/// After switching to the standard window, bring the app to the front and show the window and the app-name menu bar.
/// Clicking the floating window doesn't activate the app (NonactivatingPanel), so switching from settings would
/// leave the previous app in front. It doesn't work right after setting Regular, so wait a moment
fn activate_later(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                #[cfg(target_os = "macos")]
                unsafe {
                    use objc2::runtime::AnyObject;
                    use objc2::{class, msg_send};
                    let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                    let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
                }
                if let Some(w) = h.get_webview_window("main") {
                    w.set_focus().ok();
                }
            })
            .ok();
    });
}

fn switch_mode_step(app: &AppHandle, mode: WindowMode, mut p: SwitchProgress) {
    let Some(win) = app.get_webview_window("main") else { return };
    if current_mode() == mode {
        // Clicking an already-checked item unchecks it, so check it again
        sync_mode_ui(app, mode);
        return;
    }
    if p.attempt == 0 {
        save_window_state(&win);
        // Don't save the Moved / Resized from leaving full screen or maximize as the current mode's position
        SUPPRESS_SAVE.store(true, Ordering::SeqCst);
    }
    p.attempt += 1;
    // Wait up to 5 seconds (200ms × 25). Remove full screen, then the title bar, and switch one interval after
    // they are gone
    if p.attempt <= 25 {
        if win.is_fullscreen().unwrap_or(false) || in_fullscreen_transition(&win) {
            if !p.exited_fullscreen {
                p.exited_fullscreen = true;
                win.set_fullscreen(false).ok();
            }
            return retry_switch(app, mode, p);
        }
        if mode == WindowMode::Floating && has_titlebar(&win) {
            if !p.undecorated {
                p.undecorated = true;
                win.set_decorations(false).ok();
            }
            return retry_switch(app, mode, p);
        }
        if (p.exited_fullscreen || p.undecorated) && !p.settled {
            p.settled = true;
            return retry_switch(app, mode, p);
        }
    } else {
        // Switching while they are still on would crash, so don't switch; restore the UI to the current mode
        append_log("[window] switch: gave up waiting for fullscreen / titlebar to end");
        SUPPRESS_SAVE.store(false, Ordering::SeqCst);
        sync_mode_ui(app, current_mode());
        return;
    }
    *WINDOW_MODE.lock().unwrap() = mode;
    if let Some(path) = mode_path(app) {
        write_json(path, &mode);
    }
    let visible = win.is_visible().unwrap_or(false);
    #[cfg(target_os = "macos")]
    match mode {
        WindowMode::Floating => make_floating(&win),
        WindowMode::Normal => make_normal(&win),
    }
    restore_window_state(&win, mode);
    set_dock_policy(app, mode);
    if visible {
        show_window(app);
        if mode == WindowMode::Normal {
            activate_later(app);
        }
    }
    sync_mode_ui(app, mode);
    append_log(&format!("[window] mode={mode:?}"));
    // Let the late Moved / Resized from adding/removing the frame pass, then re-enable saving and save the position
    // and size after the switch (so that even if the app quits without moving, it opens at the same position and
    // size next time)
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        SUPPRESS_SAVE.store(false, Ordering::SeqCst);
        let h = handle.clone();
        handle
            .run_on_main_thread(move || {
                if let Some(w) = h.get_webview_window("main") {
                    save_window_state(&w);
                }
            })
            .ok();
    });
}

#[tauri::command]
fn get_window_mode() -> WindowMode {
    current_mode()
}

#[tauri::command]
fn set_window_mode(app: AppHandle, mode: WindowMode) {
    let handle = app.clone();
    app.run_on_main_thread(move || switch_mode(&handle, mode)).ok();
}

fn show_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    win.show().ok();
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel("main") {
            // show resets the level to alwaysOnTop's floating (3), so reapply NSStatusWindowLevel (25) after showing
            panel.set_level(25);
            panel.order_front_regardless();
            let ns = panel.as_panel();
            append_log(&format!(
                "[window] shown class={} level={} isOnActiveSpace={}",
                ns.class().name().to_str().unwrap_or("?"),
                ns.level(),
                ns.isOnActiveSpace()
            ));
        } else {
            // Standard window: it is buried under other windows, so bring it to the front
            win.set_focus().ok();
            append_log("[window] shown mode=Normal");
        }
    }
}

fn toggle_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    if win.is_visible().unwrap_or(false) {
        win.hide().ok();
    } else {
        show_window(app);
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().ok();
    }
}

/// Menu labels. Japanese if the system language is Japanese, English otherwise
/// (show/hide, floating window, standard window, quit)
fn menu_labels() -> (&'static str, &'static str, &'static str, &'static str) {
    let locale = Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    if locale.starts_with("ja") {
        ("表示 / 非表示", "浮遊窓（常に最前面）", "通常の窓（最大化できる）", "tomarigi を終了")
    } else {
        ("Show / Hide", "Floating (always on top)", "Standard window (can maximize)", "Quit tomarigi")
    }
}

fn setup_tray(app: &tauri::App, mode: WindowMode) -> tauri::Result<()> {
    let (toggle_label, floating_label, normal_label, quit_label) = menu_labels();
    let toggle = MenuItem::with_id(app, "toggle", toggle_label, true, None::<&str>)?;
    let floating =
        CheckMenuItem::with_id(app, "mode-floating", floating_label, true, mode == WindowMode::Floating, None::<&str>)?;
    let normal = CheckMenuItem::with_id(app, "mode-normal", normal_label, true, mode == WindowMode::Normal, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &floating,
            &normal,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(ModeMenu { floating, normal });
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("tomarigi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_window(app),
            "mode-floating" => switch_mode(app, WindowMode::Floating),
            "mode-normal" => switch_mode(app, WindowMode::Normal),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles show/hide, right click opens the menu
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single instance. A second launch shows the existing window and exits (prevents two menu bar icons side by side)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // This callback is called off the main thread. AppKit window operations only work on the main thread
            // (calling them elsewhere crashes)
            let handle = app.clone();
            app.run_on_main_thread(move || show_window(&handle)).ok();
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            // Decide the BYOK key store from the identifier (docs/design.md "BYOK API keys")
            init_key_store(&app.config().identifier);
            import_key_from_stdin(app.handle());
            let win = app.get_webview_window("main").expect("main window");
            // TOMARIGI_MOCK=1 enables mock mode (same as ?mock=1 in the tomarigi Chrome extension).
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
            #[cfg(target_os = "macos")]
            match mode {
                WindowMode::Floating => {
                    restore_window_state(&win, mode);
                    make_panel(&win);
                }
                WindowMode::Normal => {
                    make_normal(&win);
                    restore_window_state(&win, mode);
                }
            }
            #[cfg(not(target_os = "macos"))]
            restore_window_state(&win, mode);
            setup_tray(app, mode)?;
            // The window is created with visible:false and shown after it becomes a panel (showing it first pins it
            // to the original space)
            show_window(app.handle());
            append_log(&format!("[window] startup mode={mode:?}"));
            let w = win.clone();
            win.on_window_event(move |event| match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_save(w.app_handle()),
                // The standard window's red traffic-light button hides the window without destroying it (same as the ×
                // in the header; bring it back from the menu bar icon)
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    w.hide().ok();
                }
                _ => {}
            });
            // Self-test: with TOMARIGI_FOCUS_TEST="<config_dir>|<session_id>|<return tty>", moves to that session's
            // pane 3 seconds after launch, then moves back to the return tty 1.5 seconds later (for checking in
            // environments where synthetic clicks can't be used)
            if let Ok(spec) = std::env::var("TOMARIGI_FOCUS_TEST") {
                let parts: Vec<String> = spec.split('|').map(str::to_string).collect();
                if let [config_dir, session_id, back] = parts.as_slice() {
                    let (config_dir, session_id, back) = (config_dir.clone(), session_id.clone(), back.clone());
                    tauri::async_runtime::spawn(async move {
                        tokio_sleep(3000).await;
                        let r = focus_session(config_dir, session_id).await;
                        append_log(&format!("[focus-test] -> {r}"));
                        tokio_sleep(1500).await;
                        append_log(&format!("[focus-test] back {back} -> {}", ghostty_focus(&back)));
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
            fs_list,
            fs_stat,
            fs_read,
            default_roots,
            pick_folder,
            focus_session,
            focus_codex,
            live_codex_threads,
            hide_window,
            get_window_mode,
            set_window_mode,
            save_download,
            typesafe_systemone,
            anthropic_messages,
            openai_responses,
            key_backend,
            key_status,
            key_set,
            key_delete,
            live_sessions,
            scan_log_enabled,
            scan_peer_names
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A codex that has a thread open keeps its lock open. Once it exits the lock file stays but no longer counts
    /// (docs/design.md "Removing birds of ended sessions")
    #[test]
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
