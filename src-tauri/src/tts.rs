// Readout voice from a local TTS server (docs/design.md "Readout voice (local TTS server)"). OpenAI-compatible
// (`/audio/speech`) and VOICEVOX-compatible (`/audio_query` then `/synthesis`). No key; the base URL, voice and model
// are settings JS passes here. Called from Rust like the Local AI provider: VOICEVOX's CORS allows only localhost-like
// origins, which the WebView's isn't. The base URL rule, no redirects, and no URL in errors are Local AI's (keys.rs)

use std::time::{Duration, Instant};

use crate::keys::{local_client, local_error, local_url, HttpReply};

const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// Server messages put in errors (shown in the settings' Test and written to the app log) are cut to this
const MESSAGE_MAX: usize = 200;

/// The paths `tts_list` may read, per kind; anything else is refused so the page can't use it as a general GET
fn list_path_allowed(kind: &str, path: &str) -> bool {
    matches!((kind, path), ("voicevox", "speakers" | "engine_manifest") | ("openai", "audio/voices" | "models"))
}

/// The body of `POST <base>/audio/speech`. WAV, which every WebView can decode
fn openai_body(model: &str, voice: &str, text: &str) -> String {
    serde_json::json!({ "model": model, "input": text, "voice": voice, "response_format": "wav" }).to_string()
}

/// `<base>/<path>?text=...&speaker=...` (VOICEVOX takes its arguments as query parameters)
fn voicevox_url(base_url: &str, path: &str, params: &[(&str, &str)]) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&local_url(base_url, path)?).map_err(|e| format!("invalid base url: {e}"))?;
    url.query_pairs_mut().extend_pairs(params);
    Ok(url.to_string())
}

/// Whether a 2xx answer is audio: by its content type, or by the first bytes when the type is missing or generic
fn is_audio(content_type: Option<&str>, bytes: &[u8]) -> bool {
    if content_type.is_some_and(|t| t.trim().to_ascii_lowercase().starts_with("audio/")) {
        return true;
    }
    bytes.starts_with(b"RIFF")
        || bytes.starts_with(b"ID3")
        || bytes.starts_with(b"OggS")
        || bytes.starts_with(b"fLaC")
        || (bytes.len() > 1 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0)
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        Err("timeout".into())
    } else {
        Ok(left)
    }
}

fn send_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout".into()
    } else {
        format!("network: {}", local_error(e))
    }
}

/// A non-2xx answer as `http-<status>: <message>`
fn http_error(status: u16, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let message: String = text.chars().take(MESSAGE_MAX).collect();
    format!("http-{status}: {}", message.trim())
}

async fn post(url: &str, body: Option<String>, deadline: Instant) -> Result<(u16, Option<String>, Vec<u8>), String> {
    let mut req = local_client().post(url).timeout(remaining(deadline)?);
    if let Some(body) = body {
        req = req.header("content-type", "application/json").body(body);
    }
    let res = req.send().await.map_err(send_error)?;
    let status = res.status().as_u16();
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_string);
    let bytes = res.bytes().await.map_err(send_error)?;
    Ok((status, content_type, bytes.to_vec()))
}

async fn synthesize(
    kind: &str,
    base_url: &str,
    model: &str,
    voice: &str,
    text: &str,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let (status, content_type, bytes) = match kind {
        "openai" => post(&local_url(base_url, "audio/speech")?, Some(openai_body(model, voice, text)), deadline).await?,
        "voicevox" => {
            let (status, _, query) =
                post(&voicevox_url(base_url, "audio_query", &[("text", text), ("speaker", voice)])?, None, deadline)
                    .await?;
            if !(200..300).contains(&status) {
                return Err(http_error(status, &query));
            }
            let query = String::from_utf8(query).map_err(|_| "not-audio".to_string())?;
            post(&voicevox_url(base_url, "synthesis", &[("speaker", voice)])?, Some(query), deadline).await?
        }
        _ => return Err("unknown kind".into()),
    };
    if !(200..300).contains(&status) {
        return Err(http_error(status, &bytes));
    }
    if !is_audio(content_type.as_deref(), &bytes) {
        return Err("not-audio".into());
    }
    Ok(bytes)
}

/// One utterance's audio, as raw bytes (not a JSON array of numbers). Errors are `timeout`, `network: …`,
/// `http-<status>: …` or `not-audio`; JS decides what to do with them (lib/tts-server.ts)
#[tauri::command]
pub(crate) async fn tts_speech(
    kind: String,
    base_url: String,
    model: Option<String>,
    voice: String,
    text: String,
    timeout_ms: u64,
) -> Result<tauri::ipc::Response, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let audio = synthesize(&kind, &base_url, model.as_deref().unwrap_or(""), &voice, &text, deadline).await?;
    Ok(tauri::ipc::Response::new(audio))
}

/// A list the settings read: VOICEVOX's speakers and engine manifest, an OpenAI-compatible server's voices and models
#[tauri::command]
pub(crate) async fn tts_list(kind: String, base_url: String, path: String) -> Result<HttpReply, String> {
    if !list_path_allowed(&kind, &path) {
        return Err(format!("not a list path: {path}"));
    }
    let url = local_url(&base_url, &path)?;
    let res = local_client().get(&url).timeout(LIST_TIMEOUT).send().await.map_err(local_error)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(local_error)?;
    Ok(HttpReply { status, body })
}

/// For verification: TOMARIGI_LOCAL_TTS="<kind>|<base URL>|<voice>|<model>" sets the local readout voice at launch and
/// runs its test (JS saves it, since the setting lives with the others in IndexedDB; lib/readout-voice.ts)
#[tauri::command]
pub(crate) fn local_tts_import() -> Option<Vec<String>> {
    let value = std::env::var("TOMARIGI_LOCAL_TTS").ok()?;
    let parts: Vec<String> = value.split('|').map(|p| p.trim().to_string()).collect();
    (parts.len() >= 3).then_some(parts)
}

#[cfg(test)]
mod tests {
    use super::{is_audio, list_path_allowed, openai_body, voicevox_url};

    #[test]
    fn openai_body_asks_for_wav() {
        let body: serde_json::Value = serde_json::from_str(&openai_body("kokoro", "jf_alpha", "こんにちは")).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "model": "kokoro", "input": "こんにちは", "voice": "jf_alpha", "response_format": "wav" })
        );
    }

    #[test]
    fn voicevox_urls_carry_the_text_and_speaker_as_query() {
        assert_eq!(
            voicevox_url("http://localhost:50021/", "audio_query", &[("text", "あ&b"), ("speaker", "3")]).unwrap(),
            "http://localhost:50021/audio_query?text=%E3%81%82%26b&speaker=3"
        );
        assert_eq!(
            voicevox_url("http://localhost:10101", "synthesis", &[("speaker", "888753760")]).unwrap(),
            "http://localhost:10101/synthesis?speaker=888753760"
        );
        // The Local AI rule applies
        assert!(voicevox_url("http://localhost:50021?x=1", "synthesis", &[]).is_err());
        assert!(voicevox_url("file:///tmp", "synthesis", &[]).is_err());
    }

    #[test]
    fn audio_is_told_by_type_or_bytes() {
        assert!(is_audio(Some("audio/wav"), b""));
        assert!(is_audio(Some("application/octet-stream"), b"RIFF\0\0\0\0WAVE"));
        assert!(is_audio(None, b"ID3\x04"));
        assert!(is_audio(None, &[0xFF, 0xFB, 0x90]));
        assert!(!is_audio(Some("text/html"), b"<!doctype html>"));
        assert!(!is_audio(Some("application/json"), b"{\"detail\":\"Not Found\"}"));
    }

    #[test]
    fn only_the_list_paths_of_each_kind_are_read() {
        assert!(list_path_allowed("voicevox", "speakers"));
        assert!(list_path_allowed("voicevox", "engine_manifest"));
        assert!(list_path_allowed("openai", "audio/voices"));
        assert!(list_path_allowed("openai", "models"));
        assert!(!list_path_allowed("openai", "speakers"));
        assert!(!list_path_allowed("voicevox", "../admin"));
    }
}
