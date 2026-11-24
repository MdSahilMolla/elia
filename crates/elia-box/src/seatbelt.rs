//! macOS backend: Apple's Seatbelt (`sandbox-exec`) with a generated, deny-by-default
//! profile. It confines the *files*, *network* and *IPC* a command can touch.
//!
//! What it cannot do, and the receipt says so: bound memory or process counts (the
//! supervisor watches the tree for that), or hide that a path exists (metadata
//! reads stay allowed because path resolution needs them; contents do not).

use crate::policy::{protected_paths, NetMode, Policy};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Read-only system locations every ordinary toolchain needs.
const SYSTEM_READ: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/private/etc",
    "/private/var/db",
    "/private/var/select",
    "/dev",
];

const MACH_SERVICES: &[&str] = &[
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.system.logger",
    "com.apple.logd",
    "com.apple.diagnosticd",
    "com.apple.system.notification_center",
    "com.apple.cfprefsd.daemon",
];

pub fn available() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Seatbelt exists only on macOS".into());
    }
    if !Path::new(SANDBOX_EXEC).exists() {
        return Err(format!("{SANDBOX_EXEC} is missing"));
    }
    Ok(())
}

fn q(path: &Path) -> Result<String> {
    let s = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("non-UTF-8 path in policy"))?;
    if s.chars().any(|c| c.is_control()) {
        bail!("control character in path");
    }
    Ok(format!(
        "\"{}\"",
        s.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

fn subpath(paths: impl IntoIterator<Item = PathBuf>) -> Result<String> {
    let mut out = String::new();
    for p in paths {
        out.push_str(&format!(" (subpath {})", q(&p)?));
    }
    Ok(out)
}

/// `run_dir` is the tree the command works in (the workspace, or its fork);
/// `scratch` is the run's private writable area (HOME and TMPDIR live there).
pub fn profile(
    policy: &Policy,
    run_dir: &Path,
    scratch: &Path,
    proxy_port: Option<u16>,
) -> Result<String> {
    let mut reads: Vec<PathBuf> = SYSTEM_READ
        .iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    reads.push("/usr/local".into());
    reads.extend(policy.read_paths.iter().cloned());
    reads.extend(policy.write_paths.iter().cloned());
    reads.push(run_dir.to_path_buf());
    reads.push(scratch.to_path_buf());
    reads.retain(|p| p.exists());

    let mut writes: Vec<PathBuf> = vec![run_dir.to_path_buf(), scratch.to_path_buf()];
    writes.extend(policy.write_paths.iter().cloned());

    let mut p = String::new();
    p.push_str("(version 1)\n(deny default)\n");
    p.push_str("(allow process-exec*)\n(allow process-fork)\n");
    p.push_str(
        "(allow signal (target same-sandbox))\n(allow process-info* (target same-sandbox))\n",
    );
    p.push_str("(allow sysctl-read)\n");
    // stat() of every ancestor is needed to resolve any path; contents stay denied.
    p.push_str("(allow file-read-metadata)\n");
    // The root directory entry itself: getcwd and realpath list it. Its children stay denied.
    p.push_str("(allow file-read* (literal \"/\"))\n");
    p.push_str(&format!("(allow file-read*{})\n", subpath(reads)?));
    p.push_str(&format!("(allow file-write*{})\n", subpath(writes)?));
    // Later rules win: control files inside the writable tree stay read-only.
    p.push_str(&format!(
        "(deny file-write*{})\n",
        subpath(protected_paths(run_dir))?
    ));
    p.push_str("(allow file-write* (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n");
    p.push_str("(allow mach-lookup");
    for s in MACH_SERVICES {
        p.push_str(&format!(" (global-name \"{s}\")"));
    }
    p.push_str(")\n");
    match policy.network.mode {
        NetMode::None => {}
        NetMode::Brokered => {
            let port = proxy_port.ok_or_else(|| {
                anyhow::anyhow!("brokered network needs the egress broker's port")
            })?;
            p.push_str(&format!(
                "(allow network-outbound (remote ip \"localhost:{port}\"))\n"
            ));
        }
        NetMode::Open => p.push_str("(allow network*)\n"),
    }
    Ok(p)
}

pub fn command(profile_path: &Path, argv: &[String]) -> Command {
    let mut c = Command::new(SANDBOX_EXEC);
    c.arg("-f").arg(profile_path).args(argv);
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(net: &str) -> Policy {
        let ws = std::env::temp_dir().canonicalize().unwrap();
        Policy::parse(&format!(
            r#"{{"workspace":"{}","network":{}}}"#,
            ws.display(),
            net
        ))
        .unwrap()
        .resolve()
        .unwrap()
    }

    #[test]
    fn profile_denies_by_default_and_scopes_network() {
        let ws = std::env::temp_dir().canonicalize().unwrap();
        let none = profile(&policy(r#"{"mode":"none"}"#), &ws, &ws, None).unwrap();
        assert!(none.starts_with("(version 1)\n(deny default)"));
        assert!(
            !none.contains("network"),
            "no network rule at all when the mode is none"
        );

        let brokered = profile(
            &policy(r#"{"mode":"brokered","allow":["a.com"]}"#),
            &ws,
            &ws,
            Some(4321),
        )
        .unwrap();
        assert!(brokered.contains(r#"(remote ip "localhost:4321")"#));
        assert!(!brokered.contains("(allow network*)"));
        assert!(profile(
            &policy(r#"{"mode":"brokered","allow":["a.com"]}"#),
            &ws,
            &ws,
            None
        )
        .is_err());

        let open = profile(&policy(r#"{"mode":"open"}"#), &ws, &ws, None).unwrap();
        assert!(open.contains("(allow network*)"));
    }

    #[test]
    fn workspace_control_files_stay_read_only() {
        let ws = std::env::temp_dir().canonicalize().unwrap();
        let p = profile(&policy(r#"{"mode":"none"}"#), &ws, &ws, None).unwrap();
        let allow = p
            .find(&format!("(allow file-write* (subpath {})", q(&ws).unwrap()))
            .expect("workspace is writable");
        let deny = p
            .find("(deny file-write*")
            .expect("control files are denied");
        assert!(
            deny > allow,
            "the deny must come after the allow so it wins"
        );
        for tail in [".git/hooks", ".git/config", ".elia"] {
            assert!(
                p.contains(&q(&ws.join(tail)).unwrap()),
                "{tail} is protected"
            );
        }
    }

    #[test]
    fn hostile_paths_cannot_break_out_of_the_profile() {
        let ws = std::env::temp_dir().canonicalize().unwrap();
        let evil = ws.join("a\") (allow file-read* (subpath \"/\")) (\"");
        assert!(q(&evil).unwrap().contains("\\\""), "quotes are escaped");
        assert!(
            q(Path::new("/tmp/a\nb")).is_err(),
            "control characters are refused"
        );
    }
}
