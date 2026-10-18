// WezTerm: `wezterm cli list --format json` gives `tty_name` → `pane_id`, then `wezterm cli activate-pane --pane-id
// <id>`, and the app is activated. The binary is taken from the app bundle (next to the wezterm-gui executable)
use serde::Deserialize;
use std::process::Command;

use super::{sb, Target};

#[derive(Deserialize)]
struct Pane {
    pane_id: u64,
    tty_name: Option<String>,
}

pub(super) fn pane_of(list_json: &str, tty: &str) -> Option<u64> {
    let panes: Vec<Pane> = serde_json::from_str(list_json).ok()?;
    panes.into_iter().find(|p| p.tty_name.as_deref() == Some(tty)).map(|p| p.pane_id)
}

/// `<bundle>/Contents/MacOS/wezterm` from the app process's executable path
pub(super) fn cli_path(app_comm: &str) -> String {
    match app_comm.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/wezterm"),
        None => "/Applications/WezTerm.app/Contents/MacOS/wezterm".to_string(),
    }
}

pub(super) fn focus(target: &Target) -> Result<String, String> {
    let app = target.chain.iter().find(|p| p.pid == target.app_pid).ok_or("no app process")?;
    let bin = cli_path(&app.comm);
    let out = Command::new(&bin).args(["cli", "list", "--format", "json"]).output().map_err(|e| format!("{bin}: {e}"))?;
    if !out.status.success() {
        return Err(format!("wezterm cli list failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let pane = pane_of(&String::from_utf8_lossy(&out.stdout), target.tty).ok_or("NOT FOUND in wezterm")?;
    let out = Command::new(&bin)
        .args(["cli", "activate-pane", "--pane-id", &pane.to_string()])
        .output()
        .map_err(|e| format!("{bin}: {e}"))?;
    if !out.status.success() {
        return Err(format!("wezterm activate-pane failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    sb::activate(target.app_pid);
    Ok(format!("wezterm pane={pane}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_of_matches_tty_name() {
        let json = r#"[{"window_id":0,"tab_id":0,"pane_id":0,"tty_name":"/dev/ttys001"},
                       {"window_id":0,"tab_id":1,"pane_id":4,"tty_name":"/dev/ttys007"},
                       {"window_id":1,"tab_id":2,"pane_id":5}]"#;
        assert_eq!(pane_of(json, "/dev/ttys007"), Some(4));
        assert_eq!(pane_of(json, "/dev/ttys009"), None);
        assert_eq!(pane_of("not json", "/dev/ttys001"), None);
    }

    #[test]
    fn cli_sits_next_to_the_gui_executable() {
        assert_eq!(
            cli_path("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"),
            "/Applications/WezTerm.app/Contents/MacOS/wezterm"
        );
    }
}
