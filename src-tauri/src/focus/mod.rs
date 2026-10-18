// Jumping to the terminal pane where an agent runs (docs/design.md "Jumping to the terminal pane").
// pid → tty and the chain of ancestor processes from `ps` → tmux (switches the pane, then continues with the client's
// tty) → the terminal app that owns an ancestor (by bundle id) → that terminal's adapter focuses the pane whose tty
// matches. Only the adapter of the owning app is called. Each adapter is one file in this folder. A terminal inside a
// VS Code window is found through Tomarigi's extension before the owning app is looked up (vscode.rs)
// Windows (win32.rs) and Linux (x11.rs) have their own focus_pid_sync (docs/design.md "Platforms")
mod ghostty;
mod iterm2;
mod kitty;
mod sb;
mod terminal_app;
mod tmux;
mod vscode;
mod wezterm;
#[cfg(windows)]
mod win32;
#[cfg(target_os = "linux")]
mod x11;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::liveness::live_codex_threads;
use crate::{append_log, expand};

/// How far a jump got. Pane: the pane itself was focused. App: only the app was brought to the front (asked for with
/// fallback_to_app). None: nothing was done
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FocusLevel {
    Pane,
    App,
    None,
}

#[derive(Serialize, Debug)]
pub(crate) struct FocusResult {
    pub(crate) level: FocusLevel,
    /// For the log only
    pub(crate) detail: String,
}

impl FocusResult {
    fn none(detail: impl Into<String>) -> Self {
        FocusResult { level: FocusLevel::None, detail: detail.into() }
    }
}

/// One row of `ps -axo pid=,ppid=,tty=,comm=`. tty is "ttys003" or "??"; comm is the executable path (may contain spaces)
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Proc {
    pub(crate) pid: u32,
    pub(crate) ppid: u32,
    pub(crate) tty: String,
    pub(crate) comm: String,
}

impl Proc {
    /// /dev/ttysNNN, or None when the process has no terminal
    pub(crate) fn tty_path(&self) -> Option<String> {
        (!self.tty.is_empty() && self.tty != "??" && self.tty != "?").then(|| format!("/dev/{}", self.tty))
    }

    pub(crate) fn name(&self) -> &str {
        let base = self.comm.rsplit('/').next().unwrap_or(&self.comm);
        // Login shells show as "-zsh"
        base.trim_start_matches('-')
    }
}

pub(crate) fn parse_ps(text: &str) -> HashMap<u32, Proc> {
    let mut procs = HashMap::new();
    for line in text.lines() {
        let mut rest = line.trim_start();
        let mut field = || {
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let (head, tail) = rest.split_at(end);
            rest = tail.trim_start();
            head.to_string()
        };
        let (Ok(pid), Ok(ppid)) = (field().parse::<u32>(), field().parse::<u32>()) else { continue };
        let tty = field();
        procs.insert(pid, Proc { pid, ppid, tty, comm: rest.trim_end().to_string() });
    }
    procs
}

/// pid itself, then its parent, and so on up to (not including) launchd. Stops on a loop or a missing parent
pub(crate) fn ancestors(procs: &HashMap<u32, Proc>, pid: u32) -> Vec<Proc> {
    let mut chain: Vec<Proc> = Vec::new();
    let mut cur = pid;
    while cur > 1 {
        let Some(p) = procs.get(&cur) else { break };
        if chain.iter().any(|c| c.pid == cur) {
            break;
        }
        chain.push(p.clone());
        cur = p.ppid;
    }
    chain
}

/// Terminals with an adapter. Anything else is only brought to the front
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Terminal {
    Ghostty,
    ITerm2,
    TerminalApp,
    WezTerm,
    Kitty,
    Other,
}

impl Terminal {
    pub(crate) fn of_bundle(bundle_id: &str) -> Terminal {
        match bundle_id {
            "com.mitchellh.ghostty" => Terminal::Ghostty,
            ITERM2_BUNDLE_ID => Terminal::ITerm2,
            "com.apple.Terminal" => Terminal::TerminalApp,
            "com.github.wez.wezterm" => Terminal::WezTerm,
            "net.kovidgoyal.kitty" => Terminal::Kitty,
            _ => Terminal::Other,
        }
    }
}

/// The app process that owns the chain: the nearest ancestor that is a running app with a bundle id.
/// iTerm2 can run its shells under an iTermServer process whose parent is launchd, so that name counts as iTerm2
/// (iterm2_pid gives the running iTerm2)
pub(crate) fn owner_app(
    chain: &[Proc],
    bundle_of: impl Fn(u32) -> Option<String>,
    iterm2_pid: impl Fn() -> Option<u32>,
) -> Option<(u32, String)> {
    for p in chain {
        if let Some(bundle) = bundle_of(p.pid) {
            return Some((p.pid, bundle));
        }
        if p.name().starts_with("iTermServer") {
            return iterm2_pid().map(|pid| (pid, ITERM2_BUNDLE_ID.to_string()));
        }
    }
    None
}

const ITERM2_BUNDLE_ID: &str = "com.googlecode.iterm2";

/// What an adapter gets: the tty to find, the chain from the agent (or the tmux client) up to the app, and the app's pid
pub(crate) struct Target<'a> {
    pub(crate) tty: &'a str,
    pub(crate) chain: &'a [Proc],
    pub(crate) app_pid: u32,
}

fn ps_snapshot() -> Option<HashMap<u32, Proc>> {
    let out = Command::new("ps").args(["-axo", "pid=,ppid=,tty=,comm="]).output().ok()?;
    out.status.success().then(|| parse_ps(&String::from_utf8_lossy(&out.stdout)))
}

/// Focuses the terminal pane where pid runs. With fallback_to_app, when no pane is found the owning app is still
/// brought to the front
#[cfg_attr(not(target_os = "macos"), allow(unreachable_code))]
pub(crate) fn focus_pid_sync(pid: u32, fallback_to_app: bool) -> FocusResult {
    #[cfg(windows)]
    return win32::focus_pid_sync(pid, fallback_to_app);
    #[cfg(target_os = "linux")]
    return x11::focus_pid_sync(pid, fallback_to_app);
    let Some(procs) = ps_snapshot() else { return FocusResult::none(format!("pid={pid} ps failed")) };
    let mut chain = ancestors(&procs, pid);
    let Some(mut tty) = chain.first().and_then(Proc::tty_path) else {
        return FocusResult::none(format!("pid={pid} no tty"));
    };
    let mut detail = format!("pid={pid} tty={tty}");
    // tmux: select the pane, then go on with the client's tty and chain so the outer terminal is focused
    if let Some(server) = chain.iter().find(|p| p.name() == "tmux") {
        match tmux::switch_to(server, &tty) {
            Ok(client) => {
                detail.push_str(&format!(" tmux={} client={}", client.pane_id, client.tty));
                chain = ancestors(&procs, client.pid);
                tty = client.tty;
            }
            Err(e) => detail.push_str(&format!(" tmux: {e}")),
        }
    }
    // VS Code and its forks: found by the terminal pids the extension wrote, whichever app the editor is
    match vscode::focus(&chain, &procs) {
        Ok(d) => return FocusResult { level: FocusLevel::Pane, detail: format!("{detail} {d}") },
        Err(e) => detail.push_str(&format!(" {e}")),
    }
    let iterm2_pid = || sb::pids_of_bundle(ITERM2_BUNDLE_ID).first().copied();
    let Some((app_pid, bundle)) = owner_app(&chain, sb::bundle_id_of, iterm2_pid) else {
        return FocusResult::none(format!("{detail} no terminal app"));
    };
    detail.push_str(&format!(" app={bundle}({app_pid})"));
    let target = Target { tty: &tty, chain: &chain, app_pid };
    let found = match Terminal::of_bundle(&bundle) {
        Terminal::Ghostty => ghostty::focus(&target),
        Terminal::ITerm2 => iterm2::focus(&target),
        Terminal::TerminalApp => terminal_app::focus(&target),
        Terminal::WezTerm => wezterm::focus(&target),
        Terminal::Kitty => kitty::focus(&target),
        Terminal::Other => Err("no adapter".to_string()),
    };
    match found {
        Ok(d) => FocusResult { level: FocusLevel::Pane, detail: format!("{detail} {d}") },
        Err(e) if fallback_to_app => {
            sb::activate(app_pid);
            FocusResult { level: FocusLevel::App, detail: format!("{detail} {e}; app activated") }
        }
        Err(e) => FocusResult::none(format!("{detail} {e}")),
    }
}

/// Focuses the pane whose tty this is, through a process running on it (for the focus self-test to jump back)
pub(crate) fn focus_tty_sync(tty: &str) -> FocusResult {
    let Some(procs) = ps_snapshot() else { return FocusResult::none("ps failed") };
    let name = tty.trim_start_matches("/dev/");
    match procs.values().filter(|p| p.tty == name).map(|p| p.pid).min() {
        Some(pid) => focus_pid_sync(pid, false),
        None => FocusResult::none(format!("no process on {tty}")),
    }
}

/// Moves to the terminal pane where pid runs (any agent). The jump commands of each agent end here
#[tauri::command]
pub(crate) async fn focus_pid(pid: u32, fallback_to_app: bool) -> FocusResult {
    let result = tauri::async_runtime::spawn_blocking(move || focus_pid_sync(pid, fallback_to_app))
        .await
        .unwrap_or_else(|e| FocusResult::none(format!("pid={pid} {e}")));
    append_log(&format!("[focus] pid {pid} -> {:?} {}", result.level, result.detail));
    result
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

/// Moves to the terminal pane where the Claude Code session is running
#[tauri::command]
pub(crate) async fn focus_session(config_dir: String, session_id: String, fallback_to_app: bool) -> FocusResult {
    match pid_of_session(&expand(&config_dir), &session_id) {
        None => {
            append_log(&format!("[focus] {config_dir} {session_id} -> no session file"));
            FocusResult::none("no session file")
        }
        Some(pid) => {
            append_log(&format!("[focus] {config_dir} {session_id} -> pid {pid}"));
            focus_pid(pid, fallback_to_app).await
        }
    }
}

/// Moves to the terminal pane where the codex that has the thread open is running. Does nothing if no process
/// has the thread's lock open
#[tauri::command]
pub(crate) async fn focus_codex(codex_dir: String, thread_id: String, fallback_to_app: bool) -> FocusResult {
    let scan = live_codex_threads(codex_dir.clone()).await;
    match scan.threads.iter().find(|t| t.thread_id == thread_id) {
        None => {
            append_log(&format!("[focus] {codex_dir} {thread_id} -> no process has the thread lock open"));
            FocusResult::none("no process has the thread lock open")
        }
        Some(t) => {
            append_log(&format!("[focus] {codex_dir} {thread_id} -> pid {}", t.pid));
            focus_pid(t.pid, fallback_to_app).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "    1     0 ??       /sbin/launchd
 4237     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty
 4240  4237 ttys000  /usr/bin/login
 4241  4240 ttys000  -/bin/zsh
 4373  4241 ttys000  claude
  900     1 ??       /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  901   900 ??       /Users/me/.local/bin/claude
";

    #[test]
    fn parse_ps_keeps_paths_with_spaces() {
        let procs = parse_ps(PS);
        assert_eq!(procs[&900].comm, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        assert_eq!(procs[&4241].name(), "zsh");
        assert_eq!(procs[&4373].tty_path().as_deref(), Some("/dev/ttys000"));
        assert_eq!(procs[&901].tty_path(), None);
    }

    #[test]
    fn ancestors_walk_up_to_the_app_and_stop_before_launchd() {
        let procs = parse_ps(PS);
        let pids: Vec<u32> = ancestors(&procs, 4373).iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![4373, 4241, 4240, 4237]);
        assert!(ancestors(&procs, 12345).is_empty());
    }

    #[test]
    fn ancestors_stop_on_a_loop() {
        let procs = parse_ps("10 11 ?? a\n11 10 ?? b\n");
        assert_eq!(ancestors(&procs, 10).len(), 2);
    }

    #[test]
    fn owner_app_is_the_nearest_ancestor_with_a_bundle_id() {
        let procs = parse_ps(PS);
        let chain = ancestors(&procs, 4373);
        let bundle_of = |pid: u32| (pid == 4237).then(|| "com.mitchellh.ghostty".to_string());
        assert_eq!(owner_app(&chain, bundle_of, || None), Some((4237, "com.mitchellh.ghostty".to_string())));
        assert_eq!(owner_app(&chain, |_| None, || None), None);
    }

    #[test]
    fn an_iterm_server_left_under_launchd_counts_as_iterm2() {
        let procs = parse_ps(
            "21655 1 ?? /Users/me/Library/Application Support/iTerm2/iTermServer-3.6.11\n\
             30223 21655 ttys022 /usr/bin/login\n30231 30223 ttys022 -zsh\n30526 30231 ttys022 claude\n",
        );
        let chain = ancestors(&procs, 30526);
        assert_eq!(owner_app(&chain, |_| None, || Some(93181)), Some((93181, "com.googlecode.iterm2".to_string())));
        assert_eq!(owner_app(&chain, |_| None, || None), None);
    }

    #[test]
    fn terminals_are_told_apart_by_bundle_id() {
        assert_eq!(Terminal::of_bundle("com.mitchellh.ghostty"), Terminal::Ghostty);
        assert_eq!(Terminal::of_bundle("com.googlecode.iterm2"), Terminal::ITerm2);
        assert_eq!(Terminal::of_bundle("com.apple.Terminal"), Terminal::TerminalApp);
        assert_eq!(Terminal::of_bundle("com.github.wez.wezterm"), Terminal::WezTerm);
        assert_eq!(Terminal::of_bundle("net.kovidgoyal.kitty"), Terminal::Kitty);
        assert_eq!(Terminal::of_bundle("dev.warp.Warp-Stable"), Terminal::Other);
    }

    #[test]
    fn focus_result_serializes_for_the_webview() {
        let r = FocusResult { level: FocusLevel::Pane, detail: "x".into() };
        assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"level":"pane","detail":"x"}"#);
    }
}
