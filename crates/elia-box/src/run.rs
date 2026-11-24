//! The supervisor: runs one confined command to completion and accounts for it.
//!
//! What this layer guarantees regardless of backend: the command runs in its own
//! session; it is killed (with everything it spawned) when it exceeds the wall
//! clock, when elia-box itself is interrupted, or, for the direct backends,
//! when its process tree exceeds the memory or process budget; nothing it leaves
//! running outlives it; and captured output is capped rather than unbounded.

use crate::policy::Limits;
use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
        libc::sigemptyset(&mut sa.sa_mask);
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            libc::sigaction(sig, &sa, std::ptr::null_mut());
        }
    }
}

pub struct RunSpec {
    pub cmd: Command,
    pub limits: Limits,
    /// Enforce memory and process budgets by watching the process tree (direct
    /// backends). A container enforces them itself, so its supervisor skips this.
    pub watch_tree: bool,
    /// Apply RLIMIT_* to the child (direct backends).
    pub apply_rlimits: bool,
    /// Called just before the tree is killed, e.g. to `docker kill` a container.
    pub on_kill: Option<Box<dyn Fn() + Send + Sync>>,
    /// How to find processes of this run that left the process group (macOS).
    pub probe: Option<SandboxProbe>,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub interrupted: bool,
    /// "memory" or "pids" when the tree watcher killed the run.
    pub limit_hit: Option<String>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub cpu_user_ms: Option<u64>,
    pub cpu_sys_ms: Option<u64>,
    pub max_rss_kb: Option<u64>,
    pub peak_tree_rss_kb: Option<u64>,
    pub peak_procs: Option<u64>,
    pub wall_ms: u64,
    /// The command left processes behind; they were killed.
    pub stragglers_killed: bool,
}

#[derive(Default)]
struct Captured {
    data: Vec<u8>,
    total: u64,
    done: bool,
}

fn capture(mut src: impl Read + Send + 'static, cap: usize) -> Arc<Mutex<Captured>> {
    let buf = Arc::new(Mutex::new(Captured::default()));
    let shared = buf.clone();
    thread::spawn(move || {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match src.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut b = shared.lock().unwrap();
                    b.total += n as u64;
                    let room = cap.saturating_sub(b.data.len());
                    b.data.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
        shared.lock().unwrap().done = true;
    });
    buf
}

#[derive(Clone, Copy)]
struct Proc {
    ppid: i32,
    pgid: i32,
    rss_kb: u64,
}

fn ps_table() -> Option<HashMap<i32, Proc>> {
    let out = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pgid=,rss="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut table = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 {
            continue;
        }
        if let (Ok(pid), Ok(ppid), Ok(pgid), Ok(rss)) =
            (f[0].parse(), f[1].parse(), f[2].parse(), f[3].parse())
        {
            table.insert(
                pid,
                Proc {
                    ppid,
                    pgid,
                    rss_kb: rss,
                },
            );
        }
    }
    Some(table)
}

/// The root, everything descended from it, and everything left in its process group.
fn tree_members(table: &HashMap<i32, Proc>, root: i32) -> HashSet<i32> {
    let mut members: HashSet<i32> = HashSet::new();
    if table.contains_key(&root) {
        members.insert(root);
    }
    loop {
        let before = members.len();
        for (pid, p) in table {
            if !members.contains(pid) && (members.contains(&p.ppid) || p.pgid == root) {
                members.insert(*pid);
            }
        }
        if members.len() == before {
            return members;
        }
    }
}

/// How to recognise a leftover process of one specific run.
///
/// A process that daemonizes (double fork, setsid) leaves the process group and the
/// parent chain, and platform binaries hide their environment, so neither lineage nor
/// environment can find it. What it cannot shed is the sandbox it was born into, and the
/// kernel will say what a given pid's sandbox permits. Two run-unique probes pin it to
/// *this* run: it may write into this run's scratch directory (an allowed path) yet may
/// not read this run's profile file (a denied one). An unsandboxed process, another
/// app's sandbox, or another run's box fails one of the two.
#[derive(Clone)]
pub struct SandboxProbe {
    pub allowed_write: String,
    pub denied_read: String,
}

#[cfg(target_os = "macos")]
fn sandboxed_members(probe: &SandboxProbe) -> Vec<i32> {
    use std::ffi::CString;
    extern "C" {
        fn sandbox_check(
            pid: libc::c_int,
            operation: *const libc::c_char,
            filter_type: libc::c_int,
            ...
        ) -> libc::c_int;
    }
    const FILTER_PATH: libc::c_int = 1;
    const NO_REPORT: libc::c_int = 0x4000_0000;
    let (Ok(w), Ok(r)) = (
        CString::new(probe.allowed_write.as_str()),
        CString::new(probe.denied_read.as_str()),
    ) else {
        return vec![];
    };
    let Some(table) = ps_table() else {
        return vec![];
    };
    let me = std::process::id() as i32;
    table
        .keys()
        .copied()
        .filter(|pid| *pid != me && *pid > 1)
        .filter(|pid| unsafe {
            sandbox_check(
                *pid,
                c"file-write-data".as_ptr(),
                FILTER_PATH | NO_REPORT,
                w.as_ptr(),
            ) == 0
                && sandbox_check(
                    *pid,
                    c"file-read-data".as_ptr(),
                    FILTER_PATH | NO_REPORT,
                    r.as_ptr(),
                ) == 1
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn sandboxed_members(_probe: &SandboxProbe) -> Vec<i32> {
    vec![]
}

fn kill_tree(root: i32, probe: Option<&SandboxProbe>) {
    // Freeze first so a fork loop cannot outrun the sweep, then kill by pid and group.
    unsafe { libc::killpg(root, libc::SIGSTOP) };
    if let Some(table) = ps_table() {
        for pid in tree_members(&table, root) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    unsafe {
        libc::killpg(root, libc::SIGKILL);
        libc::killpg(root, libc::SIGCONT);
    }
    if let Some(p) = probe {
        // Anything that escaped the group: freeze all, then kill all, so none can fork on.
        let found = sandboxed_members(p);
        for pid in &found {
            unsafe { libc::kill(*pid, libc::SIGSTOP) };
        }
        for pid in &found {
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
    }
}

fn user_process_count() -> Option<u64> {
    let uid = unsafe { libc::getuid() };
    let out = Command::new("/bin/ps")
        .args(["-U", &uid.to_string(), "-o", "pid="])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).lines().count() as u64)
}

fn set_rlimit(resource: libc::c_int, want: u64) -> std::io::Result<()> {
    unsafe {
        let mut cur: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(resource, &mut cur) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let v = (want as libc::rlim_t).min(cur.rlim_max);
        let lim = libc::rlimit {
            rlim_cur: v,
            rlim_max: v,
        };
        if libc::setrlimit(resource, &lim) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Why {
    Timeout,
    Interrupted,
    Memory,
    Pids,
}

pub fn run(spec: RunSpec) -> Result<Outcome> {
    install_signal_handlers();
    let RunSpec {
        mut cmd,
        limits,
        watch_tree,
        apply_rlimits,
        on_kill,
        probe,
    } = spec;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let nproc_cap = if apply_rlimits {
        user_process_count().map(|n| n + limits.pids)
    } else {
        None
    };
    let (cpu, fsize, nofile) = (
        limits.cpu_seconds,
        limits.file_size_mb.saturating_mul(1024 * 1024),
        limits.open_files,
    );
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if apply_rlimits {
                if let Some(secs) = cpu {
                    set_rlimit(libc::RLIMIT_CPU, secs)?;
                }
                set_rlimit(libc::RLIMIT_FSIZE, fsize)?;
                set_rlimit(libc::RLIMIT_NOFILE, nofile.min(10_240))?;
                set_rlimit(libc::RLIMIT_CORE, 0)?;
                if let Some(cap) = nproc_cap {
                    set_rlimit(libc::RLIMIT_NPROC, cap)?;
                }
            }
            Ok(())
        });
    }

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("could not start the sandboxed command: {e}"))?;
    let pid = child.id() as i32;
    let out = capture(child.stdout.take().expect("piped"), limits.output_bytes);
    let err = capture(child.stderr.take().expect("piped"), limits.output_bytes);

    let done = Arc::new(AtomicBool::new(false));
    let why: Arc<Mutex<Option<Why>>> = Arc::new(Mutex::new(None));
    let peaks: Arc<Mutex<(u64, u64)>> = Arc::new(Mutex::new((0, 0))); // (rss kb, procs)
    let monitor = {
        let (done, why, peaks, probe) = (done.clone(), why.clone(), peaks.clone(), probe.clone());
        let wall = Duration::from_millis(limits.wall_ms);
        let mem_limit_kb = limits.memory_mb.saturating_mul(1024);
        let pid_limit = limits.pids;
        thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let mut verdict = None;
                if INTERRUPTED.load(Ordering::SeqCst) {
                    verdict = Some(Why::Interrupted);
                } else if started.elapsed() >= wall {
                    verdict = Some(Why::Timeout);
                } else if watch_tree {
                    if let Some(table) = ps_table() {
                        let members = tree_members(&table, pid);
                        let rss: u64 = members
                            .iter()
                            .filter_map(|p| table.get(p))
                            .map(|p| p.rss_kb)
                            .sum();
                        let procs = members.len() as u64;
                        let mut pk = peaks.lock().unwrap();
                        pk.0 = pk.0.max(rss);
                        pk.1 = pk.1.max(procs);
                        if rss > mem_limit_kb {
                            verdict = Some(Why::Memory);
                        } else if procs > pid_limit {
                            verdict = Some(Why::Pids);
                        }
                    }
                }
                if let Some(v) = verdict {
                    *why.lock().unwrap() = Some(v);
                    if let Some(hook) = &on_kill {
                        hook();
                    }
                    kill_tree(pid, probe.as_ref());
                    return;
                }
                thread::sleep(Duration::from_millis(40));
            }
        })
    };

    let (mut status, mut ru): (libc::c_int, libc::rusage) = unsafe { (0, std::mem::zeroed()) };
    loop {
        let r = unsafe { libc::wait4(pid, &mut status, 0, &mut ru) };
        if r == pid {
            break;
        }
        if r < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Err(anyhow!("wait4 failed: {}", std::io::Error::last_os_error()));
        }
    }
    done.store(true, Ordering::SeqCst);
    let _ = monitor.join();

    // Anything the command left running dies with it.
    let stragglers = unsafe { libc::killpg(pid, 0) } == 0
        || probe
            .as_ref()
            .is_some_and(|p| !sandboxed_members(p).is_empty());
    if stragglers {
        kill_tree(pid, probe.as_ref());
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && !(out.lock().unwrap().done && err.lock().unwrap().done) {
        thread::sleep(Duration::from_millis(5));
    }

    let why = *why.lock().unwrap();
    let (peak_rss, peak_procs) = *peaks.lock().unwrap();
    let (o, e) = (out.lock().unwrap(), err.lock().unwrap());
    let exited = libc::WIFEXITED(status);
    #[cfg(target_os = "macos")]
    let max_rss_kb = ru.ru_maxrss as u64 / 1024;
    #[cfg(not(target_os = "macos"))]
    let max_rss_kb = ru.ru_maxrss as u64;
    let ms = |t: libc::timeval| (t.tv_sec as u64) * 1000 + (t.tv_usec as u64) / 1000;
    Ok(Outcome {
        exit_code: exited.then(|| libc::WEXITSTATUS(status)),
        signal: libc::WIFSIGNALED(status).then(|| libc::WTERMSIG(status)),
        timed_out: why == Some(Why::Timeout),
        interrupted: why == Some(Why::Interrupted),
        limit_hit: match why {
            Some(Why::Memory) => Some("memory".into()),
            Some(Why::Pids) => Some("pids".into()),
            _ => None,
        },
        stdout: o.data.clone(),
        stderr: e.data.clone(),
        stdout_bytes: o.total,
        stderr_bytes: e.total,
        cpu_user_ms: Some(ms(ru.ru_utime)),
        cpu_sys_ms: Some(ms(ru.ru_stime)),
        max_rss_kb: Some(max_rss_kb),
        peak_tree_rss_kb: watch_tree.then_some(peak_rss),
        peak_procs: watch_tree.then_some(peak_procs),
        wall_ms: started.elapsed().as_millis() as u64,
        stragglers_killed: stragglers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(script: &str, limits: Limits) -> RunSpec {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        RunSpec {
            cmd,
            limits,
            watch_tree: true,
            apply_rlimits: true,
            on_kill: None,
            probe: None,
        }
    }

    fn quick() -> Limits {
        Limits {
            wall_ms: 10_000,
            ..Limits::default()
        }
    }

    #[test]
    fn captures_output_and_exit_code() {
        let o = run(spec("echo out; echo err >&2; exit 7", quick())).unwrap();
        assert_eq!(o.exit_code, Some(7));
        assert_eq!(String::from_utf8_lossy(&o.stdout), "out\n");
        assert_eq!(String::from_utf8_lossy(&o.stderr), "err\n");
        assert!(!o.timed_out && o.limit_hit.is_none() && !o.stragglers_killed);
    }

    #[test]
    fn wall_clock_kills_the_whole_tree() {
        let l = Limits {
            wall_ms: 400,
            ..Limits::default()
        };
        let marker = format!("30.{}", 100 + std::process::id() % 800);
        let o = run(spec(
            &format!("sleep {marker} & sleep {marker} & sleep {marker}"),
            l,
        ))
        .unwrap();
        assert!(o.timed_out);
        assert_eq!(o.signal, Some(libc::SIGKILL));
        assert!(o.wall_ms < 5_000, "took {}ms", o.wall_ms);
        // nothing from the run may survive
        std::thread::sleep(Duration::from_millis(200));
        let left = Command::new("/usr/bin/pgrep")
            .args(["-f", &format!("sleep {marker}")])
            .output()
            .unwrap();
        assert!(
            left.stdout.is_empty(),
            "survivors: {}",
            String::from_utf8_lossy(&left.stdout)
        );
    }

    #[test]
    fn stragglers_left_behind_are_killed() {
        let o = run(spec("sleep 30 >/dev/null 2>&1 & echo started", quick())).unwrap();
        assert_eq!(o.exit_code, Some(0));
        assert!(
            o.stragglers_killed,
            "a background process outliving the command must be reaped"
        );
        assert!(o.wall_ms < 5_000);
    }

    #[test]
    fn output_is_capped_but_counted() {
        let l = Limits {
            output_bytes: 1000,
            ..quick()
        };
        let o = run(spec("head -c 100000 /dev/zero | tr '\\0' x", l)).unwrap();
        assert_eq!(o.stdout.len(), 1000);
        assert_eq!(o.stdout_bytes, 100_000);
    }

    #[test]
    fn rlimit_file_size_stops_a_disk_filler() {
        let l = Limits {
            file_size_mb: 1,
            ..quick()
        };
        let path = std::env::temp_dir().join(format!("eb-fsize-{}", std::process::id()));
        let o = run(spec(
            &format!("head -c 5000000 /dev/zero > {}; echo after", path.display()),
            l,
        ))
        .unwrap();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let _ = std::fs::remove_file(&path);
        assert!(size <= 1024 * 1024, "wrote {size} bytes past a 1MB limit");
        let _ = o;
    }

    #[test]
    fn memory_budget_is_enforced() {
        let l = Limits {
            memory_mb: 64,
            ..quick()
        };
        let o = run(spec(
            "python3 -c \"b=bytearray(400*1024*1024); import time; time.sleep(20)\"",
            l,
        ))
        .unwrap();
        assert_eq!(o.limit_hit.as_deref(), Some("memory"), "outcome: {o:?}");
    }
}
