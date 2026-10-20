use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use crate::append_log;

// ---- BYOK API keys and the API calls that use them ----
// docs/design.md "BYOK API keys". Key values are handled only inside Rust and never returned to the WebView JS.
// The store is decided once at startup from the identifier: everyday use and verify use the OS store (items per
// identifier): the macOS Keychain, Windows Credential Manager, or Linux Secret Service (GNOME Keyring / KWallet)
// through the keyring crate. On Linux without Secret Service keys can't be saved; there is no plaintext fallback
// (docs/design.md "Platforms"). dev (identifier ending in .dev) uses the WebView's IndexedDB. This is because the dev
// signature changes on every build, and Keychain permission would be asked every time. In dev, JS keeps the keys
// in IndexedDB and passes them to Rust at startup and on save (Rust keeps them only in memory). API calls that
// use keys are made from Rust with either store

const KEY_PROVIDERS: [&str; 3] = ["anthropic", "openai", "typesafe"];

enum KeyStore {
    /// OS store (Keychain generic password on macOS). service is `<identifier>.byok`, account is the provider name
    Keychain { service: String },
    /// dev: IndexedDB is the source of truth; Rust only keeps a copy in memory
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
/// Copy of keys that were read or saved (so the Keychain isn't read over and over)
static KEY_CACHE: Mutex<Option<std::collections::HashMap<String, String>>> = Mutex::new(None);

fn key_store() -> &'static KeyStore {
    KEY_STORE.get_or_init(|| KeyStore::WebView)
}

/// Called once at startup. TOMARIGI_KEY_BACKEND=webview is an override for verifying migration from IndexedDB
pub(crate) fn init_key_store(identifier: &str) {
    let store = if identifier.ends_with(".dev")
        || std::env::var("TOMARIGI_KEY_BACKEND").is_ok_and(|v| v == "webview")
    {
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

/// The store. JS checks this and saves to IndexedDB only for dev (webview); "unavailable" makes the settings say keys
/// can't be saved
#[tauri::command]
pub(crate) fn key_backend() -> &'static str {
    match key_store() {
        KeyStore::Keychain { .. } => "keychain",
        KeyStore::WebView => "webview",
        KeyStore::Unavailable(_) => "unavailable",
    }
}

/// Whether a key is saved, per provider. Values are not returned
#[tauri::command]
pub(crate) fn key_status() -> std::collections::HashMap<String, bool> {
    KEY_PROVIDERS.iter().map(|p| (p.to_string(), key_of(p).is_some())).collect()
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
    check_provider(&provider)?;
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

/// TypeSafe evaluation API (docs/design.md "The "?" for sessions waiting on you"). api.typesafe.ai rejects the
/// WKWebView origin (tauri://localhost) via CORS, and keys are not passed to JS, so it is called here.
/// body is the JSON built by the JS side, sent as is; the reply's status and body are also returned as is
/// (interpreted in lib/jev.ts)
#[tauri::command]
pub(crate) async fn typesafe_systemone(body: String) -> Result<HttpReply, String> {
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
/// When the store is webview, passes it to JS via "key-imported" so it goes into IndexedDB (same path as dev)
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
    use super::local_url;

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
