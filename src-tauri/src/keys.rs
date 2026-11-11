use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use crate::append_log;

// ---- BYOK API keys and the API calls that use them ----
// docs/design.md "BYOK API keys". Key values are handled only inside Rust and never returned to the WebView JS.
// The store is decided once at startup: everyday use, verify, and dev all use the OS store (items per identifier):
// the macOS Keychain, Windows Credential Manager, or Linux Secret Service (GNOME Keyring / KWallet) through the
// keyring crate. On Linux without Secret Service keys can't be saved; there is no plaintext fallback (docs/design.md
// "Platforms"). dev is signed before each run by a cargo runner (scripts/dev-runner.sh) so the Keychain doesn't ask
// after every rebuild. TOMARIGI_KEY_BACKEND=webview puts keys in the WebView's IndexedDB instead (only to check the
// migration from it): JS keeps the keys there and passes them to Rust at startup and on save (Rust keeps them only in
// memory). API calls that use keys are made from Rust with either store

const KEY_PROVIDERS: [&str; 2] = ["anthropic", "openai"];
/// Providers no longer used whose saved key can still be seen and deleted, never saved or sent (docs/design.md "BYOK
/// API keys": TypeSafe (Jev) is no longer used)
const RETIRED_KEY_PROVIDERS: [&str; 1] = ["typesafe"];

enum KeyStore {
    /// OS store (Keychain generic password on macOS). service is `<identifier>.byok`, account is the provider name
    Keychain { service: String },
    /// TOMARIGI_KEY_BACKEND=webview: IndexedDB is the source of truth; Rust only keeps a copy in memory
    WebView,
    /// The OS store can't be used (Linux without Secret Service). The reason is for the log only
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unavailable(String),
}

/// The OS store: the Keychain on macOS
#[cfg(target_os = "macos")]
mod os_store {
    pub(super) fn get(service: &str, provider: &str) -> Option<String> {
        let bytes = security_framework::passwords::get_generic_password(service, provider).ok()?;
        String::from_utf8(bytes).ok()
    }

    pub(super) fn set(service: &str, provider: &str, value: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password(service, provider, value.as_bytes()).map_err(|e| e.to_string())
    }

    pub(super) fn delete(service: &str, provider: &str) {
        let _ = security_framework::passwords::delete_generic_password(service, provider);
    }
}

/// The OS store on Windows (Credential Manager) and Linux (Secret Service), picked by the keyring crate
#[cfg(not(target_os = "macos"))]
mod os_store {
    use keyring::{Entry, Error};

    /// None when the store works. A missing item counts as working; anything else (no Secret Service on the
    /// session bus, a locked store that can't be opened) means keys can't be saved
    pub(super) fn probe(service: &str) -> Option<String> {
        if let Err(e) = Entry::store_status() {
            return Some(e.to_string());
        }
        match Entry::new(service, "anthropic").and_then(|e| e.get_password()) {
            Ok(_) | Err(Error::NoEntry) => None,
            Err(e) => Some(e.to_string()),
        }
    }

    pub(super) fn get(service: &str, provider: &str) -> Option<String> {
        Entry::new(service, provider).and_then(|e| e.get_password()).ok()
    }

    pub(super) fn set(service: &str, provider: &str, value: &str) -> Result<(), String> {
        Entry::new(service, provider).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
    }

    pub(super) fn delete(service: &str, provider: &str) {
        let _ = Entry::new(service, provider).and_then(|e| e.delete_credential());
    }
}

static KEY_STORE: std::sync::OnceLock<KeyStore> = std::sync::OnceLock::new();
/// Whether the WebView's storage (IndexedDB) belongs to this identifier alone. Decided once at startup
/// (webview_storage_is_own); JS reads and deletes keys in IndexedDB only when it does (docs/design.md "BYOK API keys")
static WEBVIEW_STORAGE_OWN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[derive(Clone, Copy)]
enum Os {
    MacOs,
    /// Windows and Linux
    Other,
}

/// Whether the WebView's storage belongs to this identifier alone, from the OS, the identifier, and the path of the
/// running executable.
/// - macOS: WKWebView keeps its storage per bundle identifier only for a build launched from its .app bundle
///   (`<name>.app/Contents/MacOS/<exe>`). A binary run outside a bundle (`target/debug/tomarigi-desktop`) shares one
///   WebKit storage with every other unbundled build, whatever its identifier. dev (identifier ending in .dev) counts
///   as owning it anyway: before dev used the Keychain it was the only build that wrote keys there, so dev moves the
///   keys it left there (docs/design.md "BYOK API keys")
/// - Windows and Linux: Tauri sets the webview's data directory to `app_local_data_dir`
///   (`<local data dir>/<identifier>`) when none is configured (tauri 2.12.5 `manager/webview.rs`; this app sets
///   neither `dataDirectory` nor `appDirectoriesOverride`), so it is per identifier however the binary is run
fn webview_storage_is_own(os: Os, identifier: &str, exe: &std::path::Path) -> bool {
    match os {
        Os::Other => true,
        Os::MacOs if identifier.ends_with(".dev") => true,
        Os::MacOs => {
            let macos_dir = exe.parent();
            let contents = macos_dir.and_then(|d| d.parent());
            let bundle = contents.and_then(|d| d.parent());
            macos_dir.and_then(|d| d.file_name()).is_some_and(|n| n == "MacOS")
                && contents.and_then(|d| d.file_name()).is_some_and(|n| n == "Contents")
                && bundle.and_then(|d| d.extension()).is_some_and(|e| e == "app")
        }
    }
}

fn this_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::MacOs
    } else {
        Os::Other
    }
}
/// Copy of keys that were read or saved (so the Keychain isn't read over and over)
static KEY_CACHE: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

fn key_store() -> &'static KeyStore {
    KEY_STORE.get_or_init(|| KeyStore::WebView)
}

/// Called once at startup. TOMARIGI_KEY_BACKEND=webview is an override for verifying migration from IndexedDB
pub(crate) fn init_key_store(identifier: &str) {
    // An executable path that can't be read counts as shared storage: leaving IndexedDB alone is the safe side
    let own = std::env::current_exe().is_ok_and(|exe| webview_storage_is_own(this_os(), identifier, &exe));
    let _ = WEBVIEW_STORAGE_OWN.set(own);
    let store = if std::env::var("TOMARIGI_KEY_BACKEND").is_ok_and(|v| v == "webview") {
        KeyStore::WebView
    } else {
        let service = format!("{identifier}.byok");
        #[cfg(not(target_os = "macos"))]
        if let Some(reason) = os_store::probe(&service) {
            let _ = KEY_STORE.set(KeyStore::Unavailable(reason.clone()));
            append_log(&format!("[keys] store=unavailable: {reason}"));
            return;
        }
        KeyStore::Keychain { service }
    };
    let name = match &store {
        KeyStore::Keychain { service } => format!("keychain service={service}"),
        KeyStore::WebView => "webview".to_string(),
        KeyStore::Unavailable(reason) => format!("unavailable: {reason}"),
    };
    let left_alone = !own && matches!(store, KeyStore::Keychain { .. });
    let _ = KEY_STORE.set(store);
    append_log(&format!("[keys] store={name}"));
    if left_alone {
        append_log("[keys] IndexedDB left alone: not launched from a .app bundle");
    }
}

fn check_provider(provider: &str) -> Result<(), String> {
    if KEY_PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(format!("unknown provider {provider}"))
    }
}

/// A provider whose key can be checked and deleted: the ones in use and the retired ones
fn check_known_provider(provider: &str) -> Result<(), String> {
    if KEY_PROVIDERS.contains(&provider) || RETIRED_KEY_PROVIDERS.contains(&provider) {
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
            let value = os_store::get(service, provider)?;
            cache_set(provider, Some(value.clone()));
            Some(value)
        }
        KeyStore::WebView | KeyStore::Unavailable(_) => None,
    }
}

fn store_key(provider: &str, value: &str) -> Result<(), String> {
    check_provider(provider)?;
    let value = value.trim();
    if value.is_empty() {
        return Err("empty key".into());
    }
    match key_store() {
        KeyStore::Keychain { service } => os_store::set(service, provider, value)?,
        KeyStore::Unavailable(_) => return Err("key store unavailable".into()),
        KeyStore::WebView => {}
    }
    cache_set(provider, Some(value.to_string()));
    Ok(())
}

/// The store. JS checks this and saves to IndexedDB only for webview (TOMARIGI_KEY_BACKEND=webview); "unavailable" makes the settings say keys
/// can't be saved
#[tauri::command]
pub(crate) fn key_backend() -> &'static str {
    match key_store() {
        KeyStore::Keychain { .. } => "keychain",
        KeyStore::WebView => "webview",
        KeyStore::Unavailable(_) => "unavailable",
    }
}

/// Whether the WebView's storage belongs to this identifier alone. With the Keychain, JS moves keys left in IndexedDB
/// and deletes keys from IndexedDB only when this is true; otherwise IndexedDB may be another build's (dev's) and is
/// neither read nor changed
#[tauri::command]
pub(crate) fn key_webview_storage_own() -> bool {
    *WEBVIEW_STORAGE_OWN.get().unwrap_or(&false)
}

/// Whether a key is saved, per provider (retired ones included, so a key left saved can be deleted). Values are not
/// returned
#[tauri::command]
pub(crate) fn key_status() -> std::collections::HashMap<String, bool> {
    KEY_PROVIDERS.iter().chain(RETIRED_KEY_PROVIDERS.iter()).map(|p| (p.to_string(), key_of(p).is_some())).collect()
}

/// Saves a key (replacing works the same way). The value is only received from JS, never returned
#[tauri::command]
pub(crate) fn key_set(provider: String, value: String) -> Result<(), String> {
    store_key(&provider, &value)?;
    append_log(&format!("[keys] saved {provider}"));
    Ok(())
}

#[tauri::command]
pub(crate) fn key_delete(provider: String) -> Result<(), String> {
    check_known_provider(&provider)?;
    if let KeyStore::Keychain { service } = key_store() {
        // Deleting something that doesn't exist counts as success
        os_store::delete(service, &provider);
    }
    cache_set(&provider, None);
    append_log(&format!("[keys] deleted {provider}"));
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct HttpReply {
    status: u16,
    body: String,
}

/// A call without a key is treated the same as a 401 (JS shows it as an auth failure)
const NO_KEY: &str = "no-key";

/// Timeout for the cloud providers
const CLOUD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

async fn post_json(
    url: &str,
    headers: Vec<(&'static str, String)>,
    body: String,
) -> Result<HttpReply, String> {
    post_json_with_timeout(url, headers, body, CLOUD_TIMEOUT).await
}

async fn post_json_with_timeout(
    url: &str,
    headers: Vec<(&'static str, String)>,
    body: String,
    timeout: std::time::Duration,
) -> Result<HttpReply, String> {
    let mut req = reqwest::Client::new()
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .timeout(timeout);
    for (name, value) in headers {
        req = req.header(name, value);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpReply { status, body })
}

/// Anthropic Messages API (summary and connection test; lib/judge.ts)
#[tauri::command]
pub(crate) async fn anthropic_messages(body: String) -> Result<HttpReply, String> {
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
pub(crate) async fn openai_responses(body: String) -> Result<HttpReply, String> {
    let key = key_of("openai").ok_or(NO_KEY)?;
    post_json("https://api.openai.com/v1/responses", vec![("authorization", format!("Bearer {key}"))], body).await
}

// ---- Local AI (docs/design.md "BYOK API keys", Local AI) ----
// An OpenAI-compatible server (Ollama, LM Studio, ...). No key; the base URL and model are settings JS keeps and
// passes here. Called from Rust like the other providers (the WebView's origin would also hit CORS on servers that
// don't allow it)

/// Longer than the cloud: the server may have to load the model first. LOCAL_TIMEOUT_MEASURED
const LOCAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
const LOCAL_MODELS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// `<base URL>/<path>`. Only http(s) URLs are accepted; a trailing slash on the base URL is allowed
fn local_url(base_url: &str, path: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(base).map_err(|e| format!("invalid base url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("invalid base url: not http(s)".into());
    }
    // A user name or password in the URL would end up in error messages and the app log
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("invalid base url: credentials in the url".into());
    }
    // The path is appended to the base URL as text, so a query or fragment would swallow it
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("invalid base url: query or fragment".into());
    }
    Ok(format!("{base}/{path}"))
}

/// Chat Completions (summaries, the concierge, and the connection test; lib/local-judge.ts)
#[tauri::command]
pub(crate) async fn local_chat(base_url: String, body: String) -> Result<HttpReply, String> {
    let url = local_url(&base_url, "chat/completions")?;
    let started = std::time::Instant::now();
    let reply = local_post(&url, body).await;
    let ms = started.elapsed().as_millis();
    match &reply {
        Ok(r) => append_log(&format!("[keys] send local status={} ms={ms}", r.status)),
        Err(e) => append_log(&format!("[keys] send local ms={ms} error={e}")),
    }
    reply
}

/// The server's model list (`GET <base URL>/models`), for picking the model in the settings
#[tauri::command]
pub(crate) async fn local_models(base_url: String) -> Result<HttpReply, String> {
    let url = local_url(&base_url, "models")?;
    let res = local_client()
        .get(&url)
        .timeout(LOCAL_MODELS_TIMEOUT)
        .send()
        .await
        .map_err(local_error)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(local_error)?;
    Ok(HttpReply { status, body })
}

/// The base URL is the user's own setting, so errors (shown to JS and written to the app log) leave it out
fn local_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// Requests to the local server go only to the URL the user set: redirects are not followed
fn local_client() -> reqwest::Client {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap_or_default()
}

async fn local_post(url: &str, body: String) -> Result<HttpReply, String> {
    let res = local_client()
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .timeout(LOCAL_TIMEOUT)
        .send()
        .await
        .map_err(local_error)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(local_error)?;
    Ok(HttpReply { status, body })
}

/// For verification: TOMARIGI_LOCAL_AI="<base URL>|<model>" sets up Local at launch, chooses it, and runs the
/// connection test (JS does the saving, since Local's settings live with the others in IndexedDB; lib/api-keys.ts)
#[tauri::command]
pub(crate) fn local_ai_import() -> Option<(String, String)> {
    let value = std::env::var("TOMARIGI_LOCAL_AI").ok()?;
    let (base_url, model) = value.split_once('|')?;
    Some((base_url.trim().to_string(), model.trim().to_string()))
}

/// For verification: when launched with TOMARIGI_IMPORT_KEY=<provider>, saves the first line of stdin as that
/// provider's key (to verify saving, restarting, and migration in environments where settings can't be operated
/// by hand. The value is not logged, only its length).
/// When the store is webview, passes it to JS via "key-imported" so it goes into IndexedDB (same path as saving there)
pub(crate) fn import_key_from_stdin(app: &AppHandle) {
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

#[cfg(test)]
mod tests {
    use super::{check_known_provider, check_provider, local_url, webview_storage_is_own, Os};
    use std::path::Path;

    #[test]
    fn webview_storage_is_own_inside_an_app_bundle_or_for_dev_on_macos() {
        const EVERYDAY: &str = "net.mohtech.tomarigi-desktop";
        const VERIFY: &str = "net.mohtech.tomarigi-desktop.verify";
        const DEV: &str = "net.mohtech.tomarigi-desktop.dev";
        let cases: [(Os, &str, &str, bool); 14] = [
            (Os::MacOs, EVERYDAY, "/Applications/tomarigi.app/Contents/MacOS/tomarigi-desktop", true),
            (Os::MacOs, VERIFY, "/Users/me/repo/src-tauri/target/release/bundle/macos/tomarigi (verify).app/Contents/MacOS/tomarigi-desktop", true),
            // target/debug, run outside a bundle: shares WebKit storage with every other unbundled build
            (Os::MacOs, EVERYDAY, "/Users/me/repo/src-tauri/target/debug/tomarigi-desktop", false),
            (Os::MacOs, VERIFY, "/Users/me/repo/src-tauri/target/debug/tomarigi-desktop", false),
            (Os::MacOs, EVERYDAY, "/Users/me/repo/src-tauri/target/release/tomarigi-desktop", false),
            // dev (`bun run dev`) outside a bundle: the only build that wrote keys to the shared storage, so it moves
            // the keys it left there to the Keychain
            (Os::MacOs, DEV, "/Users/me/repo/src-tauri/target/debug/tomarigi-desktop", true),
            (Os::MacOs, DEV, "tomarigi-desktop", true),
            // Only the .dev suffix counts
            (Os::MacOs, "net.mohtech.tomarigi-desktop.devtools", "/Users/me/repo/src-tauri/target/debug/tomarigi-desktop", false),
            // Looks like a bundle, but isn't one
            (Os::MacOs, EVERYDAY, "/tmp/tomarigi/Contents/MacOS/tomarigi-desktop", false),
            (Os::MacOs, EVERYDAY, "/tmp/tomarigi.app/MacOS/tomarigi-desktop", false),
            (Os::MacOs, EVERYDAY, "tomarigi-desktop", false),
            // Windows and Linux: Tauri gives each identifier its own data directory
            (Os::Other, EVERYDAY, "C:\\Users\\me\\repo\\src-tauri\\target\\debug\\tomarigi-desktop.exe", true),
            (Os::Other, EVERYDAY, "/home/me/repo/src-tauri/target/debug/tomarigi-desktop", true),
            (Os::Other, DEV, "/home/me/repo/src-tauri/target/debug/tomarigi-desktop", true),
        ];
        for (os, identifier, exe, expected) in cases {
            assert_eq!(webview_storage_is_own(os, identifier, Path::new(exe)), expected, "{identifier} {exe}");
        }
    }

    #[test]
    fn a_retired_provider_can_be_deleted_but_not_saved() {
        assert!(check_provider("openai").is_ok());
        assert!(check_provider("typesafe").is_err());
        assert!(check_known_provider("typesafe").is_ok());
        assert!(check_known_provider("other").is_err());
    }

    #[test]
    fn local_url_joins_and_checks_the_scheme() {
        assert_eq!(local_url("http://localhost:11434/v1", "models").unwrap(), "http://localhost:11434/v1/models");
        assert_eq!(
            local_url(" http://192.168.1.5:1234/v1/ ", "chat/completions").unwrap(),
            "http://192.168.1.5:1234/v1/chat/completions"
        );
        assert!(local_url("file:///etc/passwd", "models").is_err());
        assert!(local_url("localhost:11434", "models").is_err());
        assert!(local_url("http://user:secret@localhost:11434/v1", "models").is_err());
        assert!(local_url("http://localhost:11434/v1?x=1", "models").is_err());
        assert!(local_url("http://localhost:11434/v1#x", "models").is_err());
    }
}
