//! elia-box: the agent sandbox.
//!
//!   elia-box run --policy FILE|- [--receipt FILE] -- ARGV...
//!   elia-box probe
//!   elia-box verify RECEIPT.json
//!   elia-box fork SRC DST
//!   elia-box diff DIR_A DIR_B [--exclude NAME]...
//!   elia-box image build|status
//!
//! Every command prints one JSON document on stdout. `run` exits 0 whenever the box
//! ran the command (whatever the command's own exit status was; that is in the
//! receipt) and non-zero, with {"error":{kind,message}}, when it could not.

mod docker;
mod egress;
mod fsx;
mod policy;
mod receipt;
mod run;
mod seatbelt;

use anyhow::{anyhow, Result};
use policy::{Backend, Mode, NetMode, Policy};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug)]
enum Failure {
    Policy(String),
    Unavailable(String),
    Backend(String),
    Internal(String),
}

impl Failure {
    fn parts(&self) -> (&'static str, &str, i32) {
        match self {
            Failure::Policy(m) => ("policy", m, 2),
            Failure::Unavailable(m) => ("unavailable", m, 3),
            Failure::Backend(m) => ("backend", m, 4),
            Failure::Internal(m) => ("internal", m, 1),
        }
    }
}

fn internal(e: anyhow::Error) -> Failure {
    Failure::Internal(format!("{e:#}"))
}

fn choose_backend(p: &Policy) -> Result<Backend, Failure> {
    let sb = seatbelt::available();
    let dk = docker::probe();
    match p.backend {
        Backend::Seatbelt => sb.map(|_| Backend::Seatbelt).map_err(Failure::Unavailable),
        Backend::Docker => {
            if !dk.available {
                return Err(Failure::Unavailable(format!(
                    "docker: {}",
                    dk.reason.unwrap_or_default()
                )));
            }
            Ok(Backend::Docker)
        }
        Backend::Auto => {
            // Brokered egress is enforced only by seatbelt, so it decides for auto.
            if sb.is_ok() {
                Ok(Backend::Seatbelt)
            } else if dk.available && p.network.mode != NetMode::Brokered {
                Ok(Backend::Docker)
            } else {
                Err(Failure::Unavailable(format!(
                    "no sandbox backend is available (seatbelt: {}; docker: {})",
                    sb.err().unwrap_or_default(),
                    dk.reason
                        .unwrap_or_else(|| "brokered egress needs seatbelt".into())
                )))
            }
        }
    }
}

fn run_id() -> String {
    let mut seed = Vec::new();
    seed.extend_from_slice(
        &SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    seed.extend_from_slice(&std::process::id().to_le_bytes());
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let mut b = [0u8; 16];
        if f.read_exact(&mut b).is_ok() {
            seed.extend_from_slice(&b);
        }
    }
    fsx::sha256_hex(&seed)[..16].to_string()
}

fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    Ok(())
}

fn write_private(path: &Path, data: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(data.as_bytes())?;
    Ok(())
}

fn sandbox_env(
    p: &Policy,
    backend: Backend,
    run_id: &str,
    proxy: Option<&str>,
    scratch_home: &str,
    scratch_tmp: &str,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let path = match backend {
        Backend::Docker => "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        _ => "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    };
    env.insert("PATH".into(), path.into());
    env.insert("HOME".into(), scratch_home.into());
    env.insert("TMPDIR".into(), scratch_tmp.into());
    env.insert("LANG".into(), "C.UTF-8".into());
    env.insert("ELIA_BOX".into(), "1".into());
    env.insert("ELIA_BOX_RUN".into(), run_id.into());
    if let Some(url) = proxy {
        for k in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            env.insert(k.into(), url.into());
        }
    }
    for name in &p.env_passthrough {
        if let Ok(v) = std::env::var(name) {
            env.insert(name.clone(), v);
        }
    }
    for (k, v) in &p.env {
        env.insert(k.clone(), v.clone());
    }
    env
}

fn containment(p: &Policy, backend: Backend) -> Value {
    let net = match p.network.mode {
        NetMode::None => "network.none",
        NetMode::Brokered => "network.brokered-allowlist",
        NetMode::Open => "",
    };
    let mut enforced: Vec<&str> = vec![
        "environment.cleared",
        "process.own-session",
        "process.tree-kill",
        "process.stragglers-reaped",
        "limits.wall-clock",
        "output.capped",
    ];
    let mut not_enforced: Vec<&str> = vec![];
    if !net.is_empty() {
        enforced.push(net);
    } else {
        not_enforced.push("network.open: the host network is reachable");
    }
    match backend {
        Backend::Seatbelt => {
            enforced.extend([
                "filesystem.read-allowlist",
                "filesystem.write-allowlist",
                "limits.file-size",
                "limits.open-files",
                "limits.pids.rlimit",
                "limits.memory.watched",
                "limits.pids.watched",
            ]);
            if p.limits.cpu_seconds.is_some() {
                enforced.push("limits.cpu");
            }
            not_enforced.extend([
                "filesystem.path-existence: metadata of any path is visible, contents are not",
                "limits.memory.kernel: the tree is watched every 40ms, not capped by the kernel",
                "syscall-filter",
                "kernel-isolation: shares the host kernel and user",
            ]);
        }
        Backend::Docker => {
            enforced.extend([
                "filesystem.rootfs-read-only",
                "filesystem.mount-allowlist",
                "capabilities.dropped",
                "privilege.no-new-privileges",
                "limits.memory.kernel",
                "limits.pids.kernel",
                "limits.file-size",
                "limits.open-files",
            ]);
            if p.limits.cpu_seconds.is_some() {
                enforced.push("limits.cpu");
            }
            not_enforced.extend([
                "kernel-isolation: containers share the VM kernel, not a separate one",
                "resource-usage: cpu and memory peaks are not measured for containers",
            ]);
        }
        Backend::Auto => {}
    }
    json!({ "enforced": enforced, "notEnforced": not_enforced })
}

struct Cleanup {
    base: PathBuf,
    keep_ws: bool,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.keep_ws {
            for name in ["rw", "profile.sb", "env", "egress.jsonl"] {
                let p = self.base.join(name);
                if p.exists() {
                    let _ = fsx::remove_tree(&p);
                }
            }
        } else {
            let _ = fsx::remove_tree(&self.base);
        }
    }
}

fn execute(policy: Policy, argv: Vec<String>) -> Result<Value, Failure> {
    if argv.is_empty() {
        return Err(Failure::Policy("no command to run".into()));
    }
    let policy = policy
        .resolve()
        .map_err(|e| Failure::Policy(format!("{e:#}")))?;
    let backend = choose_backend(&policy)?;
    let id = run_id();
    let started_at = SystemTime::now();

    let base = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| Failure::Internal(e.to_string()))?
        .join(format!("elia-box-{id}"));
    private_dir(&base).map_err(internal)?;
    let mut cleanup = Cleanup {
        base: base.clone(),
        keep_ws: false,
    };
    let rw = base.join("rw");
    private_dir(&rw.join("home")).map_err(internal)?;
    private_dir(&rw.join("tmp")).map_err(internal)?;

    let (mut forked, mut cow, mut fork_path) = (false, false, None);
    let run_dir = if policy.mode == Mode::Fork {
        let dst = base.join("ws");
        cow = fsx::fork(&policy.workspace, &dst).map_err(internal)?;
        forked = true;
        fork_path = Some(dst.clone());
        dst
    } else {
        policy.workspace.clone()
    };
    cleanup.keep_ws = forked && policy.keep_fork;

    let before = if policy.wants_snapshot() {
        Some(fsx::snapshot(&run_dir, &policy.exclude).map_err(internal)?)
    } else {
        None
    };

    let broker = if policy.network.mode == NetMode::Brokered {
        if backend != Backend::Seatbelt {
            return Err(Failure::Policy(
                "brokered egress is enforced only by the seatbelt backend".into(),
            ));
        }
        Some(
            egress::Broker::start(&policy.network.allow, &base.join("egress.jsonl"))
                .map_err(|e| Failure::Unavailable(format!("{e:#}")))?,
        )
    } else {
        None
    };
    let proxy_url = broker.as_ref().map(|b| b.proxy_url());

    let (spec, docker_ctx) = match backend {
        Backend::Seatbelt => {
            let profile =
                seatbelt::profile(&policy, &run_dir, &rw, broker.as_ref().map(|b| b.port))
                    .map_err(|e| Failure::Policy(format!("{e:#}")))?;
            let profile_path = base.join("profile.sb");
            write_private(&profile_path, &profile).map_err(internal)?;
            let env = sandbox_env(
                &policy,
                backend,
                &id,
                proxy_url.as_deref(),
                rw.join("home").to_str().unwrap_or("/tmp"),
                rw.join("tmp").to_str().unwrap_or("/tmp"),
            );
            let mut cmd = seatbelt::command(&profile_path, &argv);
            cmd.current_dir(&run_dir).env_clear().envs(&env);
            (
                run::RunSpec {
                    cmd,
                    limits: policy.limits.clone(),
                    watch_tree: true,
                    apply_rlimits: true,
                    on_kill: None,
                    probe: Some(run::SandboxProbe {
                        allowed_write: rw.join("tmp").to_string_lossy().into_owned(),
                        denied_read: profile_path.to_string_lossy().into_owned(),
                    }),
                },
                None,
            )
        }
        Backend::Docker => {
            let dk = docker::find_docker()
                .ok_or_else(|| Failure::Unavailable("docker is not installed".into()))?;
            if !docker::image_present(&dk, policy.image()) {
                return Err(Failure::Unavailable(format!("docker image {} is not present; run `elia-box image build` (elia-box never pulls implicitly)", policy.image())));
            }
            let env = sandbox_env(&policy, backend, &id, None, "/tmp", "/tmp");
            let mut env_text = String::new();
            for (k, v) in &env {
                if v.contains('\n') || v.contains('\r') {
                    return Err(Failure::Policy(format!("environment variable {k} has a newline, which docker's env file cannot carry")));
                }
                env_text.push_str(&format!("{k}={v}\n"));
            }
            let env_file = base.join("env");
            write_private(&env_file, &env_text).map_err(internal)?;
            let name = format!("elia-box-{id}");
            let cmd = docker::command(&dk, &policy, &name, &run_dir, &env_file, &argv)
                .map_err(|e| Failure::Policy(format!("{e:#}")))?;
            let (dk2, name2) = (dk.clone(), name.clone());
            let on_kill: Box<dyn Fn() + Send + Sync> = Box::new(move || docker::kill(&dk2, &name2));
            (
                run::RunSpec {
                    cmd,
                    limits: policy.limits.clone(),
                    watch_tree: false,
                    apply_rlimits: false,
                    on_kill: Some(on_kill),
                    probe: None,
                },
                Some((dk, name)),
            )
        }
        Backend::Auto => unreachable!("resolved above"),
    };

    let outcome = run::run(spec).map_err(internal);
    let mut oom = false;
    if let Some((dk, name)) = &docker_ctx {
        if let Some(i) = docker::inspect(dk, name) {
            oom = i.oom_killed;
        }
        docker::remove(dk, name);
    }
    let broker_summary = broker.map(|b| b.finish());
    let outcome = outcome?;

    if docker_ctx.is_some() && outcome.exit_code == Some(125) {
        // 125 is docker's own failure to start the container, not the command's status.
        let msg = String::from_utf8_lossy(&outcome.stderr)
            .lines()
            .next()
            .unwrap_or("docker failed to start the container")
            .to_string();
        return Err(Failure::Backend(msg));
    }

    let snapshot = match (&before, policy.wants_snapshot()) {
        (Some(b), true) => {
            let after = fsx::snapshot(&run_dir, &policy.exclude).map_err(internal)?;
            let changes = fsx::diff(b, &after).map_err(internal)?;
            Some(json!({
                "before": fsx::sha256_hex(b.as_bytes()),
                "after": fsx::sha256_hex(after.as_bytes()),
                "changes": changes,
            }))
        }
        _ => None,
    };

    let ended_at = SystemTime::now();
    let policy_value =
        serde_json::to_value(&policy).map_err(|e| Failure::Internal(e.to_string()))?;
    let body = json!({
        "schema": receipt::SCHEMA,
        "id": id,
        "backend": match backend { Backend::Seatbelt => "seatbelt", Backend::Docker => "docker", Backend::Auto => "auto" },
        "argv": argv,
        "startedAt": receipt::rfc3339(started_at),
        "endedAt": receipt::rfc3339(ended_at),
        "policyHash": fsx::sha256_hex(receipt::canonical(&policy_value).as_bytes()),
        "exit": {
            "code": outcome.exit_code,
            "signal": outcome.signal,
            "timedOut": outcome.timed_out,
            "interrupted": outcome.interrupted,
            "limitHit": outcome.limit_hit.clone().or(oom.then(|| "memory".to_string())),
            "stragglersKilled": outcome.stragglers_killed,
        },
        "usage": {
            "wallMs": outcome.wall_ms,
            "cpuUserMs": if docker_ctx.is_some() { Value::Null } else { json!(outcome.cpu_user_ms) },
            "cpuSysMs": if docker_ctx.is_some() { Value::Null } else { json!(outcome.cpu_sys_ms) },
            "maxRssKb": if docker_ctx.is_some() { Value::Null } else { json!(outcome.max_rss_kb) },
            "peakTreeRssKb": outcome.peak_tree_rss_kb,
            "peakProcs": outcome.peak_procs,
        },
        "output": {
            "stdoutBytes": outcome.stdout_bytes,
            "stderrBytes": outcome.stderr_bytes,
            "stdoutSha256": fsx::sha256_hex(&outcome.stdout),
            "stderrSha256": fsx::sha256_hex(&outcome.stderr),
            "truncated": outcome.stdout_bytes > outcome.stdout.len() as u64 || outcome.stderr_bytes > outcome.stderr.len() as u64,
        },
        "workspace": {
            "path": policy.workspace,
            "mode": match policy.mode { Mode::Inplace => "inplace", Mode::Fork => "fork" },
            "forked": forked,
            "copyOnWrite": cow,
            "forkPath": if policy.keep_fork { fork_path.clone() } else { None },
            "snapshot": snapshot,
        },
        "network": {
            "mode": match policy.network.mode { NetMode::None => "none", NetMode::Brokered => "brokered", NetMode::Open => "open" },
            "allow": policy.network.allow,
            "broker": broker_summary,
        },
        "containment": containment(&policy, backend),
    });
    let key = std::env::var("ELIA_BOX_RECEIPT_KEY")
        .ok()
        .filter(|k| !k.is_empty());
    let sealed = receipt::seal(body, key.as_deref().map(str::as_bytes));
    drop(cleanup);
    Ok(json!({
        "stdout": String::from_utf8_lossy(&outcome.stdout),
        "stderr": String::from_utf8_lossy(&outcome.stderr),
        "receipt": sealed,
    }))
}

fn probe() -> Value {
    let sb = seatbelt::available();
    let dk = docker::probe();
    let image_ok = docker::find_docker()
        .map(|d| dk.available && docker::image_present(&d, policy::DEFAULT_IMAGE))
        .unwrap_or(false);
    let egress = egress::find_binary();
    json!({
        "platform": std::env::consts::OS,
        "seatbelt": { "available": sb.is_ok(), "reason": sb.err() },
        "docker": { "available": dk.available, "reason": dk.reason, "server": dk.server, "imagePresent": image_ok, "image": policy::DEFAULT_IMAGE },
        "egress": { "available": egress.is_some(), "path": egress },
        "receiptKey": std::env::var("ELIA_BOX_RECEIPT_KEY").map(|k| !k.is_empty()).unwrap_or(false),
    })
}

fn print(v: &Value) {
    println!("{}", serde_json::to_string(v).unwrap_or_default());
}

fn fail(f: Failure) -> ! {
    let (kind, msg, code) = f.parts();
    print(&json!({ "error": { "kind": kind, "message": msg } }));
    std::process::exit(code);
}

fn read_policy(arg: &str) -> Result<String> {
    if arg == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        Ok(s)
    } else {
        std::fs::read_to_string(arg).map_err(|e| anyhow!("cannot read policy {arg}: {e}"))
    }
}

fn cmd_run(args: &[String]) -> Result<Value, Failure> {
    let split = args.iter().position(|a| a == "--").ok_or_else(|| {
        Failure::Policy("usage: elia-box run --policy FILE|- [--receipt FILE] -- ARGV...".into())
    })?;
    let (flags, argv) = (&args[..split], args[split + 1..].to_vec());
    let (mut policy_arg, mut receipt_path) = (None, None);
    let mut i = 0;
    while i < flags.len() {
        match flags[i].as_str() {
            "--policy" => {
                policy_arg = flags.get(i + 1).cloned();
                i += 2;
            }
            "--receipt" => {
                receipt_path = flags.get(i + 1).cloned();
                i += 2;
            }
            other => return Err(Failure::Policy(format!("unknown flag {other}"))),
        }
    }
    let policy_arg = policy_arg.ok_or_else(|| Failure::Policy("--policy is required".into()))?;
    let text = read_policy(&policy_arg).map_err(|e| Failure::Policy(format!("{e:#}")))?;
    let policy = Policy::parse(&text).map_err(|e| Failure::Policy(format!("{e:#}")))?;
    let result = execute(policy, argv)?;
    if let Some(path) = receipt_path {
        let text = serde_json::to_string_pretty(&result["receipt"]).unwrap_or_default();
        std::fs::write(&path, text)
            .map_err(|e| Failure::Internal(format!("cannot write receipt {path}: {e}")))?;
    }
    Ok(result)
}

fn cmd_verify(args: &[String]) -> Result<Value, Failure> {
    let path = args
        .first()
        .ok_or_else(|| Failure::Policy("usage: elia-box verify RECEIPT.json".into()))?;
    let text = std::fs::read_to_string(path)
        .map_err(|e| Failure::Policy(format!("cannot read {path}: {e}")))?;
    let v: Value =
        serde_json::from_str(&text).map_err(|e| Failure::Policy(format!("not JSON: {e}")))?;
    let key = std::env::var("ELIA_BOX_RECEIPT_KEY")
        .ok()
        .filter(|k| !k.is_empty());
    let verdict = receipt::verify(&v, key.as_deref().map(str::as_bytes));
    Ok(match verdict {
        receipt::Verdict::MacOk => json!({ "valid": true, "checked": "hash+mac" }),
        receipt::Verdict::HashOk => {
            json!({ "valid": true, "checked": "hash", "note": "no key was used; this detects accidental edits, not forgery" })
        }
        receipt::Verdict::Bad(why) => json!({ "valid": false, "reason": why }),
    })
}

fn cmd_diff(args: &[String]) -> Result<Value, Failure> {
    let mut dirs = Vec::new();
    let mut excludes = policy_excludes();
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--exclude" {
            excludes.push(args.get(i + 1).cloned().unwrap_or_default());
            i += 2;
        } else {
            dirs.push(PathBuf::from(&args[i]));
            i += 1;
        }
    }
    if dirs.len() != 2 {
        return Err(Failure::Policy(
            "usage: elia-box diff DIR_A DIR_B [--exclude NAME]...".into(),
        ));
    }
    let (a, b) = (
        fsx::snapshot(&dirs[0], &excludes).map_err(internal)?,
        fsx::snapshot(&dirs[1], &excludes).map_err(internal)?,
    );
    let changes = fsx::diff(&a, &b).map_err(internal)?;
    Ok(
        json!({ "changes": changes, "identical": changes.added.is_empty() && changes.modified.is_empty() && changes.deleted.is_empty() }),
    )
}

/// The Seatbelt profile a policy compiles to, for review. Nothing is run.
fn cmd_profile(args: &[String]) -> Result<Value, Failure> {
    let path = match args {
        [flag, path] if flag == "--policy" => path,
        _ => {
            return Err(Failure::Policy(
                "usage: elia-box profile --policy FILE|-".into(),
            ))
        }
    };
    let text = read_policy(path).map_err(|e| Failure::Policy(format!("{e:#}")))?;
    let policy = Policy::parse(&text)
        .and_then(Policy::resolve)
        .map_err(|e| Failure::Policy(format!("{e:#}")))?;
    let scratch = std::env::temp_dir().join("elia-box-EXAMPLE").join("rw");
    let port = (policy.network.mode == NetMode::Brokered).then_some(0);
    let profile = seatbelt::profile(&policy, &policy.workspace, &scratch, port)
        .map_err(|e| Failure::Policy(format!("{e:#}")))?;
    Ok(json!({ "profile": profile }))
}

fn policy_excludes() -> Vec<String> {
    vec!["node_modules".into(), "target".into(), ".DS_Store".into()]
}

fn cmd_image(args: &[String]) -> Result<Value, Failure> {
    let dk = docker::find_docker()
        .ok_or_else(|| Failure::Unavailable("docker is not installed".into()))?;
    match args.first().map(String::as_str) {
        Some("status") => Ok(
            json!({ "image": policy::DEFAULT_IMAGE, "present": docker::image_present(&dk, policy::DEFAULT_IMAGE) }),
        ),
        Some("build") => {
            use std::io::Write;
            let mut child = std::process::Command::new(&dk)
                .args(["build", "-t", policy::DEFAULT_IMAGE, "-"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| Failure::Unavailable(e.to_string()))?;
            child
                .stdin
                .take()
                .expect("piped")
                .write_all(docker::DOCKERFILE.as_bytes())
                .map_err(|e| Failure::Internal(e.to_string()))?;
            let out = child
                .wait_with_output()
                .map_err(|e| Failure::Internal(e.to_string()))?;
            if !out.status.success() {
                return Err(Failure::Backend(
                    String::from_utf8_lossy(&out.stderr)
                        .lines()
                        .rev()
                        .take(3)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join(" | "),
                ));
            }
            Ok(json!({ "image": policy::DEFAULT_IMAGE, "built": true }))
        }
        _ => Err(Failure::Policy("usage: elia-box image build|status".into())),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("run") => cmd_run(&args[1..]),
        Some("probe") => Ok(probe()),
        Some("verify") => cmd_verify(&args[1..]),
        Some("diff") => cmd_diff(&args[1..]),
        Some("fork") => match (args.get(1), args.get(2)) {
            (Some(s), Some(d)) => fsx::fork(Path::new(s), Path::new(d))
                .map(|cow| json!({ "copyOnWrite": cow }))
                .map_err(internal),
            _ => Err(Failure::Policy("usage: elia-box fork SRC DST".into())),
        },
        Some("image") => cmd_image(&args[1..]),
        Some("profile") => cmd_profile(&args[1..]),
        _ => Err(Failure::Policy(
            "usage: elia-box run|probe|verify|fork|diff|image ...".into(),
        )),
    };
    match result {
        Ok(v) => print(&v),
        Err(f) => fail(f),
    }
}
