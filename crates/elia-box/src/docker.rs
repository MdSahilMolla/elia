//! Linux backend, via Docker: a hardened container on the run directory. This is the
//! backend with kernel-enforced memory, process and CPU budgets, a read-only root
//! filesystem, no capabilities, and a private network namespace.

use crate::policy::{protected_paths, NetMode, Policy};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const WORKDIR: &str = "/workspace";

pub fn find_docker() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ELIA_BOX_DOCKER") {
        return Some(PathBuf::from(p));
    }
    let candidates = [
        PathBuf::from("/usr/local/bin/docker"),
        PathBuf::from("/opt/homebrew/bin/docker"),
        PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
        PathBuf::from("/usr/bin/docker"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("docker");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    candidates.into_iter().find(|c| c.is_file())
}

pub struct Probe {
    pub available: bool,
    pub reason: Option<String>,
    pub server: Option<String>,
}

/// Whether a docker daemon answers, and what it is.
pub fn probe() -> Probe {
    let Some(docker) = find_docker() else {
        return Probe {
            available: false,
            reason: Some("docker is not installed".into()),
            server: None,
        };
    };
    match Command::new(&docker)
        .args([
            "version",
            "--format",
            "{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}",
        ])
        .output()
    {
        Ok(o) if o.status.success() => Probe {
            available: true,
            reason: None,
            server: Some(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        },
        Ok(o) => Probe {
            available: false,
            reason: Some(
                String::from_utf8_lossy(&o.stderr)
                    .lines()
                    .next()
                    .unwrap_or("docker daemon not reachable")
                    .to_string(),
            ),
            server: None,
        },
        Err(e) => Probe {
            available: false,
            reason: Some(e.to_string()),
            server: None,
        },
    }
}

pub fn image_present(docker: &Path, image: &str) -> bool {
    Command::new(docker)
        .args(["image", "inspect", "--format", "{{.Id}}", image])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `docker run` for one command. `env_file` carries the environment so values never
/// appear in the process list. The container is named so it can be killed and inspected.
pub fn command(
    docker: &Path,
    policy: &Policy,
    name: &str,
    run_dir: &Path,
    env_file: &Path,
    argv: &[String],
) -> Result<Command> {
    if policy.network.mode == NetMode::Brokered {
        bail!("brokered egress is enforced only by the seatbelt backend; use network.mode \"none\" or \"open\" with docker");
    }
    let l = &policy.limits;
    let mut c = Command::new(docker);
    c.args(["run", "--name", name, "--pull", "never", "--init"]);
    c.args([
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
    ]);
    c.arg("--tmpfs").arg("/tmp:rw,nosuid,nodev,size=512m");
    c.arg("--memory").arg(format!("{}m", l.memory_mb));
    c.arg("--memory-swap").arg(format!("{}m", l.memory_mb));
    c.arg("--pids-limit").arg(l.pids.to_string());
    c.arg("--ulimit").arg(format!(
        "fsize={0}:{0}",
        l.file_size_mb.saturating_mul(1024 * 1024)
    ));
    c.arg("--ulimit")
        .arg(format!("nofile={0}:{0}", l.open_files));
    c.arg("--ulimit").arg("core=0:0");
    if let Some(cpu) = l.cpu_seconds {
        c.arg("--ulimit").arg(format!("cpu={cpu}:{cpu}"));
    }
    match policy.network.mode {
        NetMode::None => {
            c.args(["--network", "none"]);
        }
        NetMode::Open => {}
        NetMode::Brokered => unreachable!(),
    }
    #[cfg(unix)]
    {
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        c.arg("--user").arg(format!("{uid}:{gid}"));
    }
    c.arg("--env-file").arg(env_file);
    c.arg("-v")
        .arg(format!("{}:{WORKDIR}:rw", run_dir.display()));
    // Control files inside the writable tree are re-mounted read-only over it. Only paths
    // that exist are mounted, since docker would otherwise create them on the host.
    for p in protected_paths(run_dir) {
        if let Ok(rel) = p.strip_prefix(run_dir) {
            if p.exists() {
                c.arg("-v")
                    .arg(format!("{}:{WORKDIR}/{}:ro", p.display(), rel.display()));
            }
        }
    }
    for p in &policy.read_paths {
        c.arg("-v").arg(format!("{0}:{0}:ro", p.display()));
    }
    for p in &policy.write_paths {
        c.arg("-v").arg(format!("{0}:{0}:rw", p.display()));
    }
    c.args(["-w", WORKDIR]);
    c.arg(policy.image());
    c.args(argv);
    Ok(c)
}

pub struct Inspect {
    pub oom_killed: bool,
}

pub fn inspect(docker: &Path, name: &str) -> Option<Inspect> {
    let out = Command::new(docker).args(["inspect", name]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let st = v.get(0)?.get("State")?;
    Some(Inspect {
        oom_killed: st
            .get("OOMKilled")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
    })
}

pub fn kill(docker: &Path, name: &str) {
    let _ = Command::new(docker).args(["kill", name]).output();
}

pub fn remove(docker: &Path, name: &str) {
    let _ = Command::new(docker).args(["rm", "-f", name]).output();
}

pub const DOCKERFILE: &str = "FROM alpine:3.20\n\
RUN apk add --no-cache bash coreutils findutils grep sed gawk git python3 ca-certificates curl\n\
RUN adduser -D -u 1000 sandbox\n\
ENV HOME=/tmp LANG=C.UTF-8\n\
WORKDIR /workspace\n";
