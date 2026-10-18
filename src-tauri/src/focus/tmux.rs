// tmux: when the tty is a tmux pane, the pane is selected with `switch-client -c <client tty> -t <pane id>` on the
// client attached to that session that was used last (`client_activity`), and the jump continues with that
// client's tty. Sockets other than the default come from the command line of the tmux server, which tmux forks from
// the client that started it without exec, so it keeps that client's arguments
use std::process::Command;

use super::Proc;

pub(super) struct Client {
    pub(super) tty: String,
    pub(super) pid: u32,
    pub(super) pane_id: String,
}

/// `-L name` / `-S path` (also written `-Lname`) from a tmux command line, to reach the same server
pub(super) fn socket_args(command_line: &str) -> Vec<String> {
    let words: Vec<&str> = command_line.split_whitespace().collect();
    let mut out = Vec::new();
    let mut i = 1;
    while i < words.len() {
        let w = words[i];
        // Options end at the tmux command (new, attach, ...)
        if !w.starts_with('-') {
            break;
        }
        for flag in ["-L", "-S"] {
            if w == flag {
                if let Some(v) = words.get(i + 1) {
                    out.extend([flag.to_string(), v.to_string()]);
                    i += 1;
                }
            } else if let Some(v) = w.strip_prefix(flag) {
                out.extend([flag.to_string(), v.to_string()]);
            }
        }
        i += 1;
    }
    out
}

/// From `list-panes -a -F '#{pane_tty} #{pane_id} #{session_name}'`: the pane id and session of tty
pub(super) fn pane_of(list_panes: &str, tty: &str) -> Option<(String, String)> {
    list_panes.lines().find_map(|line| {
        let mut f = line.splitn(3, ' ');
        (f.next()? == tty).then(|| Some((f.next()?.to_string(), f.next()?.to_string())))?
    })
}

/// From `list-clients -F '#{client_tty} #{client_pid} #{client_activity} #{client_session}'`: the client attached to
/// session that was used last
pub(super) fn pick_client(list_clients: &str, session: &str) -> Option<(String, u32)> {
    list_clients
        .lines()
        .filter_map(|line| {
            let mut f = line.splitn(4, ' ');
            let (tty, pid, activity, s) = (f.next()?, f.next()?.parse::<u32>().ok()?, f.next()?.parse::<u64>().ok()?, f.next()?);
            (s == session).then(|| (activity, tty.to_string(), pid))
        })
        .max_by_key(|(activity, _, _)| *activity)
        .map(|(_, tty, pid)| (tty, pid))
}

/// The tmux binary: the server's own path when ps shows one, else the usual install places (a GUI app has no
/// shell PATH)
fn binary(server: &Proc) -> String {
    if server.comm.starts_with('/') {
        return server.comm.clone();
    }
    ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or("tmux")
        .to_string()
}

fn run(bin: &str, socket: &[String], args: &[&str]) -> Result<String, String> {
    let out = Command::new(bin).args(socket).args(args).output().map_err(|e| format!("{bin}: {e}"))?;
    if !out.status.success() {
        return Err(format!("{} failed: {}", args[0], String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Selects the pane with tty in the tmux server that is an ancestor, and returns the client now showing it
pub(super) fn switch_to(server: &Proc, tty: &str) -> Result<Client, String> {
    let bin = binary(server);
    let command_line = Command::new("ps")
        .args(["-o", "args=", "-p", &server.pid.to_string()])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let socket = socket_args(command_line.trim());
    let panes = run(&bin, &socket, &["list-panes", "-a", "-F", "#{pane_tty} #{pane_id} #{session_name}"])?;
    let (pane_id, session) = pane_of(&panes, tty).ok_or("tty is not a tmux pane")?;
    let clients = run(&bin, &socket, &["list-clients", "-F", "#{client_tty} #{client_pid} #{client_activity} #{client_session}"])?;
    let (client_tty, pid) = pick_client(&clients, &session).ok_or_else(|| format!("no client on session {session}"))?;
    run(&bin, &socket, &["switch-client", "-c", &client_tty, "-t", &pane_id])?;
    Ok(Client { tty: client_tty, pid, pane_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_args_come_from_the_server_command_line() {
        assert!(socket_args("tmux new -s work").is_empty());
        assert_eq!(socket_args("tmux -L other new"), vec!["-L", "other"]);
        assert_eq!(socket_args("/opt/homebrew/bin/tmux -S /tmp/s attach"), vec!["-S", "/tmp/s"]);
        assert_eq!(socket_args("tmux -Lother"), vec!["-L", "other"]);
        // Flags after the tmux command belong to the command, not the server
        assert!(socket_args("tmux new -s x -L y").is_empty());
    }

    #[test]
    fn pane_of_finds_the_pane_with_the_tty() {
        let out = "/dev/ttys004 %0 main\n/dev/ttys005 %3 my work\n";
        assert_eq!(pane_of(out, "/dev/ttys005"), Some(("%3".into(), "my work".into())));
        assert_eq!(pane_of(out, "/dev/ttys009"), None);
    }

    #[test]
    fn pick_client_takes_the_client_used_last_on_that_session() {
        let out = "/dev/ttys001 100 1700000000 main\n/dev/ttys002 200 1700000500 main\n/dev/ttys003 300 1700000900 other\n";
        assert_eq!(pick_client(out, "main"), Some(("/dev/ttys002".into(), 200)));
        assert_eq!(pick_client(out, "none"), None);
    }
}
