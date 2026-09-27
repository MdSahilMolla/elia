//! Persistent shell workers.
//!
//! The cost this removes: on Windows every `run_command` in the old path spawned
//! a fresh `cmd.exe` (measured at 20–80ms). Here a small pool of shell processes
//! per working directory stays alive for the life of the daemon, and each
//! command is framed between random markers so we can read exactly its stdout,
//! its stderr, and its exit code back out of the long-lived streams.
//!
//! A command that overruns its timeout, or is cancelled, kills its worker — the
//! shell can't be reused while a runaway child still holds its pipes — and the
//! next command for that slot transparently spawns a fresh one.

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

/// Hard cap on the payload kept per stream (stdout and stderr each) for one
/// command. Output past it is read and discarded, so the framing stays in sync,
/// and a one-line truncation note is appended instead.
const MAX_CAPTURE_BYTES: usize = 2_000_000;
/// Memory bound on a single physical line while it is being read: `minified.js`,
/// `git diff` of a big file, or `type` of a huge one-line dump would otherwise
/// be buffered whole before `MAX_CAPTURE_BYTES` could apply.
const MAX_LINE_BYTES: usize = 1_000_000;

/// How long a per-cwd shell worker may sit idle before the periodic reaper in
/// `server.rs` kills it. Distinct from the whole-daemon idle watchdog in
/// `main.rs` — a single cwd that saw one command an hour ago must not keep its
/// worker processes alive just because some other directory is still busy.
pub const SHELL_IDLE_SECS: u64 = 300;

/// One directory's shells. A small fixed set of slots so a burst of parallel
/// `run_command`s in the same directory actually runs in parallel (the old
/// path spawned a fresh `cmd.exe` per call, so serialising here would be a
/// regression). Each slot is an independent persistent shell, created on demand.
type CwdSlots = Vec<Arc<Mutex<Option<ShellWorker>>>>;

fn slots_per_cwd() -> usize {
    std::env::var("ELIA_SHELL_POOL")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| n.clamp(1, 16))
        .unwrap_or(4)
}

pub struct ShellPool {
    by_cwd: Mutex<HashMap<PathBuf, Arc<CwdSlots>>>,
    rotation: AtomicU64,
}

impl ShellPool {
    pub fn new() -> Self {
        Self {
            by_cwd: Mutex::new(HashMap::new()),
            rotation: AtomicU64::new(0),
        }
    }

    pub async fn worker_count(&self) -> usize {
        let map = self.by_cwd.lock().await;
        let mut live = 0;
        for slots in map.values() {
            for slot in slots.iter() {
                if slot.lock().await.is_some() {
                    live += 1;
                }
            }
        }
        live
    }

    /// Kill and drop any worker that has been idle past `idle_after`, freeing
    /// its slot, and drop a cwd's entry from `by_cwd` once every slot in it is
    /// empty. Meant to be called periodically (see `server::shell_reap_loop`)
    /// so a directory that goes quiet is reaped on its own schedule instead of
    /// waiting for the whole daemon to idle out. Uses `try_lock` so a slot
    /// that's mid-command is left alone rather than blocked on.
    pub async fn reap_idle(&self, idle_after: Duration) {
        let mut map = self.by_cwd.lock().await;
        map.retain(|_key, slots| {
            let mut any_left = false;
            for slot in slots.iter() {
                match slot.try_lock() {
                    Ok(mut guard) => {
                        if let Some(worker) = guard.as_ref() {
                            if worker.last_used.elapsed() >= idle_after {
                                guard.take(); // Drop kills the process (see ShellWorker's Drop).
                            }
                        }
                        if guard.is_some() {
                            any_left = true;
                        }
                    }
                    Err(_) => {
                        // In use right now — keep the cwd entry around.
                        any_left = true;
                    }
                }
            }
            any_left
        });
    }

    /// Runs `command` in `cwd`. Commands to the same directory share a small
    /// pool of persistent shells; different directories never contend. `cancel`
    /// resolving aborts the command and discards its worker.
    pub async fn exec(
        &self,
        command: &str,
        cwd: &str,
        timeout_ms: u64,
        cancel: oneshot::Receiver<()>,
    ) -> Result<std::result::Result<ExecOutcome, ExecStop>> {
        // `cwd` is interpolated into the framing script verbatim (quoted on both
        // platforms, but a closing quote still ends the framing prematurely and
        // lets later path text become commands — not a privilege escalation, the
        // caller already controls `command`, but a framing corruption that must
        // not reach the shell). Reject the breaking characters up front and tell
        // the caller instead of corrupting the frame.
        if cwd.contains('"') || cwd.contains('\'') || cwd.contains('\n') || cwd.contains('\r') {
            return Err(anyhow!(
                "cwd contains characters unsafe to frame into the shell script"
            ));
        }
        let key = canonical_key(cwd);
        let slots = {
            let mut map = self.by_cwd.lock().await;
            map.entry(key.clone())
                .or_insert_with(|| {
                    Arc::new(
                        (0..slots_per_cwd())
                            .map(|_| Arc::new(Mutex::new(None)))
                            .collect(),
                    )
                })
                .clone()
        };

        // Take the first idle shell; if every one is busy, wait on a rotating
        // pick so load spreads evenly. Owned guards so the guard outlives the
        // per-slot `Arc`.
        let mut guard = match slots.iter().find_map(|s| s.clone().try_lock_owned().ok()) {
            Some(g) => g,
            None => {
                let idx = (self.rotation.fetch_add(1, Ordering::Relaxed) as usize) % slots.len();
                slots[idx].clone().lock_owned().await
            }
        };

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
        worker.last_used = Instant::now();

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
    /// The shell's pid; on POSIX it is also its process-group id, so the whole
    /// tree can be addressed with a single `kill -PGID`.
    pid: Option<u32>,
    /// Updated after every command; read by `ShellPool::reap_idle`.
    last_used: Instant,
}

impl Drop for ShellWorker {
    fn drop(&mut self) {
        // Best-effort: take down the whole process group first (a runaway
        // `bun run server` descendant must not be reparented and kept alive by
        // the daemon), then the direct child as the backstop.
        let _ = crate::killtree::kill_tree(self.pid);
        let _ = self.child.start_kill();
    }
}

impl ShellWorker {
    async fn spawn(cwd: &Path) -> Result<Self> {
        let mut command = base_command();
        crate::killtree::own_process_group(command.as_std_mut());
        command
            .current_dir(if cwd.exists() { cwd } else { Path::new(".") })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().context("failed to start shell")?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?);
        let stderr = BufReader::new(child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?);
        let mut worker = Self {
            child,
            stdin,
            stdout,
            stderr,
            pid,
            last_used: Instant::now(),
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
    let mut payload = Capture::default();
    let mut exit_code = 0i32;
    loop {
        let line = match read_bounded_line(reader).await {
            Ok(Some(line)) => line,
            Ok(None) => {
                return Ok(MarkerRead {
                    payload: payload.finish(),
                    exit_code,
                    hit_eof: true,
                })
            }
            Err(err) => return Err(err),
        };
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !seen_begin {
            if trimmed.contains(begin) {
                seen_begin = true;
            }
            continue;
        }
        if let Some(pos) = trimmed.find(end) {
            // Output that did not end in a newline shares its last line with
            // the marker (`foo<END> 0`); keep the `foo`.
            payload.push(&trimmed[..pos]);
            if parse_code {
                let rest = trimmed[pos + end.len()..].trim();
                exit_code = rest
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
            }
            return Ok(MarkerRead {
                payload: payload.finish(),
                exit_code,
                hit_eof: false,
            });
        }
        payload.push(&line);
    }
}

/// One stream's payload, held to exactly `MAX_CAPTURE_BYTES`. It used to take
/// whole lines while under the cap, so it could overshoot by up to a full
/// `MAX_LINE_BYTES` line, and a cut was silent.
#[derive(Default)]
struct Capture {
    text: String,
    truncated: bool,
}

impl Capture {
    fn push(&mut self, piece: &str) {
        if self.truncated {
            return;
        }
        let room = MAX_CAPTURE_BYTES - self.text.len();
        if piece.len() <= room {
            self.text.push_str(piece);
            return;
        }
        let mut cut = room;
        while !piece.is_char_boundary(cut) {
            cut -= 1;
        }
        self.text.push_str(&piece[..cut]);
        self.truncated = true;
    }

    fn finish(mut self) -> String {
        if self.truncated {
            if !self.text.ends_with('\n') {
                self.text.push('\n');
            }
            self.text.push_str(&format!(
                "[eliad: output truncated at {MAX_CAPTURE_BYTES} bytes]\n"
            ));
        }
        self.text
    }
}

/// Read one line, bounded: at most `MAX_LINE_BYTES` bytes are accumulated; once
/// that cap is hit the rest of the physical line is drained and discarded so the
/// next read starts at the following `\n`. Without this, `read_line` allocates a
/// whole huge line (`type` of a one-line dump, minified JS) with no ceiling.
///
/// Like `read_line`, the returned line keeps its terminating `\n` (absent only
/// for a final unterminated line), so the payload keeps the command's line
/// breaks. Returns `Ok(None)` at EOF.
async fn read_bounded_line<R>(reader: &mut R) -> Result<Option<String>>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut line = Vec::new();
    loop {
        let chunk = reader.fill_buf().await.context("reading shell output")?;
        if chunk.is_empty() {
            return Ok(if line.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(&line).into_owned())
            });
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(nl) if line.len() + nl < MAX_LINE_BYTES => {
                line.extend_from_slice(&chunk[..=nl]);
                reader.consume(nl + 1);
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            _ => {
                let take = chunk.len();
                let room = MAX_LINE_BYTES.saturating_sub(line.len());
                let to_keep = take.min(room);
                line.extend_from_slice(&chunk[..to_keep]);
                reader.consume(to_keep);
                if line.len() >= MAX_LINE_BYTES {
                    // Physical line exceeds the cap: drain to its end without
                    // keeping any more bytes, so framing stays intact.
                    if drain_to_newline(reader).await? {
                        line.push(b'\n');
                    }
                    return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
                }
            }
        }
    }
}

/// Discard bytes up to (and including) the next `\n`, so the caller next reads
/// from the start of a fresh physical line. Returns whether a `\n` was found
/// (false at EOF).
async fn drain_to_newline<R>(reader: &mut R) -> Result<bool>
where
    R: AsyncBufReadExt + Unpin,
{
    loop {
        let chunk = reader.fill_buf().await.context("reading shell output")?;
        if chunk.is_empty() {
            return Ok(false);
        }
        match chunk.iter().position(|&b| b == b'\n') {
            Some(nl) => {
                reader.consume(nl + 1);
                return Ok(true);
            }
            None => {
                let n = chunk.len();
                reader.consume(n);
            }
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
    // cannot leak into the next. The markers are echoed to both streams. Windows
    // paths cannot contain '"', so `cwd` needs no escaping here — but a `cd`
    // failure (directory deleted after the TS-side check, permissions, ...) must
    // not be swallowed: check `errorlevel` and, on failure, skip the command
    // entirely and report a distinct "cwd unreachable" outcome instead of
    // silently running it in whatever directory the shell was previously in.
    format!(
        "@echo off\r\ncd /d \"{cwd}\" >nul\r\nif errorlevel 1 goto :elia_cwd_err\r\necho {begin}& echo {begin} 1>&2\r\n{command}\r\necho {end} !ERRORLEVEL!& echo {end} 1>&2\r\ngoto :eof\r\n:elia_cwd_err\r\necho {begin}& echo {begin} 1>&2\r\necho elia: cd failed - cwd unreachable 1>&2\r\necho {end} 127& echo {end} 1>&2\r\n"
    )
}

#[cfg(not(windows))]
fn frame_script(begin: &str, end: &str, command: &str, cwd: &str) -> String {
    // `cwd` is interpolated into a single-quoted shell string, so a literal `'`
    // in it must be escaped (POSIX idiom: close the quote, emit an escaped `'`,
    // reopen the quote) or a directory name containing one could break out and
    // inject shell commands. A `cd` failure must also not be swallowed — as on
    // the Windows side above, skip the command and report a distinct "cwd
    // unreachable" outcome instead of silently running it in the old directory.
    let escaped_cwd = cwd.replace('\'', r"'\''");
    format!(
        "if cd '{escaped_cwd}'; then printf '%s\\n' '{begin}'; printf '%s\\n' '{begin}' >&2\n{command}\n__elia_rc=$?; printf '%s %d\\n' '{end}' \"$__elia_rc\"; printf '%s\\n' '{end}' >&2\nelse printf '%s\\n' '{begin}'; printf '%s\\n' '{begin}' >&2; printf 'elia: cd failed: cwd unreachable\\n' >&2; printf '%s %d\\n' '{end}' 127; printf '%s\\n' '{end}' >&2\nfi\n"
    )
}

fn canonical_key(cwd: &str) -> PathBuf {
    let path = PathBuf::from(cwd);
    std::fs::canonicalize(&path).unwrap_or(path)
}

static NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The per-command marker. Framing is only as strong as the marker's absence
/// from the command's own output, so it must not be predictable: pid, clock and
/// a counter alone are guessable by anything that can read the process table.
/// The salt is a SipHash under std's randomly seeded `RandomState` key, so a
/// command cannot know its marker in advance and forge an early END.
fn next_nonce() -> String {
    use std::hash::{BuildHasher, Hasher};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = NONCE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(nanos);
    hasher.write_u64(seq);
    format!("__elia_{:x}_{:x}_{:016x}__", pid, seq, hasher.finish())
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
    async fn multi_line_output_keeps_its_line_breaks() {
        let pool = ShellPool::new();
        let cmd = if cfg!(windows) {
            "echo one& echo two"
        } else {
            "echo one; echo two"
        };
        let out = run(&pool, cmd).await;
        assert_eq!(out.stdout.replace("\r\n", "\n"), "one\ntwo\n");
    }

    #[tokio::test]
    async fn output_without_a_trailing_newline_is_kept() {
        let pool = ShellPool::new();
        let cmd = if cfg!(windows) {
            "<nul set /p =no-newline"
        } else {
            "printf no-newline"
        };
        let out = run(&pool, cmd).await;
        // (`set /p` from nul exits 1 on Windows, so only the output is checked.)
        assert_eq!(out.stdout, "no-newline");
    }

    #[test]
    fn capture_is_capped_exactly_and_says_so() {
        let mut capture = Capture::default();
        // 3 × 700 KB: the third line crosses the 2 MB cap mid-line.
        let line = format!("{}\n", "x".repeat(699_999));
        for _ in 0..3 {
            capture.push(&line);
        }
        let text = capture.finish();
        let note = format!("\n[eliad: output truncated at {MAX_CAPTURE_BYTES} bytes]\n");
        assert!(text.ends_with(&note), "missing truncation note");
        assert_eq!(text.len(), MAX_CAPTURE_BYTES + note.len());
    }

    #[test]
    fn capture_under_the_cap_is_untouched() {
        let mut capture = Capture::default();
        capture.push("a\n");
        capture.push("b");
        assert_eq!(capture.finish(), "a\nb");
    }

    #[test]
    fn nonces_are_unique_and_salted() {
        let a = next_nonce();
        let b = next_nonce();
        assert_ne!(a, b);
        // pid, seq, then a 16-hex-digit salt.
        let salt = a.trim_end_matches("__").rsplit('_').next().unwrap();
        assert_eq!(salt.len(), 16);
    }

    #[tokio::test]
    async fn reuses_one_worker_for_a_directory() {
        let pool = ShellPool::new();
        run(&pool, "echo one").await;
        run(&pool, "echo two").await;
        assert_eq!(pool.worker_count().await, 1);
    }

    #[tokio::test]
    async fn rejects_cwd_that_cannot_be_framed_safely() {
        let pool = ShellPool::new();
        for bad in ["a\"b", "a'b", "a\nb", "a\rb"] {
            let (_tx, rx) = oneshot::channel();
            let res = pool.exec("echo hi", bad, 20_000, rx).await;
            let err = match res {
                Err(e) => e,
                _ => panic!("bad cwd {:?} must be rejected before spawn", bad),
            };
            assert!(
                err.to_string().contains("unsafe to frame"),
                "unexpected error for cwd {:?}: {err}",
                bad
            );
        }
        assert_eq!(pool.worker_count().await, 0, "no worker should spawn");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn parallel_commands_in_one_dir_use_separate_shells() {
        let pool = Arc::new(ShellPool::new());
        let sleep = if cfg!(windows) {
            "ping -n 2 127.0.0.1 >nul"
        } else {
            "sleep 1"
        };
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let pool = pool.clone();
                tokio::spawn(async move {
                    let (_tx, rx) = oneshot::channel();
                    pool.exec(sleep, ".", 20_000, rx)
                        .await
                        .unwrap()
                        .ok()
                        .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.await.unwrap();
        }
        assert!(
            pool.worker_count().await >= 2,
            "expected the pool to fan out"
        );
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

    static TREE_NONCE: AtomicU64 = AtomicU64::new(0);

    #[tokio::test]
    async fn tree_kill_takes_a_runaway_grandchild_down() {
        // A command backgrounds a descendant that appends to a file forever,
        // then idles. The pre-fix pool killed only the shell; the descendant
        // was reparented to the daemon and kept writing — a leak that every
        // timeout/cancel used to go through. The tree kill must take it down
        // with the worker. On Windows grandchildren are bound to the parent's
        // lifetime, so this is a POSIX regression guard.
        if cfg!(windows) {
            return;
        }
        let pool = Arc::new(ShellPool::new());
        run(&pool, "echo warm").await;

        let heartbeat = std::env::temp_dir().join(format!(
            "elia-treekill-{}-{}.hb",
            std::process::id(),
            TREE_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        let size = |path: &std::path::Path| std::fs::read_to_string(path).map_or(0, |s| s.len());
        let cmd = format!(
            "( while :; do printf 'x' >> \"{}\"; sleep 0.05; done ) & sleep 30",
            heartbeat.display()
        );

        let (tx, rx) = oneshot::channel();
        let exec = {
            let pool = pool.clone();
            tokio::spawn(async move { pool.exec(&cmd, ".", 30_000, rx).await })
        };

        // Wait for the grandchild to prove it is alive and writing on its own.
        let deadline = Instant::now() + Duration::from_secs(10);
        while size(&heartbeat) == 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(size(&heartbeat) > 0, "grandchild never started writing");
        // ...and that it keeps writing unattended, i.e. not coupled to the shell.
        let before = size(&heartbeat);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            size(&heartbeat) > before,
            "grandchild stopped writing on its own"
        );

        tx.send(()).unwrap();
        let inner = exec.await.unwrap().expect("exec task panicked");
        assert!(matches!(inner, Err(ExecStop::Cancelled)));
        assert_eq!(pool.worker_count().await, 0);

        let after = size(&heartbeat);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            size(&heartbeat),
            after,
            "grandchild kept writing after the worker was cancelled"
        );

        let _ = std::fs::remove_file(&heartbeat);
    }

    #[tokio::test]
    async fn a_single_huge_physical_line_is_bounded_not_buffered_whole() {
        let pool = ShellPool::new();
        // One ~3 MB physical line (no embedded newline), well past
        // MAX_CAPTURE_BYTES (2 MB) — this used to be buffered in full by
        // `read_line` before the payload cap ever got a chance to apply.
        let cmd = if cfg!(windows) {
            "powershell -NoProfile -Command \"Write-Output ('a' * 3000000)\""
        } else {
            "head -c 3000000 /dev/zero | tr '\\0' 'a'; echo"
        };
        let out = run(&pool, cmd).await;
        assert_eq!(out.exit_code, 0);
        assert!(
            out.stdout.len() <= MAX_CAPTURE_BYTES + 1024,
            "payload should stay near the cap, got {} bytes",
            out.stdout.len()
        );
        // Framing stayed in sync despite the truncation: the worker is reusable.
        assert_eq!(pool.worker_count().await, 1);
    }
}
