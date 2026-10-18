// ---- OpenCode sessions (docs/design.md "Agents") ----
// OpenCode keeps its sessions in a SQLite database (`~/.local/share/opencode/opencode.db`, WAL). It is opened
// read-only, so OpenCode's own writes are never blocked. The tables are OpenCode internals (measured with
// opencode 1.19.0: session / message / part, with message.data and part.data as JSON); the JS adapter
// (src/lib/opencode-transcript.ts) turns what is returned here into the shared TailInfo

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::expand;

const TEXT_HEAD_CHARS: usize = 500;
const TEXT_TAIL_CHARS: usize = 2000;
const INPUT_CHARS: usize = 500;
/// Messages read per session. One user request can be many assistant messages (one per step), so this is enough
/// to reach the last user message in normal use
const TAIL_MESSAGES: i64 = 40;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeSession {
    id: String,
    directory: String,
    parent_id: Option<String>,
    time_created: f64,
    /// The newest time_updated over the session and its messages and parts (epoch ms)
    last_write_at: f64,
}

#[derive(Serialize)]
pub(crate) struct OpenCodeScan {
    /// Whether the database file exists
    present: bool,
    sessions: Vec<OpenCodeSession>,
    reliable: bool,
}

fn open(db_path: &str) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        expand(db_path),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(500))?;
    Ok(conn)
}

/// Sessions that aren't archived, with when each was last written
#[tauri::command]
pub(crate) async fn opencode_sessions(db_path: String) -> OpenCodeScan {
    tauri::async_runtime::spawn_blocking(move || opencode_sessions_blocking(&db_path))
        .await
        .unwrap_or(OpenCodeScan { present: true, sessions: Vec::new(), reliable: false })
}

fn opencode_sessions_blocking(db_path: &str) -> OpenCodeScan {
    if !expand(db_path).is_file() {
        return OpenCodeScan { present: false, sessions: Vec::new(), reliable: true };
    }
    match read_sessions(db_path) {
        Ok(sessions) => OpenCodeScan { present: true, sessions, reliable: true },
        Err(e) => {
            crate::append_log(&format!("[opencode] sessions failed: {e}"));
            OpenCodeScan { present: true, sessions: Vec::new(), reliable: false }
        }
    }
}

fn read_sessions(db_path: &str) -> rusqlite::Result<Vec<OpenCodeSession>> {
    let conn = open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.directory, s.parent_id, s.time_created,
           MAX(s.time_updated,
               COALESCE((SELECT MAX(time_updated) FROM message WHERE session_id = s.id), 0),
               COALESCE((SELECT MAX(time_updated) FROM part WHERE session_id = s.id), 0))
         FROM session s WHERE s.time_archived IS NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(OpenCodeSession {
            id: row.get(0)?,
            directory: row.get(1)?,
            parent_id: row.get(2)?,
            time_created: row.get::<_, i64>(3)? as f64,
            last_write_at: row.get::<_, i64>(4)? as f64,
        })
    })?;
    rows.collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenCodeMessage {
    id: String,
    time_created: f64,
    time_updated: f64,
    /// message.data with only the fields the adapter uses (role, finish, time, error name)
    data: Value,
    /// part.data of the message's parts in order, cut down the same way
    parts: Vec<Value>,
}

/// The last messages of one session, oldest first. None if the session is gone
#[tauri::command]
pub(crate) async fn opencode_tail(db_path: String, session_id: String) -> Result<Option<Vec<OpenCodeMessage>>, String> {
    tauri::async_runtime::spawn_blocking(move || read_tail(&db_path, &session_id).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

fn read_tail(db_path: &str, session_id: &str) -> rusqlite::Result<Option<Vec<OpenCodeMessage>>> {
    let conn = open(db_path)?;
    let exists: Option<String> =
        conn.query_row("SELECT id FROM session WHERE id = ?1", [session_id], |row| row.get(0)).optional()?;
    if exists.is_none() {
        return Ok(None);
    }
    let mut stmt = conn.prepare(
        "SELECT id, time_created, time_updated, data FROM message WHERE session_id = ?1
         ORDER BY time_created DESC, id DESC LIMIT ?2",
    )?;
    let mut messages = stmt
        .query_map(rusqlite::params![session_id, TAIL_MESSAGES], |row| {
            Ok(OpenCodeMessage {
                id: row.get(0)?,
                time_created: row.get::<_, i64>(1)? as f64,
                time_updated: row.get::<_, i64>(2)? as f64,
                data: trim_message(&row.get::<_, String>(3)?),
                parts: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    messages.reverse();
    let mut parts = conn.prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY id")?;
    for message in &mut messages {
        message.parts = parts
            .query_map([&message.id], |row| row.get::<_, String>(0))?
            .filter_map(|data| data.ok().map(|d| trim_part(&d)))
            .collect();
    }
    Ok(Some(messages))
}

fn trim_message(data: &str) -> Value {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Value::Null };
    json!({
        "role": v.get("role"),
        "finish": v.get("finish"),
        "time": v.get("time"),
        "error": v.pointer("/error/name"),
    })
}

/// Text is kept as its head (user messages) and its tail (replies); tool input is kept as the head of its JSON;
/// tool output is dropped
fn trim_part(data: &str) -> Value {
    let Ok(v) = serde_json::from_str::<Value>(data) else { return Value::Null };
    let text = v.get("text").and_then(|t| t.as_str()).map(|t| {
        let chars: Vec<char> = t.chars().collect();
        let head: String = chars.iter().take(TEXT_HEAD_CHARS).collect();
        let tail: String = chars[chars.len().saturating_sub(TEXT_TAIL_CHARS)..].iter().collect();
        json!({ "head": head, "tail": tail })
    });
    let input = v
        .pointer("/state/input")
        .map(|i| i.to_string().chars().take(INPUT_CHARS).collect::<String>());
    json!({
        "type": v.get("type"),
        "synthetic": v.get("synthetic"),
        "text": text,
        "tool": v.get("tool"),
        "status": v.pointer("/state/status"),
        "input": input,
        "time": v.get("time").or_else(|| v.pointer("/state/time")),
        "reason": v.get("reason"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tables as opencode 1.19.0 creates them (only the columns read here)
    fn fixture_db() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("tomarigi-opencode-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, parent_id text,
               time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
             CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
               time_updated integer NOT NULL, data text NOT NULL);
             CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
               time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
             INSERT INTO session VALUES ('ses_a', '/work/a', NULL, 1000, 1000, NULL);
             INSERT INTO session VALUES ('ses_old', '/work/a', NULL, 10, 20, 30);
             INSERT INTO message VALUES ('msg_1', 'ses_a', 1100, 1100, '{\"role\":\"user\",\"time\":{\"created\":1100}}');
             INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_a', 1100, 1100, '{\"type\":\"text\",\"text\":\"hello\"}');
             INSERT INTO message VALUES ('msg_2', 'ses_a', 1200, 1500,
               '{\"role\":\"assistant\",\"finish\":\"tool-calls\",\"time\":{\"created\":1200,\"completed\":1500}}');
             INSERT INTO part VALUES ('prt_2', 'msg_2', 'ses_a', 1200, 1900,
               '{\"type\":\"tool\",\"tool\":\"bash\",\"callID\":\"c\",\"state\":{\"status\":\"completed\",\"input\":{\"command\":\"ls\"},\"output\":\"secret output\",\"time\":{\"start\":1300,\"end\":1400}}}');",
        )
        .unwrap();
        path
    }

    #[test]
    fn reads_live_sessions_and_their_last_messages_read_only() {
        let path = fixture_db();
        let db = path.to_str().unwrap();
        let scan = opencode_sessions_blocking(db);
        assert!(scan.present && scan.reliable);
        let ids: Vec<(&str, f64)> = scan.sessions.iter().map(|s| (s.id.as_str(), s.last_write_at)).collect();
        assert_eq!(ids, vec![("ses_a", 1900.0)]);

        let tail = read_tail(db, "ses_a").unwrap().unwrap();
        assert_eq!(tail.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["msg_1", "msg_2"]);
        assert_eq!(tail[0].parts[0]["text"]["head"], "hello");
        assert_eq!(tail[1].data["finish"], "tool-calls");
        assert_eq!(tail[1].parts[0]["tool"], "bash");
        assert_eq!(tail[1].parts[0]["status"], "completed");
        assert!(!tail[1].parts[0].to_string().contains("secret output"));
        assert!(read_tail(db, "ses_missing").unwrap().is_none());

        // Opened read-only: a write through the same connection type fails
        let conn = open(db).unwrap();
        assert!(conn.execute("DELETE FROM session", []).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_database_is_reliable_and_empty() {
        let scan = opencode_sessions_blocking("/nonexistent/tomarigi/opencode.db");
        assert!(!scan.present && scan.reliable && scan.sessions.is_empty());
    }
}
