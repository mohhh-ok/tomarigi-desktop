// kitty: only when the user has set `allow_remote_control` and `listen_on` in kitty.conf; then
// `kitten @ --to <socket> focus-window --match pid:<pid>` with the shell pid among the ancestors (kitty matches
// `pid:` against the process it started in the window). The socket is the unix socket the kitty process listens
// on. Tomarigi never edits kitty.conf; without the setting there is no socket and the app is only activated
use std::process::Command;

use super::{sb, Proc, Target};

/// The process kitty started in the window: the ancestor whose parent is the kitty app
pub(super) fn window_pid(chain: &[Proc], app_pid: u32) -> Option<u32> {
    chain.iter().find(|p| p.ppid == app_pid).map(|p| p.pid)
}

/// Unix socket paths from `lsof -a -U -p <pid> -Fn` (connected sockets show as `->0x...` and are skipped)
pub(super) fn socket_paths(lsof: &str) -> Vec<String> {
    lsof.lines().filter_map(|l| l.strip_prefix('n')).filter(|n| n.starts_with('/')).map(str::to_string).collect()
}

pub(super) fn focus(target: &Target) -> Result<String, String> {
    let app = target.chain.iter().find(|p| p.pid == target.app_pid).ok_or("no app process")?;
    let shell = window_pid(target.chain, target.app_pid).ok_or("no window process")?;
    let out = Command::new("lsof")
        .args(["-a", "-U", "-p", &target.app_pid.to_string(), "-Fn"])
        .output()
        .map_err(|e| format!("lsof: {e}"))?;
    let sockets = socket_paths(&String::from_utf8_lossy(&out.stdout));
    if sockets.is_empty() {
        return Err("kitty has no remote control socket (allow_remote_control / listen_on not set)".to_string());
    }
    let kitten = match app.comm.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/kitten"),
        None => "/Applications/kitty.app/Contents/MacOS/kitten".to_string(),
    };
    let mut last = String::new();
    for socket in &sockets {
        let out = Command::new(&kitten)
            .args(["@", "--to", &format!("unix:{socket}"), "focus-window", "--match", &format!("pid:{shell}")])
            .output()
            .map_err(|e| format!("{kitten}: {e}"))?;
        if out.status.success() {
            sb::activate(target.app_pid);
            return Ok(format!("kitty socket={socket} pid={shell}"));
        }
        last = String::from_utf8_lossy(&out.stderr).trim().to_string();
    }
    Err(format!("kitten focus-window failed: {last}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::focus::parse_ps;

    #[test]
    fn the_window_process_is_the_child_of_kitty() {
        let procs = parse_ps("50 1 ?? /Applications/kitty.app/Contents/MacOS/kitty\n51 50 ttys001 -zsh\n52 51 ttys001 claude\n");
        let chain = crate::focus::ancestors(&procs, 52);
        assert_eq!(window_pid(&chain, 50), Some(51));
        assert_eq!(window_pid(&chain, 99), None);
    }

    #[test]
    fn socket_paths_skip_connected_sockets() {
        let lsof = "p50\nf12\nn/tmp/mykitty-50\nf13\nn->0x1234abcd\n";
        assert_eq!(socket_paths(lsof), vec!["/tmp/mykitty-50"]);
    }
}
