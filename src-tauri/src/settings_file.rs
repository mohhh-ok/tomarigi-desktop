// ---- The settings file (docs/design.md "Settings file") ----
// Owns the files: where they are, the applied values (the last values that passed the page's checks, file-shaped),
// writing them, and noticing edits. It never checks what a value means: the floating window's page checks an edit with
// the settings screen's own functions (src/lib/settings-file.ts) and tells this side what passed (settings_accept).
// README.md and settings.schema.json are fixed text built in here, with only the paths and the version filled in, so a
// compromise of only the page can't change what agents are told

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::append_log;
use crate::window::WindowMode;

/// The settings the file holds, by their file key. src/lib/settings-file.ts has the same list (a unit test there reads
/// this one)
pub(crate) const FIELDS: [&str; 12] = [
    "chirps",
    "chirpVolume",
    "readAloud",
    "readAloudVolume",
    "readoutVoice",
    "summaryProvider",
    "localAi",
    "windowMode",
    "conciergeLook",
    "iconSets",
    "watchedFolders",
    "defaultFolderLabels",
];

const SCHEMA_REF: &str = "./settings.schema.json";
const README_TEXT: &str = include_str!("../settings-file/README.md");
const SCHEMA_TEXT: &str = include_str!("../settings-file/settings.schema.json");
/// How often the worker looks at the file and writes pending saves: an edit is seen within this, and a dragged slider
/// writes at most 4 times a second
const TICK: Duration = Duration::from_millis(250);
/// After a write fails (another program holding the file open on Windows, permissions, a full disk), the next try waits
/// this long, so a failure that lasts doesn't write, log and keep a copy 4 times a second
const RETRY: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub(crate) struct Paths {
    pub settings: PathBuf,
    pub schema: PathBuf,
    pub readme: PathBuf,
    pub invalid: PathBuf,
    pub tmp: PathBuf,
    /// The copy of the applied values, read only for the fallback (not where users and agents look)
    pub applied: PathBuf,
}

impl Paths {
    fn in_dir(dir: &Path, settings: PathBuf, applied: PathBuf) -> Self {
        Paths {
            schema: dir.join("settings.schema.json"),
            readme: dir.join("README.md"),
            invalid: dir.join("settings.invalid.json"),
            tmp: dir.join("settings.json.tmp"),
            settings,
            applied,
        }
    }
}

/// The folder of a build, from its identifier: the everyday build `~/.tomarigi/`, `.dev` → `~/.tomarigi/dev/`,
/// `.verify` → `~/.tomarigi/verify/`, any other suffix → `~/.tomarigi/<suffix>/`
pub(crate) fn dir_for(home: &Path, identifier: &str) -> PathBuf {
    let base = home.join(".tomarigi");
    match identifier.strip_prefix("net.mohtech.tomarigi-desktop") {
        Some("") | None => base,
        Some(rest) => base.join(rest.trim_start_matches('.')),
    }
}

/// `~/…` with forward slashes, as users and agents are told the path
pub(crate) fn display_path(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.to_string_lossy().replace('\\', "/")),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Event {
    /// The file as it is now, and as it was before the edit (what the app wrote last or saw last), so the page checks
    /// only the keys the edit changed
    Edited { doc: Map<String, Value>, before: Option<Map<String, Value>> },
    Unreadable { line: usize, column: usize },
    InvalidKept,
    Rewritten,
    /// The first failed write of a run of failures (the next ones aren't logged)
    WriteFailed,
    /// The first write that worked after a failure
    WroteAgain,
}

impl Event {
    /// The log line of an event that only goes to the log
    fn log_line(&self) -> Option<&'static str> {
        match self {
            Event::WriteFailed => Some("[settings-file] couldn't write the file"),
            Event::WroteAgain => Some("[settings-file] wrote again after a failure"),
            _ => None,
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub applied: Map<String, Value>,
    /// Keys to write into the file at the next write
    pub dirty: BTreeSet<String>,
    applied_dirty: bool,
    /// The text last seen in the file or written to it
    last_text: Option<String>,
    last_meta: Option<(SystemTime, u64)>,
    last_write: Option<Instant>,
    wrote: bool,
    /// When the last write failed, while writes keep failing
    failed_at: Option<Instant>,
    /// The unreadable text already copied to settings.invalid.json, so a write failing again doesn't copy it again
    kept_invalid: Option<String>,
    #[cfg(test)]
    tries: u32,
    /// The page has loaded the file once (settings_file_fill); before that the worker leaves the file alone
    pub ready: bool,
}

fn meta_of(path: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

pub(crate) fn pretty(doc: &Map<String, Value>) -> String {
    let mut text = serde_json::to_string_pretty(doc).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text
}

#[cfg(unix)]
fn owner_only(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn owner_only(_path: &Path, _mode: u32) {}

/// A new file renamed over the old one, so an agent or an editor never reads a half-written file (rename replaces
/// on Windows too)
fn write_atomic(tmp: &Path, path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(tmp, text)?;
    owner_only(tmp, 0o600);
    std::fs::rename(tmp, path)
}

pub(crate) enum Read {
    Missing,
    Unreadable { line: usize, column: usize },
    Ok(Map<String, Value>),
}

pub(crate) fn parse(text: &str) -> Result<Map<String, Value>, (usize, usize)> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err((1, 1)),
        Err(e) => Err((e.line().max(1), e.column().max(1))),
    }
}

impl State {
    /// Reads the file now and remembers its text, so the worker doesn't take it for an edit
    pub(crate) fn read(&mut self, paths: &Paths) -> Read {
        let Ok(text) = std::fs::read_to_string(&paths.settings) else {
            self.last_text = None;
            self.last_meta = None;
            return Read::Missing;
        };
        self.last_meta = meta_of(&paths.settings);
        self.last_text = Some(text.clone());
        match parse(&text) {
            Ok(doc) => {
                self.mark_missing(&doc);
                Read::Ok(doc)
            }
            Err((line, column)) => Read::Unreadable { line, column },
        }
    }

    /// Table keys missing from the file are written back with their applied values (a file an agent writes with only
    /// the keys it wants becomes whole again)
    fn mark_missing(&mut self, doc: &Map<String, Value>) {
        for key in FIELDS {
            if !doc.contains_key(key) && self.applied.contains_key(key) {
                self.dirty.insert(key.to_string());
            }
        }
    }

    pub(crate) fn set(&mut self, key: &str, value: Value) {
        self.applied.insert(key.to_string(), value);
        self.dirty.insert(key.to_string());
        self.applied_dirty = true;
    }

    /// After the page has loaded the file at launch: every table key the applied values don't have yet gets the page's
    /// value (the first launch: the earlier settings from IndexedDB; else the defaults) and keys missing from the file
    /// are written. A file that isn't valid JSON is left as it is until the screen saves
    pub(crate) fn fill(&mut self, paths: &Paths, values: Map<String, Value>) {
        let file = std::fs::read_to_string(&paths.settings).ok().map(|t| parse(&t));
        let unreadable = matches!(file, Some(Err(_)));
        for (key, value) in values {
            if !FIELDS.contains(&key.as_str()) || self.applied.contains_key(&key) {
                continue;
            }
            if unreadable {
                self.accept(&key, value);
            } else {
                self.set(&key, value);
            }
        }
        match file {
            Some(Ok(doc)) => self.mark_missing(&doc),
            Some(Err(_)) => {}
            None => self.dirty.extend(self.applied.keys().cloned()),
        }
        self.ready = true;
    }

    /// A value from the file that passed: applied, the file isn't written
    pub(crate) fn accept(&mut self, key: &str, value: Value) {
        self.applied.insert(key.to_string(), value);
        self.applied_dirty = true;
    }

    /// One tick of the worker: look at the file, then write pending saves
    pub(crate) fn tick(&mut self, paths: &Paths, now: Instant) -> Vec<Event> {
        let mut events = Vec::new();
        if !self.ready {
            return events;
        }
        let waits = self.look(paths, now, &mut events);
        if !waits
            && !self.dirty.is_empty()
            && self.last_write.is_none_or(|t| now.duration_since(t) >= TICK)
            && self.may_write(now)
        {
            self.write_dirty(paths, now, &mut events);
        }
        if std::mem::take(&mut self.wrote) {
            self.last_write = Some(now);
        }
        if self.applied_dirty {
            self.applied_dirty = false;
            let _ = write_atomic(&paths.applied.with_extension("json.tmp"), &paths.applied, &pretty(&self.applied));
            owner_only(&paths.applied, 0o600);
        }
        events
    }

    fn may_write(&self, now: Instant) -> bool {
        self.failed_at.is_none_or(|t| now.duration_since(t) >= RETRY)
    }

    /// Returns true when the write of this tick waits: the file was edited by someone else (taken first), or a write
    /// was tried already (one try a tick)
    fn look(&mut self, paths: &Paths, now: Instant, events: &mut Vec<Event>) -> bool {
        let meta = meta_of(&paths.settings);
        if meta.is_none() {
            if !self.applied.is_empty() && self.may_write(now) {
                // Written before and gone now: deleted. Never written: the first file, made from the applied values
                let deleted = self.last_text.is_some();
                if !self.write_doc(paths, self.applied.clone(), now, events) {
                    return true;
                }
                self.dirty.clear();
                if deleted {
                    events.push(Event::Rewritten);
                }
            }
            return false;
        }
        if meta == self.last_meta {
            return false;
        }
        let Ok(text) = std::fs::read_to_string(&paths.settings) else { return false };
        self.last_meta = meta;
        if self.last_text.as_deref() == Some(text.as_str()) {
            return false;
        }
        let before = self.last_text.replace(text.clone()).and_then(|t| parse(&t).ok());
        match parse(&text) {
            Ok(doc) => {
                self.mark_missing(&doc);
                events.push(Event::Edited { doc, before });
            }
            Err((line, column)) => events.push(Event::Unreadable { line, column }),
        }
        true
    }

    fn write_dirty(&mut self, paths: &Paths, now: Instant, events: &mut Vec<Event>) {
        let disk = std::fs::read_to_string(&paths.settings).ok();
        if disk.is_some() && disk != self.last_text {
            // Changed since the worker last looked: the next tick takes it as an edit first
            self.last_meta = None;
            return;
        }
        let mut doc = match disk.as_deref().map(parse) {
            Some(Ok(doc)) => doc,
            Some(Err(_)) => {
                if self.kept_invalid != disk {
                    let _ = write_atomic(&paths.invalid.with_extension("json.tmp"), &paths.invalid, disk.as_deref().unwrap_or(""));
                    events.push(Event::InvalidKept);
                    self.kept_invalid = disk.clone();
                }
                self.applied.clone()
            }
            None => self.applied.clone(),
        };
        let keys = std::mem::take(&mut self.dirty);
        for key in &keys {
            match self.applied.get(key) {
                Some(v) => doc.insert(key.clone(), v.clone()),
                None => doc.remove(key),
            };
        }
        if !self.write_doc(paths, doc, now, events) {
            // Written again at a later try (RETRY), with any saves made in between
            self.dirty.extend(keys);
        }
    }

    fn write_doc(&mut self, paths: &Paths, mut doc: Map<String, Value>, now: Instant, events: &mut Vec<Event>) -> bool {
        doc.insert("$schema".into(), Value::String(SCHEMA_REF.into()));
        let text = pretty(&doc);
        #[cfg(test)]
        {
            self.tries += 1;
        }
        if write_atomic(&paths.tmp, &paths.settings, &text).is_ok() {
            self.last_meta = meta_of(&paths.settings);
            self.last_text = Some(text);
            self.wrote = true;
            self.kept_invalid = None;
            if self.failed_at.take().is_some() {
                events.push(Event::WroteAgain);
            }
            #[cfg(debug_assertions)]
            append_log("[settings-file] wrote");
            true
        } else {
            if self.failed_at.is_none() {
                events.push(Event::WriteFailed);
            }
            self.failed_at = Some(now);
            false
        }
    }
}

struct Shared {
    paths: Paths,
    home: PathBuf,
    state: State,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Shared) -> T) -> Option<T> {
    SHARED.lock().unwrap().as_mut().map(f)
}

fn fill_template(text: &str, home: &Path, paths: &Paths) -> String {
    text.replace("{{SETTINGS}}", &display_path(home, &paths.settings))
        .replace("{{SCHEMA}}", &display_path(home, &paths.schema))
        .replace("{{README}}", &display_path(home, &paths.readme))
        .replace("{{LOG}}", &display_path(home, &crate::log_dir().join("app-log.txt")))
        .replace("{{VERSION}}", env!("CARGO_PKG_VERSION"))
}

fn resolve_paths(app: &AppHandle, home: &Path) -> Paths {
    let config = app.path().app_config_dir().unwrap_or_else(|_| home.join(".tomarigi"));
    // Debug builds only: another file for a check, with its copy of the applied values beside it
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("TOMARIGI_SETTINGS_FILE").map(PathBuf::from) {
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        let applied = path.with_extension("applied.json");
        return Paths::in_dir(&dir, path, applied);
    }
    let dir = dir_for(home, &app.config().identifier);
    Paths::in_dir(&dir, dir.join("settings.json"), config.join("settings-applied.json"))
}

/// At launch, before the window: the paths, README.md and the schema, the MCP token removed, the applied values read.
/// Returns the window mode to start in
pub(crate) fn init(app: &AppHandle, fallback_mode: impl FnOnce() -> Option<WindowMode>) -> WindowMode {
    let home = crate::home();
    let paths = resolve_paths(app, &home);
    if let Some(dir) = paths.settings.parent() {
        let made = !dir.exists();
        let _ = std::fs::create_dir_all(dir);
        if made {
            owner_only(dir, 0o700);
        }
    }
    let _ = std::fs::write(&paths.readme, fill_template(README_TEXT, &home, &paths));
    let _ = std::fs::write(&paths.schema, fill_template(SCHEMA_TEXT, &home, &paths));
    crate::keys::delete_mcp_token();
    let applied = std::fs::read_to_string(&paths.applied).ok().and_then(|t| parse(&t).ok()).unwrap_or_default();
    let in_file = std::fs::read_to_string(&paths.settings).ok().and_then(|t| parse(&t).ok());
    let mode_of = |v: Option<&Value>| v.and_then(|v| serde_json::from_value::<WindowMode>(v.clone()).ok());
    let mode = mode_of(in_file.as_ref().and_then(|d| d.get("windowMode")))
        .or_else(|| mode_of(applied.get("windowMode")))
        .or_else(fallback_mode)
        .unwrap_or(WindowMode::Floating);
    append_log(&format!("[settings-file] at {}", display_path(&home, &paths.settings)));
    *SHARED.lock().unwrap() = Some(Shared { paths, home, state: State { applied, ..State::default() } });
    start_worker(app.clone());
    mode
}

fn start_worker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let events = with(|s| s.state.tick(&s.paths, Instant::now())).unwrap_or_default();
        for event in events {
            match event {
                Event::Edited { doc, before } => {
                    let _ = app.emit_to("main", "settings-file-edited", serde_json::json!({ "doc": doc, "before": before }));
                }
                Event::Unreadable { line, column } => {
                    append_log(&format!("[settings-file] unreadable {line}:{column}"));
                    let _ = app.emit_to("main", "settings-file-unreadable", (line, column));
                }
                Event::InvalidKept => {
                    append_log("[settings-file] kept the unreadable text in settings.invalid.json");
                    let _ = app.emit_to("main", "settings-file-invalid-kept", ());
                }
                Event::Rewritten => append_log("[settings-file] rewritten (the file was deleted)"),
                Event::WriteFailed | Event::WroteAgain => {
                    if let Some(line) = event.log_line() {
                        append_log(line);
                    }
                }
            }
        }
    });
}

/// Pending saves are written at once when the app quits, even while a failed write waits for its retry
pub(crate) fn flush() {
    with(|s| {
        if !s.state.dirty.is_empty() {
            let mut events = Vec::new();
            s.state.write_dirty(&s.paths, Instant::now(), &mut events);
            events.iter().filter_map(Event::log_line).for_each(append_log);
        }
    });
}

/// The window mode changed (the menu bar, the screen, or the file): saved unless the applied value is already it
pub(crate) fn window_mode_switched(mode: WindowMode) {
    let value = serde_json::to_value(mode).unwrap_or(Value::Null);
    with(|s| {
        if s.state.applied.get("windowMode") != Some(&value) {
            s.state.set("windowMode", value);
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Opened {
    state: &'static str,
    doc: Option<Map<String, Value>>,
    line: Option<usize>,
    column: Option<usize>,
    applied: Map<String, Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilePaths {
    settings: String,
    settings_absolute: String,
    readme: String,
    log: String,
}

/// The page's first read at launch: the file (missing / ok / unreadable) and the applied values of the last run
#[tauri::command]
pub(crate) fn settings_file_open() -> Option<Opened> {
    with(|s| {
        let applied = s.state.applied.clone();
        match s.state.read(&s.paths) {
            Read::Missing => Opened { state: "missing", doc: None, line: None, column: None, applied },
            Read::Ok(doc) => Opened { state: "ok", doc: Some(doc), line: None, column: None, applied },
            Read::Unreadable { line, column } => {
                append_log(&format!("[settings-file] unreadable {line}:{column}"));
                Opened { state: "unreadable", doc: None, line: Some(line), column: Some(column), applied }
            }
        }
    })
}

/// After the page has loaded the file at launch (State::fill); the worker starts looking at the file
#[tauri::command]
pub(crate) fn settings_file_fill(values: Map<String, Value>) {
    with(|s| s.state.fill(&s.paths, values));
}

#[tauri::command]
pub(crate) fn settings_get(field: String) -> Option<Value> {
    with(|s| s.state.applied.get(&field).cloned()).flatten()
}

/// A save from the screen, the menu bar or the mute button
#[tauri::command]
pub(crate) fn settings_set(field: String, value: Value) -> Result<(), String> {
    if !FIELDS.contains(&field.as_str()) {
        return Err(format!("not a setting of the file: {field}"));
    }
    with(|s| s.state.set(&field, value));
    Ok(())
}

/// A value from the file that passed the page's checks
#[tauri::command]
pub(crate) fn settings_accept(app: AppHandle, field: String, value: Value) -> Result<(), String> {
    if !FIELDS.contains(&field.as_str()) {
        return Err(format!("not a setting of the file: {field}"));
    }
    if field == "windowMode" {
        let mode = serde_json::from_value::<WindowMode>(value.clone()).map_err(|e| e.to_string())?;
        with(|s| s.state.accept(&field, value));
        let handle = app.clone();
        app.run_on_main_thread(move || crate::window::switch_mode(&handle, mode)).ok();
        return Ok(());
    }
    with(|s| s.state.accept(&field, value));
    Ok(())
}

#[tauri::command]
pub(crate) fn settings_file_paths() -> Option<FilePaths> {
    with(|s| FilePaths {
        settings: display_path(&s.home, &s.paths.settings),
        settings_absolute: s.paths.settings.to_string_lossy().into_owned(),
        readme: display_path(&s.home, &s.paths.readme),
        log: display_path(&s.home, &crate::log_dir().join("app-log.txt")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_paths(name: &str) -> Paths {
        let dir = std::env::temp_dir().join(format!("tomarigi-settings-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Paths::in_dir(&dir, dir.join("settings.json"), dir.join("applied.json"))
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn ready(applied: Value) -> State {
        State { applied: obj(applied), ready: true, ..State::default() }
    }

    fn disk(paths: &Paths) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&paths.settings).unwrap()).unwrap()
    }

    /// Makes the modified time differ on file systems with a coarse clock
    fn write_later(path: &Path, text: &str) {
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(path, text).unwrap();
        let later = SystemTime::now() + Duration::from_secs(2);
        let _ = std::fs::File::options().write(true).open(path).and_then(|f| f.set_modified(later));
    }

    #[test]
    fn the_folder_comes_from_the_identifier() {
        let home = Path::new("/h");
        assert_eq!(dir_for(home, "net.mohtech.tomarigi-desktop"), Path::new("/h/.tomarigi"));
        assert_eq!(dir_for(home, "net.mohtech.tomarigi-desktop.dev"), Path::new("/h/.tomarigi/dev"));
        assert_eq!(dir_for(home, "net.mohtech.tomarigi-desktop.verify"), Path::new("/h/.tomarigi/verify"));
        assert_eq!(display_path(home, Path::new("/h/.tomarigi/settings.json")), "~/.tomarigi/settings.json");
    }

    #[test]
    fn a_save_replaces_only_its_key_and_keeps_the_rest_of_the_text() {
        let paths = temp_paths("save");
        std::fs::write(&paths.settings, r#"{"chirps": true, "readAloudVolume": 300, "mine": 1}"#).unwrap();
        let mut s = ready(json!({"chirps": true, "readAloudVolume": 100}));
        assert!(matches!(s.read(&paths), Read::Ok(_)));
        s.dirty.clear();
        s.set("chirps", json!(false));
        assert!(s.tick(&paths, Instant::now()).is_empty());
        // The refused volume and the unknown key are left as the user wrote them
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": false, "readAloudVolume": 300, "mine": 1}));
        // The app's own write is not an edit
        assert!(s.tick(&paths, Instant::now() + TICK).is_empty());
    }

    #[test]
    fn an_edit_is_seen_and_missing_keys_are_written_back() {
        let paths = temp_paths("edit");
        let mut s = ready(json!({"chirps": true, "conciergeLook": "owl"}));
        s.dirty.extend(["chirps".to_string(), "conciergeLook".to_string()]);
        s.tick(&paths, Instant::now());
        write_later(&paths.settings, r#"{"chirps": false}"#);
        let events = s.tick(&paths, Instant::now() + TICK);
        let written = obj(json!({"$schema": SCHEMA_REF, "chirps": true, "conciergeLook": "owl"}));
        assert_eq!(events, vec![Event::Edited { doc: obj(json!({"chirps": false})), before: Some(written) }]);
        s.accept("chirps", json!(false));
        assert!(s.tick(&paths, Instant::now() + TICK * 2).is_empty());
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": false, "conciergeLook": "owl"}));
    }

    #[test]
    fn broken_json_says_where_and_a_save_keeps_the_text() {
        let paths = temp_paths("broken");
        let mut s = ready(json!({"chirps": true}));
        s.dirty.insert("chirps".into());
        s.tick(&paths, Instant::now());
        write_later(&paths.settings, "{\n  \"chirps\": x\n}");
        let events = s.tick(&paths, Instant::now() + TICK);
        assert!(matches!(events.as_slice(), [Event::Unreadable { line: 2, .. }]), "{events:?}");
        s.set("chirps", json!(false));
        let events = s.tick(&paths, Instant::now() + TICK * 2);
        assert_eq!(events, vec![Event::InvalidKept]);
        assert_eq!(std::fs::read_to_string(&paths.invalid).unwrap(), "{\n  \"chirps\": x\n}");
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": false}));
    }

    #[test]
    fn a_deleted_file_is_written_again() {
        let paths = temp_paths("deleted");
        let mut s = ready(json!({"chirps": true}));
        s.dirty.insert("chirps".into());
        s.tick(&paths, Instant::now());
        std::fs::remove_file(&paths.settings).unwrap();
        assert_eq!(s.tick(&paths, Instant::now() + TICK), vec![Event::Rewritten]);
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": true}));
    }

    #[test]
    fn a_value_set_back_by_hand_after_a_save_from_the_screen_is_an_edit_with_the_save_before_it() {
        let paths = temp_paths("setback");
        let mut s = ready(json!({"chirps": true}));
        s.dirty.insert("chirps".into());
        let start = Instant::now();
        s.tick(&paths, start);
        s.set("chirps", json!(false));
        s.tick(&paths, start + TICK);
        assert_eq!(disk(&paths)["chirps"], json!(false));
        write_later(&paths.settings, r#"{"$schema": "./settings.schema.json", "chirps": true}"#);
        let events = s.tick(&paths, start + TICK * 2);
        let before = obj(json!({"$schema": SCHEMA_REF, "chirps": false}));
        assert_eq!(events, vec![Event::Edited { doc: obj(json!({"$schema": SCHEMA_REF, "chirps": true})), before: Some(before) }]);
    }

    #[test]
    fn the_first_file_is_written_without_calling_it_deleted() {
        let paths = temp_paths("first");
        let mut s = ready(json!({"chirps": true}));
        assert!(s.tick(&paths, Instant::now()).is_empty());
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": true}));
    }

    #[test]
    fn saves_in_quick_succession_are_written_at_most_once_a_tick() {
        let paths = temp_paths("slider");
        let mut s = ready(json!({"chirpVolume": 100}));
        s.dirty.insert("chirpVolume".into());
        let start = Instant::now();
        s.tick(&paths, start);
        s.set("chirpVolume", json!(50));
        s.tick(&paths, start + Duration::from_millis(100));
        assert_eq!(disk(&paths)["chirpVolume"], json!(100));
        s.tick(&paths, start + TICK);
        assert_eq!(disk(&paths)["chirpVolume"], json!(50));
    }

    #[test]
    fn an_edit_between_looks_is_taken_before_a_save_is_written() {
        let paths = temp_paths("race");
        let mut s = ready(json!({"chirps": true, "readAloud": false}));
        s.dirty.extend(["chirps".to_string(), "readAloud".to_string()]);
        s.tick(&paths, Instant::now());
        s.set("chirps", json!(false));
        // Written by an agent after the last look, with the same size and time as far as the look can tell
        std::fs::write(&paths.settings, r#"{"chirps": true, "readAloud": true}"#).unwrap();
        s.last_meta = meta_of(&paths.settings);
        let mut events = Vec::new();
        s.write_dirty(&paths, Instant::now(), &mut events);
        assert_eq!(disk(&paths)["readAloud"], json!(true));
        let events = s.tick(&paths, Instant::now() + TICK);
        let before = obj(json!({"$schema": SCHEMA_REF, "chirps": true, "readAloud": false}));
        assert_eq!(events, vec![Event::Edited { doc: obj(json!({"chirps": true, "readAloud": true})), before: Some(before) }]);
    }

    #[test]
    fn a_file_unreadable_at_launch_is_left_alone_until_the_screen_saves() {
        let paths = temp_paths("unreadable-launch");
        let text = "{\n  \"chirps\": x\n}";
        std::fs::write(&paths.settings, text).unwrap();
        let mut s = State { applied: obj(json!({"chirps": true})), ..State::default() };
        assert!(matches!(s.read(&paths), Read::Unreadable { line: 2, .. }));
        s.fill(&paths, obj(json!({"chirps": false, "readAloud": true})));
        assert_eq!(s.applied, obj(json!({"chirps": true, "readAloud": true})));
        let start = Instant::now();
        for i in 0..4 {
            assert!(s.tick(&paths, start + TICK * i).is_empty());
        }
        assert_eq!(std::fs::read_to_string(&paths.settings).unwrap(), text);
        assert!(!paths.invalid.exists());
        s.set("chirps", json!(false));
        assert_eq!(s.tick(&paths, start + TICK * 4), vec![Event::InvalidKept]);
        assert_eq!(std::fs::read_to_string(&paths.invalid).unwrap(), text);
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": false, "readAloud": true}));
    }

    /// Ticks every 250 ms over `span` after `from`, gathering the events
    fn ticks(s: &mut State, paths: &Paths, from: Instant, span: Duration) -> Vec<Event> {
        let mut events = Vec::new();
        let mut t = TICK;
        while t <= span {
            events.extend(s.tick(paths, from + t));
            t += TICK;
        }
        events
    }

    #[test]
    fn a_save_that_couldnt_be_written_is_tried_again_every_5_seconds_and_logged_once() {
        let paths = temp_paths("write-fails");
        let mut s = ready(json!({"chirps": true}));
        s.dirty.insert("chirps".into());
        let start = Instant::now();
        s.tick(&paths, start);
        s.set("chirps", json!(false));
        // A folder where the temporary file goes makes the write fail
        std::fs::create_dir(&paths.tmp).unwrap();
        s.tries = 0;
        let events = ticks(&mut s, &paths, start, RETRY * 2);
        // Tried at 250 ms and 5.25 s; the next try would be at 10.25 s
        assert_eq!(s.tries, 2);
        assert_eq!(events, vec![Event::WriteFailed]);
        assert_eq!(disk(&paths)["chirps"], json!(true));
        assert!(s.dirty.contains("chirps"));
        std::fs::remove_dir(&paths.tmp).unwrap();
        let events = ticks(&mut s, &paths, start + RETRY * 2, RETRY);
        assert_eq!(events, vec![Event::WroteAgain]);
        assert_eq!(disk(&paths)["chirps"], json!(false));
        assert!(s.dirty.is_empty());
        // Back to the 250 ms spacing once a write works
        s.set("chirps", json!(true));
        let after = start + RETRY * 3 + TICK;
        assert!(s.tick(&paths, after).is_empty());
        assert_eq!(disk(&paths)["chirps"], json!(true));
    }

    #[test]
    fn an_unreadable_file_that_cant_be_written_is_kept_and_noted_once() {
        let paths = temp_paths("invalid-write-fails");
        let text = "{\n  \"chirps\": x\n}";
        std::fs::write(&paths.settings, text).unwrap();
        let mut s = State { applied: obj(json!({"chirps": true})), ..State::default() };
        assert!(matches!(s.read(&paths), Read::Unreadable { .. }));
        s.fill(&paths, Map::new());
        s.set("chirps", json!(false));
        std::fs::create_dir(&paths.tmp).unwrap();
        let start = Instant::now();
        let events = ticks(&mut s, &paths, start, RETRY * 3);
        assert_eq!(events, vec![Event::InvalidKept, Event::WriteFailed]);
        assert_eq!(std::fs::read_to_string(&paths.settings).unwrap(), text);
        std::fs::remove_dir(&paths.tmp).unwrap();
        let events = ticks(&mut s, &paths, start + RETRY * 3, RETRY);
        assert_eq!(events, vec![Event::WroteAgain]);
        assert_eq!(std::fs::read_to_string(&paths.invalid).unwrap(), text);
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": false}));
    }

    #[test]
    fn a_missing_file_that_cant_be_written_is_tried_once_a_tick_at_most() {
        let paths = temp_paths("missing-write-fails");
        let mut s = ready(json!({"chirps": true}));
        s.dirty.insert("chirps".into());
        std::fs::create_dir(&paths.tmp).unwrap();
        let start = Instant::now();
        assert_eq!(s.tick(&paths, start), vec![Event::WriteFailed]);
        assert_eq!(s.tries, 1);
        let events = ticks(&mut s, &paths, start, RETRY - TICK);
        assert!(events.is_empty());
        assert_eq!(s.tries, 1);
        std::fs::remove_dir(&paths.tmp).unwrap();
        assert_eq!(s.tick(&paths, start + RETRY), vec![Event::WroteAgain]);
        assert_eq!(disk(&paths), json!({"$schema": SCHEMA_REF, "chirps": true}));
    }

    #[test]
    fn a_save_that_couldnt_be_written_at_quit_is_kept_for_the_next_write() {
        let paths = temp_paths("flush-fails");
        let mut s = ready(json!({"chirps": true}));
        s.dirty.insert("chirps".into());
        s.tick(&paths, Instant::now());
        s.set("chirps", json!(false));
        std::fs::create_dir(&paths.tmp).unwrap();
        let mut events = Vec::new();
        s.write_dirty(&paths, Instant::now(), &mut events);
        assert!(s.dirty.contains("chirps"));
        std::fs::remove_dir(&paths.tmp).unwrap();
        s.write_dirty(&paths, Instant::now(), &mut events);
        assert_eq!(disk(&paths)["chirps"], json!(false));
    }

    #[test]
    fn nothing_is_written_before_the_page_has_loaded_the_file() {
        let paths = temp_paths("notready");
        let mut s = State { applied: obj(json!({"chirps": true})), ..State::default() };
        s.set("chirps", json!(false));
        s.tick(&paths, Instant::now());
        assert!(!paths.settings.exists());
    }

    #[test]
    fn the_built_in_texts_have_every_field_and_fill_in_the_paths() {
        let schema: Value = serde_json::from_str(SCHEMA_TEXT).unwrap();
        let props = schema["properties"].as_object().unwrap();
        for f in FIELDS {
            assert!(props.contains_key(f), "{f} in the schema");
        }
        let paths = Paths::in_dir(Path::new("/h/.tomarigi"), "/h/.tomarigi/settings.json".into(), "/x".into());
        let readme = fill_template(README_TEXT, Path::new("/h"), &paths);
        assert!(readme.contains("~/.tomarigi/settings.json"));
        assert!(!readme.contains("{{"));
    }
}
