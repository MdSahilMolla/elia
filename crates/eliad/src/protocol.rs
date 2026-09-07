//! The wire protocol between the Elia CLI (TypeScript, `src/daemon/`) and this
//! daemon. One framing: newline-delimited JSON, one message per line. One
//! envelope, mirrored field-for-field in `src/daemon/types.ts`.
//!
//! Keep this file and `src/daemon/types.ts` in lockstep, and bump
//! [`PROTOCOL_VERSION`] on any breaking change — the client checks it on connect
//! and replaces a daemon that does not match.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped on any breaking change to a method's params or result shape. The
/// client refuses a daemon whose `daemon.info` reports a different value and
/// spawns a replacement.
pub const PROTOCOL_VERSION: u32 = 1;

/// A request from the client. `id` is echoed back on the matching response;
/// notifications (no response wanted) use `id == 0`.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, code: i32, message: impl Into<String>) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
            }),
        }
    }
}

/// Error codes. Negative codes are transport/daemon problems the client should
/// treat as "fall back to the in-process path"; a shell command that exits
/// non-zero is a *successful* RPC with `exit_code != 0`, never an error here.
pub mod codes {
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    #[allow(dead_code)] // part of the documented protocol; not yet emitted
    pub const INTERNAL: i32 = -32603;
    pub const SHELL_SPAWN_FAILED: i32 = -32000;
}

// ---- daemon.info ----

#[derive(Debug, Serialize)]
pub struct DaemonInfo {
    pub version: &'static str,
    pub protocol: u32,
    pub pid: u32,
    pub uptime_ms: u64,
    /// Number of live persistent shell workers.
    pub shell_workers: usize,
}

// ---- shell.exec ----

#[derive(Debug, Deserialize)]
pub struct ShellExecParams {
    pub command: String,
    /// Absolute directory to run in. The worker `cd`s here before every command
    /// so a `cd` inside one command never leaks into the next.
    pub cwd: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_timeout_ms() -> u64 {
    60_000
}

#[derive(Debug, Serialize)]
pub struct ShellExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
    pub timed_out: bool,
}

// ---- shell.cancel ----

#[derive(Debug, Deserialize)]
pub struct ShellCancelParams {
    /// The `id` of the in-flight `shell.exec` request to abort.
    pub target: u64,
}
