use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::{append_log, expand, home};

// ---- File reading ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
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
pub(crate) fn io_err(path: &Path, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("NotFound: {}", path.display())
    } else {
        format!("{}: {e}", path.display())
    }
}

#[tauri::command]
pub(crate) fn fs_list(path: &str) -> Result<Vec<Entry>, String> {
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
pub(crate) fn fs_stat(path: &str) -> Result<Entry, String> {
    let p = expand(path);
    let meta = std::fs::metadata(&p).map_err(|e| io_err(&p, e))?;
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(entry_of(name, &meta))
}

/// Reads the byte range [start, end) as UTF-8. Characters cut at the edges of the range become replacement
/// characters (same behavior as Blob.slice().text())
#[tauri::command]
pub(crate) fn fs_read(path: &str, start: u64, end: u64) -> Result<String, String> {
    let p = expand(path);
    let mut f = std::fs::File::open(&p).map_err(|e| io_err(&p, e))?;
    f.seek(SeekFrom::Start(start)).map_err(|e| io_err(&p, e))?;
    let mut buf = Vec::with_capacity(end.saturating_sub(start) as usize);
    f.take(end.saturating_sub(start)).read_to_end(&mut buf).map_err(|e| io_err(&p, e))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Saves the event log from the debug dialog. Writes to ~/Downloads/<name> and returns the path
#[tauri::command]
pub(crate) fn save_download(name: &str, content: &str) -> Result<String, String> {
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
pub(crate) struct DefaultRoot {
    key: &'static str,
    kind: &'static str,
    path: String,
    exists: bool,
}

/// Folders always watched by default (docs/design.md "Watched folders"). Ones that don't exist are
/// also returned, with exists=false (used to decide whether to drop registrations of the same path saved by
/// earlier versions)
#[tauri::command]
pub(crate) fn default_roots() -> Vec<DefaultRoot> {
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
pub(crate) async fn pick_folder(default_path: String) -> Option<String> {
    let start = expand(&default_path);
    let mut dialog = rfd::AsyncFileDialog::new();
    if start.is_dir() {
        dialog = dialog.set_directory(&start);
    }
    let picked = dialog.pick_folder().await?;
    Some(picked.path().to_string_lossy().into_owned())
}
