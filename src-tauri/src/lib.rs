// tomarigi-desktop の Rust 側。設計は docs/design.md。
// - 監視フォルダの読み取り(tomarigi の File System Access API の代わり): fs_list / fs_stat / fs_read
// - 監視フォルダの初期登録・追加: default_roots / pick_folder
// - 窓: 浮遊窓(NSPanel。透明・枠なし・最前面・全画面スペースの上にも出る)と通常の窓(タイトルバー付き。最大化・
//   フルスクリーンできる)をその場で切り替える。モードと、モードごとの位置と大きさを保存して復元する
// - メニューバーのアイコン(表示/非表示・窓のモード・終了)。Dock・Cmd+Tab には通常の窓のときだけ出す
// - Ghostty のペインへ focus: focus_session(sessionId → pid → tty → Ghostty)
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

/// "~/" 始まりをホームに展開する
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(path),
    }
}

// ---- ファイル読み取り ----

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

/// JS 側(src/lib/native-fs.ts)は "NotFound" 始まりのエラーを DOMException NotFoundError に変換する
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
        // シンボリックリンクは辿った先で判定する(設定ディレクトリが symlink のことがある)
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

/// [start, end) のバイト範囲を UTF-8 として読む。範囲の端で切れた文字は置換文字になる
/// (Blob.slice().text() と同じ振る舞い)
#[tauri::command]
fn fs_read(path: &str, start: u64, end: u64) -> Result<String, String> {
    let p = expand(path);
    let mut f = std::fs::File::open(&p).map_err(|e| io_err(&p, e))?;
    f.seek(SeekFrom::Start(start)).map_err(|e| io_err(&p, e))?;
    let mut buf = Vec::with_capacity(end.saturating_sub(start) as usize);
    f.take(end.saturating_sub(start)).read_to_end(&mut buf).map_err(|e| io_err(&p, e))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// デバッグダイアログのイベントログ保存。~/Downloads/<name> に書いてパスを返す
#[tauri::command]
fn save_download(name: &str, content: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.starts_with('.') {
        return Err(format!("invalid name {name}"));
    }
    // 同名があれば Chrome のダウンロードと同じく " (1)" " (2)" … を付けて上書きしない
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

// ---- 監視フォルダ ----

#[derive(Serialize)]
struct DefaultRoot {
    key: &'static str,
    kind: &'static str,
    path: String,
    exists: bool,
}

/// 既定で常に監視するフォルダ(docs/design.md)。実在しないものも exists=false で返す
/// (以前の版が保存した同じパスの登録を捨てる判定に使う)
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

/// ネイティブのフォルダ選択。キャンセルなら None
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

// ---- BYOK の API キーとキーを使う API 呼び出し ----
// docs/design.md「BYOK の API キー…」。キーの値は Rust の中だけで扱い、WebView の JS には返さない。
// 保存先は起動時に identifier で 1 回だけ決める: 普段使い・verify は macOS のキーチェーン(項目は identifier
// ごと)、dev(identifier が .dev で終わる)は WebView の IndexedDB。dev は署名がビルドのたびに変わり、
// キーチェーンの許可を毎回聞かれるため。dev では JS が IndexedDB に持ち、起動時と保存時に Rust へ渡す
// (Rust はメモリにだけ持つ)。キーを使う API 呼び出しはどちらの保存先でも Rust から出す

const KEY_PROVIDERS: [&str; 3] = ["anthropic", "openai", "typesafe"];

enum KeyStore {
    /// キーチェーンの generic password。service は `<identifier>.byok`、account は提供元の名前
    Keychain { service: String },
    /// dev: IndexedDB が正で、Rust はメモリに写しを持つだけ
    WebView,
}

static KEY_STORE: std::sync::OnceLock<KeyStore> = std::sync::OnceLock::new();
/// 読んだ・保存したキーの写し(キーチェーンを何度も読みにいかない)
static KEY_CACHE: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

fn key_store() -> &'static KeyStore {
    KEY_STORE.get_or_init(|| KeyStore::WebView)
}

/// 起動時に 1 回だけ呼ぶ。TOMARIGI_KEY_BACKEND=webview は、IndexedDB からの移行を確かめるための上書き
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

/// キーの値。Rust の中でだけ使う(コマンドで JS に返さない)
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

/// 保存先。JS はこれを見て、dev(webview)のときだけ IndexedDB に保存する
#[tauri::command]
fn key_backend() -> &'static str {
    match key_store() {
        KeyStore::Keychain { .. } => "keychain",
        KeyStore::WebView => "webview",
    }
}

/// 提供元ごとに保存済みかどうか。値は返さない
#[tauri::command]
fn key_status() -> std::collections::HashMap<String, bool> {
    KEY_PROVIDERS.iter().map(|p| (p.to_string(), key_of(p).is_some())).collect()
}

/// キーを保存する(差し替えも同じ)。値は JS から受け取るだけで、返さない
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
        // 無いものの削除は成功扱い
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

/// キーの無い呼び出しは、401 と同じ扱い(JS は auth の失敗として出す)
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

/// TypeSafe の評価 API(docs/design.md「判断待ちの鳥に「?」を付ける」)。api.typesafe.ai は
/// WKWebView の origin(tauri://localhost)を CORS で拒否するうえ、キーを JS に渡さないためここで叩く。
/// body は JS 側が組んだ JSON をそのまま送り、応答も status と本文をそのまま返す(解釈は lib/jev.ts)
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

/// 認証の失敗を調べるための、秘匿しない診断(長さ・先頭 4 文字・前後の空白や引用符の有無)
fn key_diag(key: &str) -> String {
    let prefix: String = key.chars().take(4).collect();
    let quoted = key.starts_with('"') || key.starts_with('\'') || key.ends_with('"') || key.ends_with('\'');
    let ascii = key.chars().all(|c| c.is_ascii_graphic());
    format!("len={} prefix={prefix} quoted={quoted} ascii_graphic={ascii}", key.len())
}

/// Anthropic Messages API(要約・接続テスト。lib/judge.ts)
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

/// OpenAI Responses API(要約・接続テスト。lib/openai-judge.ts)
#[tauri::command]
async fn openai_responses(body: String) -> Result<HttpReply, String> {
    let key = key_of("openai").ok_or(NO_KEY)?;
    post_json("https://api.openai.com/v1/responses", vec![("authorization", format!("Bearer {key}"))], body).await
}

/// 検証用: TOMARIGI_IMPORT_KEY=<提供元> で起動すると、標準入力の 1 行目をその提供元のキーとして保存する
/// (設定画面を手で操作できない環境で、保存・再起動・移行を確かめるため。値はログに出さず長さだけ出す)。
/// 保存先が webview のときは IndexedDB に入れるよう JS に "key-imported" で渡す(dev と同じ経路)
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
                    // WebView の読み込みを待ってから渡す
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

/// tty が一致する Ghostty の terminal を focus し、focus 後の前面ペインの tty を返す
fn ghostty_focus(tty: &str) -> String {
    // tty は AppleScript 文字列に埋め込むので /dev/ttysNNN の形だけ受け付ける
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

/// `<config_dir>/sessions/<pid>.json`(Claude Code の内部ファイル)から session_id の pid を探す
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

/// 見守り中(docs/design.md「別のセッションに作業を任せて待っているセッションを「見守り中」で表す」)の
/// つながりの名前引きに使う、動いている Claude Code のセッション。`<config>/sessions/<pid>.json` の一部
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

/// live_sessions の結果。present は `<config_dir>/sessions` があるか(無い古い版では、プロセスの生死で
/// 鳥を消さず 30 分で消す。docs/design.md「プロセスが終わったセッションの鳥はすぐ消す」)。
/// reliable は、この回の結果で「生きていない」と言ってよいか。ps が動かなかった回と、sessions/*.json の
/// 読み取り・解析に失敗したファイルがあった回は false(Claude Code は状態が変わるたびにこのファイルを
/// 書き直すので、書きかけを読むことがある)。false の回は鳥を消さない
#[derive(Serialize)]
struct LiveScan {
    present: bool,
    sessions: Vec<LiveSession>,
    reliable: bool,
    /// 読み取り・解析に失敗したファイルの数(記録用)
    unreadable: usize,
}

/// `<config_dir>/sessions/*.json` のうち、プロセスが生きているもの。落ちたプロセスのファイルが残っても
/// 見守り中の相手に数えず、鳥も消せるよう、ps を 1 回だけ呼んで生きている pid に絞る
#[tauri::command]
fn live_sessions(config_dir: String) -> LiveScan {
    let dir = expand(&config_dir).join("sessions");
    let Ok(items) = std::fs::read_dir(&dir) else {
        return LiveScan { present: false, sessions: Vec::new(), reliable: true, unreadable: 0 };
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
    // ps -p は、渡した pid の一部が無いと終了コード 1 を返す(出力は正しい)。起動できなかったときだけ失敗とみなす
    let Ok(out) = Command::new("ps").args(["-o", "pid=", "-p", &pids]).output() else {
        return LiveScan { present: true, sessions: Vec::new(), reliable: false, unreadable };
    };
    let alive: std::collections::HashSet<u32> =
        String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|p| p.parse().ok()).collect();
    let ps_ok = out.status.code().is_some_and(|c| c == 0 || c == 1);
    sessions.retain(|s| alive.contains(&s.pid));
    LiveScan { present: true, sessions, reliable: ps_ok && unreadable == 0, unreadable }
}

/// 読み込みごとの記録(fix18 の調査用)を app-log に出すか。環境変数 TOMARIGI_SCAN_LOG があるときだけ
#[tauri::command]
fn scan_log_enabled() -> bool {
    std::env::var_os("TOMARIGI_SCAN_LOG").is_some()
}

#[derive(Serialize)]
struct PeerScan {
    /// (相手の名前, その跡の timestamp 文字列)
    names: Vec<(String, String)>,
    /// 読み終えた位置(次回はここから読む)。途中で切れた最後の行は含めない
    end: u64,
}

/// SendMessage の宛先から、表示用の " [ref]" を落とす。"main"(親の会話)はセッション間のつながりではない
fn peer_name_of(to: &str) -> Option<String> {
    let name = match to.rfind(" [") {
        Some(i) if to.ends_with(']') => &to[..i],
        _ => to,
    }
    .trim();
    (!name.is_empty() && name != "main").then(|| name.to_string())
}

/// transcript の [start, 末尾) から、セッション間メッセージでやり取りした相手の名前を拾う
/// (見守り中のつながり。lib/transcript.ts の collectPeerNames と同じ規則)。tail 窓の外にある跡も拾うため、
/// 呼び出し側が end を覚えて増えた分だけを読む。本文は読まず、名前と時刻だけを返す
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
            // 作業中に届いたメッセージは attachment(queued_command)に同じ origin で記録される
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

/// 生きている pid の制御端末(/dev/ttysNNN)。終了済み・端末なしは None
fn tty_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "tty=", "-p", &pid.to_string()]).output().ok()?;
    let tty = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || tty.is_empty() || tty == "??" {
        return None;
    }
    Some(format!("/dev/{tty}"))
}

/// Claude Code のセッションが動いている Ghostty のペインへ移る。対応が取れなければ何もしない
#[tauri::command]
async fn focus_session(config_dir: String, session_id: String) -> String {
    let result = match pid_of_session(&expand(&config_dir), &session_id) {
        None => "no session file".to_string(),
        Some(pid) => match tty_of_pid(pid) {
            None => format!("pid={pid} no tty"),
            Some(tty) => format!("pid={pid} tty={tty} {}", ghostty_focus(&tty)),
        },
    };
    append_log(&format!("[focus] {config_dir} {session_id} -> {result}"));
    result
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

// ---- 窓 ----

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

/// 窓のモード(docs/design.md「ウィンドウモードを「浮遊窓 / 通常の窓」で切り替えられるようにする」)
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum WindowMode {
    /// NSPanel。透明・枠なし・常に最前面・全画面スペースの上にも出る
    Floating,
    /// タイトルバー付きの普通の窓。最大化・フルスクリーンできる。最前面には固定しない
    Normal,
}

/// 今のモード。起動時に保存した値で上書きする
static WINDOW_MODE: Mutex<WindowMode> = Mutex::new(WindowMode::Floating);
/// モードの切り替え中は、窓の枠の付け外しで出る Moved / Resized を保存しない(別モードの位置で上書きしないため)
static SUPPRESS_SAVE: AtomicBool = AtomicBool::new(false);
/// Moved / Resized の通し番号。最後の変化から SAVE_SETTLE_MS 動かなかったときだけ保存する
/// (フルスクリーンへ入るアニメーションの途中の枠が保存されていた。実測)
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

/// 位置と大きさはモードごとに別に持つ(最大化した大きさを浮遊窓に持ち込まないため)。浮遊窓は以前からの window.json
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
    // 最大化・フルスクリーン中の大きさは保存しない(戻したときに元の大きさへ戻るように)
    // フルスクリーンへ入る途中の枠も保存しない(tao の is_fullscreen はまだ false のことがある。実測)
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

/// 初回(保存した状態が無い)は、メインディスプレイの右上に置く(画面の中ほどでターミナルを隠さないように)
fn place_top_right(win: &WebviewWindow) {
    let (Ok(Some(monitor)), Ok(size)) = (win.primary_monitor(), win.outer_size()) else { return };
    let (p, s, scale) = (monitor.position(), monitor.size(), monitor.scale_factor());
    let margin = (16.0 * scale) as i32;
    let menu_bar = (40.0 * scale) as i32;
    let x = p.x + s.width as i32 - size.width as i32 - margin;
    win.set_position(tauri::PhysicalPosition::new(x, p.y + menu_bar)).ok();
}

/// 保存した位置と大きさを戻す。位置がどのディスプレイにも載らない(外したディスプレイ等)ときは右上に置く
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
    // 非アクティブ化パネル: クリックしても Ghostty からフォーカスを奪わない。Resizable で縁から大きさを変えられる
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
    // NSStatusWindowLevel(25)。floating(3) より上
    panel.set_level(25);
    panel.set_floating_panel(true);
    panel.set_hides_on_deactivate(false);
    // 影で「ターミナルの上に浮いている」ことが分かるようにする。透明な窓の影は macOS が中身の形(角丸の板)から作る
    panel.set_has_shadow(true);
    // すりガラスの角を .page の角丸(perch.css の border-radius 12px)に合わせる
    set_backdrop(win, 12.0);
}

#[cfg(target_os = "macos")]
fn ns_window(win: &WebviewWindow) -> Option<&objc2_app_kit::NSWindow> {
    let ptr = win.ns_window().ok()? as *const objc2_app_kit::NSWindow;
    unsafe { ptr.as_ref() }
}

/// 窓そのものは透かす。色は中身の .page が半透明で塗り、その後ろを set_backdrop のすりガラスがぼかす
/// (浮遊窓・通常の窓とも。docs/design.md のウィンドウモードの項)
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

/// すりガラスの view の目印(contentView の子から探す)
#[cfg(target_os = "macos")]
const BACKDROP_ID: &str = "tomarigi.backdrop";

/// 窓の後ろをぼかすすりガラス。contentView の一番下(WKWebView の後ろ)に NSVisualEffectView を 1 枚敷き、
/// 中身の .page の半透明の色越しに見せる。目的は圧迫感を減らすことで、後ろを読ませることではない。
/// Tauri の set_effects(window-vibrancy 0.6)は呼ぶたびに view を足し、macOS では外す手段も無いので、
/// モードを切り替えるたびに呼ぶここでは 1 枚を持ち回して角丸だけ変える。NSPanel への差し替え(tauri-nspanel)は
/// 窓のクラスを替えるだけで contentView はそのままなので、差し替えの前後で同じ view が残る
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
                // NSVisualEffectMaterialHUDWindow(13): 暗いすりガラス。BlendingMode BehindWindow(0): 窓の後ろをぼかす。
                // State Active(1): 浮遊窓はキーにならない(NonactivatingPanel)ので、窓の状態に合わせるとぼかしが消える
                let _: () = msg_send![&*created, setMaterial: 13isize];
                let _: () = msg_send![&*created, setBlendingMode: 0isize];
                let _: () = msg_send![&*created, setState: 1isize];
                // 窓の外観(浮遊窓は theme を付けない)に関係なく暗いガラスにする
                let dark: *mut AnyObject =
                    msg_send![class!(NSAppearance), appearanceNamed: &*NSString::from_str("NSAppearanceNameDarkAqua")];
                let _: () = msg_send![&*created, setAppearance: dark];
                // NSViewWidthSizable(2) | NSViewHeightSizable(16)。窓の大きさ・タイトルバーの付け外しに追従する
                let _: () = msg_send![&*created, setAutoresizingMask: 18usize];
                // NSWindowBelow(-1)。中身(WKWebView)より後ろ
                let _: () = msg_send![content, addSubview: &*created, positioned: -1isize, relativeTo: std::ptr::null::<AnyObject>()];
                // 親の view が保持するので、ここでの参照は捨ててよい
                let ptr: *const AnyObject = &*created;
                &*ptr
            }
        };
        // 角丸は window-vibrancy と同じ setCornerRadius:(NSVisualEffectView の非公開のメソッド)。無い OS では角丸なしのまま
        let responds: bool = msg_send![view, respondsToSelector: sel!(setCornerRadius:)];
        if responds {
            let _: () = msg_send![view, setCornerRadius: radius];
        }
        append_log(&format!("[window] backdrop radius={radius} corner={responds} reused={}", found.is_some()));
    }
}

/// 浮遊窓(NSPanel)を普通の窓に戻す。タイトルバーと信号ボタンを付け、最前面の固定と全スペース表示を外す
#[cfg(target_os = "macos")]
fn make_normal(win: &WebviewWindow) {
    use objc2_app_kit::NSWindowCollectionBehavior;
    use tauri_nspanel::ManagerExt;
    if let Ok(panel) = win.app_handle().get_webview_panel("main") {
        panel.to_window();
    }
    win.set_always_on_top(false).ok();
    win.set_visible_on_all_workspaces(false).ok();
    // tao の set_decorations は main queue に後回しで効くので、位置を戻す前にタイトルバーを同期で付けておく
    // (後から付くと窓が上に伸び、メニューバーの下へ押し戻されて位置がずれる。実測)
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
    // 中身が暗い色なので、タイトルバーも暗くする
    win.set_theme(Some(tauri::Theme::Dark)).ok();
    set_window_clear(win);
    // 通常の窓は窓そのものに角があるので、すりガラスは角丸なしで窓いっぱい
    set_backdrop(win, 0.0);
    if let Some(ns) = ns_window(win) {
        // NSNormalWindowLevel(0)。FullScreenPrimary で緑の信号ボタンがフルスクリーンになる
        ns.setLevel(0);
        ns.setCollectionBehavior(NSWindowCollectionBehavior::Managed | NSWindowCollectionBehavior::FullScreenPrimary);
        ns.setHasShadow(true);
    }
}

#[cfg(target_os = "macos")]
/// タイトルバーは先に外しておく(switch_mode_step の has_titlebar)。付いたまま NSPanel に差し替えると、
/// タイトルバーの view が元のクラスに付けた KVO を外せず NSRangeException で落ちる(実測)
fn make_floating(win: &WebviewWindow) {
    win.set_theme(None).ok();
    set_window_clear(win);
    make_panel(win);
}

/// AppKit 上でタイトルバーが付いているか。tao の set_decorations は main queue に後回しで効くので、実際の styleMask を見る
fn has_titlebar(win: &WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(ns) = ns_window(win) {
        use objc2_app_kit::NSWindowStyleMask;
        return ns.styleMask().contains(NSWindowStyleMask::Titled);
    }
    let _ = win;
    false
}

/// メニューバーのメニューの「浮遊窓 / 通常の窓」。モードが変わるたびにチェックを付け直す
struct ModeMenu {
    floating: CheckMenuItem<tauri::Wry>,
    normal: CheckMenuItem<tauri::Wry>,
}

/// メニューのチェックと設定画面(App.tsx の "window-mode" イベント)を今のモードに合わせる
fn sync_mode_ui(app: &AppHandle, mode: WindowMode) {
    if let Some(menu) = app.try_state::<ModeMenu>() {
        menu.floating.set_checked(mode == WindowMode::Floating).ok();
        menu.normal.set_checked(mode == WindowMode::Normal).ok();
    }
    app.emit("window-mode", mode).ok();
}

/// その場でモードを切り替える。AppKit の窓操作なのでメインスレッドで呼ぶ
fn switch_mode(app: &AppHandle, mode: WindowMode) {
    switch_mode_step(app, mode, SwitchProgress::default());
}

/// フルスクリーンとタイトルバーを外し終えてから切り替えるための途中経過。最大化は解かない
/// (解除は main queue に後回しで効き、待っても解けないことがあった。実測。位置と大きさは restore_window_state で直接戻す)
#[derive(Default, Clone, Copy)]
struct SwitchProgress {
    attempt: u32,
    exited_fullscreen: bool,
    undecorated: bool,
    settled: bool,
}

/// AppKit がフルスクリーンの出入りの途中か。途中で NSPanel に差し替えると、中身の view が外れた状態で
/// tao の windowDidResize が走り、contentView の unwrap で落ちる(実測)。tao の is_fullscreen は解除を頼んだ時点で
/// false になるので、AppKit の styleMask を見る
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

/// 通常の窓のときだけ Dock・Cmd+Tab・アプリ名のメニューバーに出す(他の窓の下に埋もれても戻せるように)。
/// 浮遊窓は今までどおり出さない。Info.plist の LSUIElement は起動直後に Dock に一瞬出るのを防ぐために残す
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

/// 通常の窓に切り替えたら、アプリを前面に出して窓とアプリ名のメニューバーを出す。浮遊窓は押しても前面にならない
/// (NonactivatingPanel)ので、設定画面から切り替えると前のアプリが前面のまま残る。Regular にした直後は効かないので少し置く
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
        // 付いているチェックを押すとチェックが外れるので付け直す
        sync_mode_ui(app, mode);
        return;
    }
    if p.attempt == 0 {
        save_window_state(&win);
        // フルスクリーン・最大化を解くときの Moved / Resized を今のモードの位置として保存しない
        SUPPRESS_SAVE.store(true, Ordering::SeqCst);
    }
    p.attempt += 1;
    // 最大 5 秒(200ms × 25)待つ。フルスクリーン → タイトルバーの順に外し、外れてから 1 回分置いて切り替える
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
        // 解けないまま差し替えると落ちるので、切り替えずに今のモードへ表示を戻す
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
    // 枠の付け外しで遅れて届く Moved / Resized をやり過ごしてから保存を戻し、切り替え後の位置と大きさを保存する
    // (動かさずに終了しても、次回は同じ位置と大きさで出すため)
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
            // show で alwaysOnTop の floating(3)に戻されるので、出した後に NSStatusWindowLevel(25)を掛け直す
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
            // 通常の窓: 他の窓の下に埋もれているので前に出す
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

/// メニューの文言。システムの言語が日本語なら日本語、それ以外は英語
/// (表示/非表示, 浮遊窓, 通常の窓, 終了)
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
            // 左クリックで表示/非表示、右クリックでメニュー
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
        // 多重起動しない。2 つ目の起動は既存の窓を出して終わる(メニューバーのアイコンが 2 本並ぶのを防ぐ)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // このコールバックはメインスレッド外で呼ばれる。AppKit の窓操作はメインスレッドでしかできない(外で呼ぶと落ちる)
            let handle = app.clone();
            app.run_on_main_thread(move || show_window(&handle)).ok();
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            // BYOK のキーの保存先を identifier で決める(docs/design.md「BYOK の API キー…」)
            init_key_store(&app.config().identifier);
            import_key_from_stdin(app.handle());
            let win = app.get_webview_window("main").expect("main window");
            // TOMARIGI_MOCK=1 で mock モード(tomarigi の ?mock=1 と同じ)。TOMARIGI_QUERY="tab=perch&settings=1" 等で
            // 起動時の画面を指定する(スクショ確認用。App.tsx の初期 state 参照)
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
            // 通常の窓はタイトルバーを付けてから位置を戻す(switch_mode_step と同じ順)
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
            // 窓は visible:false で作り、パネル化してから出す(先に出すと元のスペースに固定される)
            show_window(app.handle());
            append_log(&format!("[window] startup mode={mode:?}"));
            let w = win.clone();
            win.on_window_event(move |event| match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_save(w.app_handle()),
                // 通常の窓の赤い信号ボタンは、窓を壊さずに隠す(ヘッダーの × と同じ。メニューバーのアイコンから戻す)
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    w.hide().ok();
                }
                _ => {}
            });
            // 自己テスト: TOMARIGI_FOCUS_TEST="<config_dir>|<session_id>|<戻り先 tty>" で、起動 3 秒後に
            // そのセッションのペインへ移り、1.5 秒後に戻り先へ移り直す(合成クリックが使えない環境での確認用)
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
            // 自己テスト: TOMARIGI_MODE_TEST=1 で、起動後に 通常の窓 → 浮遊窓 → 通常の窓 → 最大化 → フルスクリーン → 浮遊窓
            // を 5 秒おきに行い、
            // 各段の状態をログに出す(合成クリックが使えない環境での確認用。信号ボタンの代わりに同じ窓操作を呼ぶ)。
            // TOMARIGI_MODE_TEST=normal は通常の窓に切り替えるだけ(再起動してモードが保たれるかの確認用)
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
