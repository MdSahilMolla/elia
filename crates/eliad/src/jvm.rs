//! Supervises `elia-jvm-bridge` — a resident JVM child that type-checks Java
//! edits with the JDK's in-process compiler.
//!
//! Lazy: the JVM starts only on the first `jvm.*` request, and only if a JDK and
//! the bridge jar are both found. Any failure here surfaces as an RPC error, and
//! the TypeScript side falls back (for Java that means "no pre-flight check",
//! not a broken build).
//!
//! - jar: `ELIA_JVM_BRIDGE_JAR` (the CLI sets it when spawning the daemon)
//! - java: `$JAVA_HOME/bin/java`, else `java` on `PATH`

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

pub struct JvmBridge {
    proc: Mutex<Option<Proc>>,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: tokio::io::Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl JvmBridge {
    pub fn new() -> Self {
        Self {
            proc: Mutex::new(None),
        }
    }

    /// Whether a JDK and the bridge jar are both available.
    pub fn available() -> bool {
        jar_path().is_some()
    }

    /// Forward one `jvm.*` request. Calls are serialised (a type-check is a few
    /// hundred ms and infrequent). A transport failure drops the child so the
    /// next call respawns it.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let mut guard = self.proc.lock().await;
        if guard.is_none() {
            *guard = Some(Proc::spawn().await?);
        }
        let proc = guard.as_mut().expect("just ensured");

        match proc.request(method, params).await {
            Ok(value) => Ok(value),
            Err(err) => {
                guard.take(); // unknown stream state — restart next time
                Err(err)
            }
        }
    }
}

impl Proc {
    async fn spawn() -> Result<Self> {
        let jar = jar_path()
            .ok_or_else(|| anyhow!("elia-jvm-bridge jar not found (set ELIA_JVM_BRIDGE_JAR)"))?;
        let java = java_bin();
        let mut child = Command::new(&java)
            .arg("-jar")
            .arg(&jar)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to start '{java} -jar {}'", jar.display()))?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout =
            BufReader::new(child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?).lines();
        Ok(Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))?;

        let deadline = std::time::Duration::from_secs(30);
        // A stalled bridge (full stdin pipe buffer) must not hang this write
        // forever — that would hold the outer `proc` lock and block every
        // subsequent `jvm.*` call. Same timeout budget as the read side below.
        let stdin = &mut self.stdin;
        tokio::time::timeout(deadline, async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        })
        .await
        .context("jvm bridge timed out writing request")?
        .context("write to jvm bridge")?;

        // The bridge answers one request at a time and echoes our id.
        loop {
            let next = tokio::time::timeout(deadline, self.stdout.next_line())
                .await
                .context("jvm bridge timed out")?
                .context("jvm bridge stdout error")?;
            let Some(text) = next else {
                return Err(anyhow!("jvm bridge closed its output"));
            };
            if text.trim().is_empty() {
                continue;
            }
            let msg: Value = serde_json::from_str(&text).context("jvm bridge sent invalid JSON")?;
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(anyhow!("jvm bridge error: {err}"));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

fn jar_path() -> Option<PathBuf> {
    std::env::var_os("ELIA_JVM_BRIDGE_JAR")
        .map(PathBuf::from)
        .filter(|p| p.exists())
}

fn java_bin() -> String {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let exe = if cfg!(windows) { "java.exe" } else { "java" };
        let candidate = Path::new(&home).join("bin").join(exe);
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "java".to_string()
}
