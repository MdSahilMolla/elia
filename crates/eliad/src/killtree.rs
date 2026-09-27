//! Process-tree kill for spawned children.
//!
//! `start_kill()`/`kill_on_drop(true)` reach only the direct child. A persistent
//! shell that runs `bun run server`, or an MCP server launched behind `npx`,
//! keeps its descendants alive as orphans — reparented to the long-lived daemon —
//! when only the direct child is killed. These helpers give every spawned child
//! its own POSIX process group at spawn and kill the whole tree on abandon.

use std::process::Command;

/// Give `cmd`'s child its own process group (POSIX only), so a later
/// [`kill_tree`] can address the group by the child's pid. The child becomes a
/// group leader (pgid == pid) and every descendant inherits the group.
///
/// On Windows process control is pid-tree based (`taskkill /T` walks the parent
/// chain), which needs no spawn flag, so this is a no-op there.
#[cfg(unix)]
pub fn own_process_group(cmd: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// No-op twin so callers do not need to gate the call site by platform.
#[cfg(not(unix))]
pub fn own_process_group(_cmd: &mut std::process::Command) {}

/// Kill everything the process at `pid` leads and (on POSIX) any descendant
/// still attached to its tree. Best-effort: the caller keeps `start_kill()` as
/// the direct-child backstop, so a failure here is still covered.
pub fn kill_tree(pid: Option<u32>) -> std::io::Result<()> {
    let Some(pid) = pid else {
        return Ok(());
    };
    if pid == 0 {
        return Ok(());
    }
    #[cfg(unix)]
    {
        // Never allow a mis-derived group to name ourselves.
        if pid as u64 == std::process::id() as u64 {
            return Ok(());
        }
        // The leading `-` names the process group. `/bin/kill` is part of the
        // POSIX base; if it is somehow absent, the caller's `start_kill()`
        // backstop still kills the direct child.
        Command::new("/bin/kill")
            .arg("-KILL")
            .arg(format!("-{pid}"))
            .status()
            .map(|_| ())
    }
    #[cfg(windows)]
    {
        // `/T` walks the parent-pid tree, so the Windows spawn needs no group.
        Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .status()
            .map(|_| ())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_tree_ignores_zero_or_absent_pid() {
        assert!(kill_tree(None).is_ok());
        assert!(kill_tree(Some(0)).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn kill_tree_refuses_the_daemon_owns_pid() {
        assert!(
            kill_tree(Some(std::process::id())).is_ok(),
            "a self-pid guard must be a safety no-op, not an error"
        );
    }
}
