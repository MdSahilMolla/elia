//! Persistent shell workers.
//!
//! The cost this removes: on Windows every `run_command` in the old path spawned
//! a fresh `cmd.exe` (measured at 20–80ms). Here one shell process per working
//! directory stays alive for the life of the daemon, and each command is framed
//! between random markers so we can read exactly its stdout, its stderr, and its
//! exit code back out of the long-lived streams.
//!
//! A command that overruns its timeout, or is cancelled, kills its worker — the
//! shell can't be reused while a runaway child still holds its pipes — and the
//! next command for that directory transparently spawns a fresh one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

/// Outcome of one command. Mirrors `ShellExecResult` in `protocol.rs`; a
/// non-zero `exit_code` is a normal result, not an error.
pub struct ExecOutcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
    pub timed_out: bool,
}

/// Why an `exec` future stopped early.
pub enum ExecStop {
    Cancelled,
}

const MAX_CAPTURE_BYTES: usize = 2_000_000;

pub struct ShellPool {
    workers: Mutex<HashMap<PathBuf, Arc<Mutex<Option<ShellWorker>>>>>,
}

impl ShellPool {
    pub fn new() -> Self {
        Self {
            workers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn worker_count(&self) -> usize {
        let map = self.workers.lock().await;
        let mut live = 0;
        for slot in map.values() {
            if slot.lock().await.is_some() {
                live += 1;
            }
        }
        live
    }

    /// Runs `command` in `cwd`. Serialised per directory (one shell, one command
    /// at a time); different directories run in parallel. `cancel` resolving
    /// aborts the command and discards the worker.
    pub async fn exec(
        &self,
        command: &str,
        cwd: &str,
        timeout_ms: u64,
        cancel: oneshot::Receiver<()>,
    ) -> Result<std::result::Result<ExecOutcome, ExecStop>> {
        let key = canonical_key(cwd);
        let slot = {
            let mut map = self.workers.lock().await;
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };

        let mut guard = slot.lock().await;
        if guard.is_none() {
            *guard = Some(
                ShellWorker::spawn(&key)
                    .await
                    .context("spawning shell worker")?,
            );
        }
        let worker = guard.as_mut().expect("worker just ensured");

        let started = Instant::now();
        let run = worker.run_framed(command, cwd, Duration::from_millis(timeout_ms.max(1)));
        let selected = tokio::select! {
            result = run => Some(result),
            _ = cancel => None,
        };

        match selected {
            Some(Ok(framed)) => {
                if framed.worker_dead {
                    guard.take();
                }
                Ok(Ok(ExecOutcome {
                    exit_code: framed.exit_code,
                    stdout: framed.stdout,
                    stderr: framed.stderr,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    timed_out: framed.timed_out,
                }))
            }
            Some(Err(err)) => {
                // Timeout or unknown stream state — the worker is unusable.
                guard.take();
                Err(err)
            }
            None => {
                guard.take(); // Cancelled: drop kills the shell and its child.
                Ok(Err(ExecStop::Cancelled))
            }
        }
    }
}

struct FramedRun {
    exit_code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
    /// The shell process ended during this command (a bare `exit`, or a crash).
    /// The result is still valid — the exit code came from the process itself —
    /// but the worker must be discarded.
    worker_dead: bool,
}

struct ShellWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: BufReader<ChildStderr>,
}

impl Drop for ShellWorker {
    fn drop(&mut self) {
        // Best-effort: kill the shell so a runaway child does not outlive us.
        let _ = self.child.start_kill();
    }
}

impl ShellWorker {
    async fn spawn(cwd: &Path) -> Result<Self> {
        let mut command = base_command();
        command
            .current_dir(if cwd.exists() { cwd } else { Path::new(".") })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().context("failed to start shell")?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?);
        let stderr = BufReader::new(child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?);
        let mut worker = Self {
            child,
            stdin,
            stdout,
            stderr,
        };

        // Neutralise the shell's own preamble (cmd banner, any prompt) before the
        // first real command by running a throwaway framed command and dropping
        // whatever came before its BEGIN marker.
        worker
            .run_framed("rem elia-warmup", ".", Duration::from_secs(10))
            .await
            .context("shell warm-up failed")?;
        Ok(worker)
    }

    async fn run_framed(
        &mut self,
        command: &str,
        cwd: &str,
        budget: Duration,
    ) -> Result<FramedRun> {
        let nonce = next_nonce();
        let begin = format!("{nonce}B");
        let end = format!("{nonce}E");
        let script = frame_script(&begin, &end, command, cwd);
        self.stdin
            .write_all(script.as_bytes())
            .await
            .context("writing to shell")?;
        self.stdin.flush().await.ok();

        // Drain both streams concurrently: a command that fills the OS stderr
        // pipe buffer while we wait on stdout would otherwise deadlock.
        let Self {
            stdout,
            stderr,
            child,
            ..
        } = self;
        let read = async {
            let (out, err) = tokio::join!(
                read_until_marker(stdout, &begin, &end, true),
                read_until_marker(stderr, &begin, &end, false),
            );
            (out, err)
        };

        let (out, err) = match timeout(budget, read).await {
            Ok(pair) => pair,
            Err(_) => return Err(anyhow!("__elia_timeout__")),
        };

        let out = out.context("reading shell stdout")?;
        // stderr framing is best-effort; if it closed early, keep what we have.
        let err_payload = err.map(|r| r.payload).unwrap_or_default();

        if out.hit_eof {
            // The shell exited during the command (`exit N`, or it died). Recover
            // the real exit code from the process itself and retire the worker.
            let status = child.wait().await.ok();
            let code = status.and_then(|s| s.code()).unwrap_or(out.exit_code);
            return Ok(FramedRun {
                exit_code: code,
                stdout: out.payload,
                stderr: err_payload,
                timed_out: false,
                worker_dead: true,
            });
        }

        Ok(FramedRun {
            exit_code: out.exit_code,
            stdout: out.payload,
            stderr: err_payload,
            timed_out: false,
            worker_dead: false,
        })
    }
}

struct MarkerRead {
    payload: String,
    exit_code: i32,
    /// The stream closed before the END marker arrived.
    hit_eof: bool,
}

/// Read lines until the framed END marker. Everything between BEGIN and END is
/// the payload; on stdout the integer after the END marker is the exit code.
async fn read_until_marker<R>(
    reader: &mut R,
    begin: &str,
    end: &str,
    parse_code: bool,
) -> Result<MarkerRead>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut seen_begin = false;
    let mut payload = String::new();
    let mut exit_code = 0i32;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .context("reading shell output")?;
        if n == 0 {
            return Ok(MarkerRead {
                payload,
                exit_code,
                hit_eof: true,
            });
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !seen_begin {
            if trimmed.contains(begin) {
                seen_begin = true;
            }
            continue;
        }
        if let Some(pos) = trimmed.find(end) {
            if parse_code {
                let rest = trimmed[pos + end.len()..].trim();
                exit_code = rest
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
            }
            return Ok(MarkerRead {
                payload,
                exit_code,
                hit_eof: false,
            });
        }
        if payload.len() < MAX_CAPTURE_BYTES {
            payload.push_str(&line);
        }
    }
}

#[cfg(windows)]
fn base_command() -> Command {
    let com_spec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let mut c = Command::new(com_spec);
    // /E:ON enable command extensions, /V:ON delayed expansion so !ERRORLEVEL!
    // reflects the command we just ran, /Q echo off.
    c.args(["/E:ON", "/V:ON", "/Q"]);
    c
}

#[cfg(not(windows))]
fn base_command() -> Command {
    Command::new("/bin/sh")
}

#[cfg(windows)]
fn frame_script(begin: &str, end: &str, command: &str, cwd: &str) -> String {
    // `cd /d` resets the directory every command so a `cd` inside one command
    // cannot leak into the next. The markers are echoed to both streams.
    format!(
        "@echo off\r\ncd /d \"{cwd}\" >nul 2>nul\r\necho {begin}& echo {begin} 1>&2\r\n{command}\r\necho {end} !ERRORLEVEL!& echo {end} 1>&2\r\n"
    )
}

#[cfg(not(windows))]
fn frame_script(begin: &str, end: &str, command: &str, cwd: &str) -> String {
    format!(
        "cd '{cwd}' 2>/dev/null\nprintf '%s\\n' '{begin}'; printf '%s\\n' '{begin}' >&2\n{command}\n__elia_rc=$?; printf '%s %d\\n' '{end}' \"$__elia_rc\"; printf '%s\\n' '{end}' >&2\n"
    )
}

fn canonical_key(cwd: &str) -> PathBuf {
    let path = PathBuf::from(cwd);
    std::fs::canonicalize(&path).unwrap_or(path)
}

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = NONCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    // A marker the command's own output is very unlikely to contain verbatim.
    format!("__elia_{:x}_{:x}_{:x}__", pid, nanos as u64, seq)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(pool: &ShellPool, cmd: &str) -> ExecOutcome {
        let (_tx, rx) = oneshot::channel();
        pool.exec(cmd, ".", 20_000, rx)
            .await
            .unwrap()
            .ok()
            .expect("not cancelled")
    }

    #[tokio::test]
    async fn captures_stdout_and_exit_code() {
        let pool = ShellPool::new();
        let out = run(&pool, "echo hello-elia").await;
        assert!(
            out.stdout.contains("hello-elia"),
            "stdout was {:?}",
            out.stdout
        );
        assert_eq!(out.exit_code, 0);
        assert!(!out.timed_out);
    }

    #[tokio::test]
    async fn reports_nonzero_exit_without_killing_the_shell() {
        let pool = ShellPool::new();
        // A sub-shell exits non-zero; the persistent worker survives it.
        let cmd = if cfg!(windows) {
            "cmd /c exit 3"
        } else {
            "(exit 3)"
        };
        let out = run(&pool, cmd).await;
        assert_eq!(out.exit_code, 3);
        assert_eq!(pool.worker_count().await, 1, "worker should still be alive");
    }

    #[tokio::test]
    async fn recovers_exit_code_when_a_command_exits_the_shell() {
        let pool = ShellPool::new();
        run(&pool, "echo warm").await;
        // A bare `exit` ends the shell mid-command; the code comes from the
        // process itself and the dead worker is retired.
        let out = run(&pool, "exit 4").await;
        assert_eq!(out.exit_code, 4);
        assert_eq!(pool.worker_count().await, 0);
    }

    #[tokio::test]
    async fn reuses_one_worker_for_a_directory() {
        let pool = ShellPool::new();
        run(&pool, "echo one").await;
        run(&pool, "echo two").await;
        assert_eq!(pool.worker_count().await, 1);
    }

    #[tokio::test]
    async fn cancellation_drops_the_worker() {
        let pool = ShellPool::new();
        run(&pool, "echo warm").await;
        let (tx, rx) = oneshot::channel();
        tx.send(()).unwrap();
        let sleep = if cfg!(windows) {
            "ping -n 20 127.0.0.1 >nul"
        } else {
            "sleep 20"
        };
        let res = pool.exec(sleep, ".", 30_000, rx).await.unwrap();
        assert!(matches!(res, Err(ExecStop::Cancelled)));
        assert_eq!(pool.worker_count().await, 0);
    }
}
