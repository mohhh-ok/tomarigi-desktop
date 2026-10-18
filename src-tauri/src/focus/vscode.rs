// VS Code / Cursor and other VS Code forks: Tomarigi's own extension (vscode-extension/) writes one file per editor
// window to ~/.tomarigi/vscode/<uriScheme>-<extension host pid>.json with a URI addressed to that window and the
// processId of every terminal in it. The window whose terminals include the agent or one of its ancestors gets that
// URI opened with the pids added; the extension shows the terminal and the editor brings the window to the front.
// No file, no URI: an editor without the extension asks to install it for every unknown URI
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::Proc;

/// One editor window, as written by the extension
#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Window {
    /// `<scheme>://<extension id>/focus?windowId=<n>` from `env.asExternalUri`
    pub(super) uri: String,
    pub(super) extension_host_pid: u32,
    pub(super) terminal_pids: Vec<u32>,
}

pub(super) fn dir() -> PathBuf {
    crate::home().join(".tomarigi").join("vscode")
}

pub(super) fn read_windows(dir: &Path) -> Vec<Window> {
    let Ok(items) = std::fs::read_dir(dir) else { return Vec::new() };
    items
        .flatten()
        .map(|i| i.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok())
        .collect()
}

/// The window that has a terminal on the chain and whose extension host is still running (a file left by a crashed
/// window has a dead extension host)
pub(super) fn window_of<'a>(windows: &'a [Window], chain: &[Proc], procs: &HashMap<u32, Proc>) -> Option<&'a Window> {
    windows
        .iter()
        .filter(|w| procs.contains_key(&w.extension_host_pid))
        .find(|w| chain.iter().any(|p| w.terminal_pids.contains(&p.pid)))
}

/// The window's URI with the chain's pids added to its query (which already has windowId)
pub(super) fn focus_uri(window: &Window, chain: &[Proc]) -> String {
    let pids = chain.iter().map(|p| p.pid.to_string()).collect::<Vec<_>>().join(",");
    let sep = if window.uri.contains('?') { '&' } else { '?' };
    format!("{}{sep}pids={pids}", window.uri)
}

/// Only an editor URI to the extension's focus path is opened, so a file written by something else can't make
/// Tomarigi open a web page or a local file
pub(super) fn is_editor_uri(uri: &str) -> bool {
    let Some((scheme, rest)) = uri.split_once("://") else { return false };
    let scheme_ok = !scheme.is_empty()
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        && !["http", "https", "file", "ftp", "mailto"].contains(&scheme.to_ascii_lowercase().as_str());
    let path = rest.split(['?', '#']).next().unwrap_or("");
    scheme_ok && path.split_once('/').is_some_and(|(_, p)| p == "focus")
}

/// Ok when a window was found and its URI was handed to the OS
pub(super) fn focus(chain: &[Proc], procs: &HashMap<u32, Proc>) -> Result<String, String> {
    let windows = read_windows(&dir());
    let window = window_of(&windows, chain, procs).ok_or("vscode: no window")?;
    if !is_editor_uri(&window.uri) {
        return Err(format!("vscode: not an editor uri {}", window.uri));
    }
    let uri = focus_uri(window, chain);
    tauri_plugin_opener::open_url(&uri, None::<&str>).map_err(|e| format!("open {uri}: {e}"))?;
    Ok(format!("vscode {uri}"))
}

#[cfg(test)]
mod tests {
    use super::super::{ancestors, parse_ps};
    use super::*;

    const PS: &str = "    1     0 ??       /sbin/launchd
  500     1 ??       /Applications/Cursor.app/Contents/MacOS/Cursor
  510   500 ??       /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)
  520   500 ??       /Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper
  530   520 ttys004  /bin/zsh
  540   530 ttys004  claude
";

    fn window(ext_host: u32, terminals: &[u32]) -> Window {
        Window {
            uri: format!("cursor://mohtech.tomarigi/focus?windowId={ext_host}"),
            extension_host_pid: ext_host,
            terminal_pids: terminals.to_vec(),
        }
    }

    #[test]
    fn the_window_with_a_terminal_on_the_chain_is_chosen() {
        let procs = parse_ps(PS);
        let chain = ancestors(&procs, 540);
        let windows = [window(510, &[777]), window(510, &[530])];
        assert_eq!(window_of(&windows, &chain, &procs), Some(&windows[1]));
        assert_eq!(window_of(&windows[..1], &chain, &procs), None);
    }

    #[test]
    fn a_window_whose_extension_host_is_gone_is_skipped() {
        let procs = parse_ps(PS);
        let chain = ancestors(&procs, 540);
        assert_eq!(window_of(&[window(999, &[530])], &chain, &procs), None);
    }

    #[test]
    fn the_uri_gets_the_pids_of_the_chain() {
        let procs = parse_ps(PS);
        let chain = ancestors(&procs, 540);
        assert_eq!(
            focus_uri(&window(510, &[530]), &chain),
            "cursor://mohtech.tomarigi/focus?windowId=510&pids=540,530,520,500"
        );
        let plain = Window { uri: "vscode://mohtech.tomarigi/focus".into(), extension_host_pid: 1, terminal_pids: vec![] };
        assert_eq!(focus_uri(&plain, &chain[..1]), "vscode://mohtech.tomarigi/focus?pids=540");
    }

    #[test]
    fn only_editor_uris_to_the_focus_path_are_opened() {
        assert!(is_editor_uri("cursor://mohtech.tomarigi/focus?windowId=3"));
        assert!(is_editor_uri("vscode-insiders://mohtech.tomarigi/focus"));
        assert!(!is_editor_uri("https://example.com/focus"));
        assert!(!is_editor_uri("file:///Applications/Calculator.app"));
        assert!(!is_editor_uri("cursor://mohtech.tomarigi/other?x=/focus"));
        assert!(!is_editor_uri("not a uri"));
    }

    #[test]
    fn window_files_are_read_and_broken_ones_skipped() {
        let dir = std::env::temp_dir().join(format!("tomarigi-vscode-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("cursor-510.json"),
            r#"{"uri":"cursor://mohtech.tomarigi/focus?windowId=1","extensionHostPid":510,"terminalPids":[530]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("cursor-511.json"), "{not json").unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        let windows = read_windows(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].terminal_pids, vec![530]);
        assert!(read_windows(&dir).is_empty());
    }
}
