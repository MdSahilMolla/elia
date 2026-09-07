//! Resident supervisor for stdio MCP servers.
//!
//! Each configured server (`command` + `args` + `env`) is spawned once and kept
//! alive for the life of the daemon — so a cold `elia agent` never re-pays the
//! spawn + `initialize` + `tools/list` handshake that a `npx some-mcp-server`
//! costs. The TypeScript side (`src/mcp/registry.ts`) still parses the config;
//! it hands the resolved server list here via `mcp.ensure` and proxies tool
//! calls through `mcp.call`.
//!
//! HTTP connectors are not handled here — they stay on the in-process path.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const PROTOCOL_VERSION: &str = "2024-11-05";
const CALL_TIMEOUT_SECS: u64 = 120;
const HANDSHAKE_TIMEOUT_SECS: u64 = 30;

#[derive(Clone, Debug, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

impl McpServerConfig {
    fn fingerprint(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.command.hash(&mut h);
        self.args.hash(&mut h);
        let mut env: Vec<_> = self.env.iter().collect();
        env.sort();
        for (k, v) in env {
            k.hash(&mut h);
            v.hash(&mut h);
        }
        h.finish()
    }
}

#[derive(Clone, Serialize)]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Serialize)]
pub struct McpEnsureResult {
    pub tools: Vec<McpToolInfo>,
    /// Servers that failed to start / handshake, with the reason.
    pub failed: Vec<McpFailure>,
}

#[derive(Serialize)]
pub struct McpFailure {
    pub server: String,
    pub reason: String,
}

struct ServerHandle {
    fingerprint: u64,
    tools: Vec<McpToolInfo>,
    proc: Mutex<McpProc>,
}

pub struct McpSupervisor {
    servers: Mutex<HashMap<String, Arc<ServerHandle>>>,
}

impl McpSupervisor {
    pub fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }

    pub async fn server_count(&self) -> usize {
        self.servers.lock().await.len()
    }

    /// Start any server in `configs` that is not already running with the same
    /// config, and return the union of every running server's tools.
    pub async fn ensure(&self, configs: Vec<McpServerConfig>) -> McpEnsureResult {
        let mut map = self.servers.lock().await;
        let mut tools = Vec::new();
        let mut failed = Vec::new();
        let wanted: std::collections::HashSet<&str> =
            configs.iter().map(|c| c.name.as_str()).collect();

        // Drop servers no longer in the config.
        map.retain(|name, _| wanted.contains(name.as_str()));

        for config in &configs {
            let fp = config.fingerprint();
            if let Some(existing) = map.get(&config.name) {
                if existing.fingerprint == fp {
                    tools.extend(existing.tools.iter().cloned());
                    continue;
                }
            }
            match start_server(config).await {
                Ok(handle) => {
                    tools.extend(handle.tools.iter().cloned());
                    map.insert(config.name.clone(), Arc::new(handle));
                }
                Err(err) => {
                    map.remove(&config.name);
                    failed.push(McpFailure {
                        server: config.name.clone(),
                        reason: err.to_string(),
                    });
                }
            }
        }

        McpEnsureResult { tools, failed }
    }

    /// Proxy a `tools/call` to a running server.
    pub async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<Value> {
        let handle = {
            let map = self.servers.lock().await;
            map.get(server)
                .cloned()
                .ok_or_else(|| anyhow!("mcp server '{server}' is not running"))?
        };
        let mut proc = handle.proc.lock().await;
        match proc
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
                CALL_TIMEOUT_SECS,
            )
            .await
        {
            Ok(value) => Ok(value),
            Err(err) => Err(err),
        }
    }
}

async fn start_server(config: &McpServerConfig) -> Result<ServerHandle> {
    let mut proc = McpProc::spawn(config).await?;

    proc.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "elia-eliad", "version": env!("CARGO_PKG_VERSION") }
        }),
        HANDSHAKE_TIMEOUT_SECS,
    )
    .await
    .context("mcp initialize")?;

    proc.notify("notifications/initialized", json!({})).await?;

    let listed = proc
        .request("tools/list", json!({}), HANDSHAKE_TIMEOUT_SECS)
        .await
        .context("mcp tools/list")?;

    let tools = listed
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(McpToolInfo {
                        server: config.name.clone(),
                        name: t.get("name")?.as_str()?.to_string(),
                        description: t
                            .get("description")
                            .and_then(Value::as_str)
                            .map(String::from),
                        input_schema: t.get("inputSchema").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(ServerHandle {
        fingerprint: config.fingerprint(),
        tools,
        proc: Mutex::new(proc),
    })
}

/// One MCP server process, framed as newline-delimited JSON-RPC 2.0.
struct McpProc {
    child: Child,
    stdin: ChildStdin,
    stdout: tokio::io::Lines<BufReader<ChildStdout>>,
    next_id: i64,
}

impl Drop for McpProc {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

impl McpProc {
    async fn spawn(config: &McpServerConfig) -> Result<Self> {
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn mcp server '{}'", config.command))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout =
            BufReader::new(child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?).lines();
        Ok(Self {
            child,
            stdin,
            stdout,
            next_id: 0,
        })
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0", "method": method, "params": params
        }))?;
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: Value, timeout_secs: u64) -> Result<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))?;
        self.stdin
            .write_all(line.as_bytes())
            .await
            .context("write to mcp server")?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;

        let deadline = std::time::Duration::from_secs(timeout_secs);
        loop {
            let next = tokio::time::timeout(deadline, self.stdout.next_line())
                .await
                .with_context(|| format!("mcp server timed out on {method}"))?
                .context("mcp server stdout error")?;
            let Some(text) = next else {
                return Err(anyhow!("mcp server closed its output"));
            };
            if text.trim().is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue, // some servers print noise to stdout; skip it
            };
            // Skip notifications and responses to other ids.
            if msg.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(anyhow!("mcp error: {err}"));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_fixture() -> Option<McpServerConfig> {
        let bun = which_bun()?;
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/mcp/fixtures/echoServer.ts");
        if !script.exists() {
            return None;
        }
        Some(McpServerConfig {
            name: "echofix".into(),
            command: bun,
            args: vec!["run".into(), script.to_string_lossy().into_owned()],
            env: HashMap::new(),
        })
    }

    fn which_bun() -> Option<String> {
        for name in ["bun", "bun.exe"] {
            if std::process::Command::new(name)
                .arg("--version")
                .output()
                .is_ok()
            {
                return Some(name.into());
            }
        }
        None
    }

    #[tokio::test]
    async fn ensure_then_call_a_resident_stdio_server() {
        let Some(config) = echo_fixture() else {
            eprintln!("skipping: bun or the echo fixture is unavailable");
            return;
        };
        let supervisor = McpSupervisor::new();

        let result = supervisor.ensure(vec![config.clone()]).await;
        assert!(
            result.failed.is_empty(),
            "{:?}",
            result.failed.first().map(|f| &f.reason)
        );
        let mut names: Vec<_> = result.tools.iter().map(|t| t.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["echo", "explode"]);

        // Idempotent: a second ensure with the same config reuses the process.
        assert_eq!(supervisor.ensure(vec![config]).await.tools.len(), 2);
        assert_eq!(supervisor.server_count().await, 1);

        let echoed = supervisor
            .call("echofix", "echo", json!({ "text": "hello-from-rust" }))
            .await
            .expect("call ok");
        assert!(serde_json::to_string(&echoed)
            .unwrap()
            .contains("hello-from-rust"));
    }

    #[tokio::test]
    async fn a_server_that_will_not_start_is_reported_not_fatal() {
        let supervisor = McpSupervisor::new();
        let result = supervisor
            .ensure(vec![McpServerConfig {
                name: "nope".into(),
                command: "definitely-not-a-real-binary-xyz".into(),
                args: vec![],
                env: HashMap::new(),
            }])
            .await;
        assert_eq!(result.tools.len(), 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].server, "nope");
    }
}
