//! Accept loop and request dispatch.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

use crate::auth;
use crate::jvm::JvmBridge;
use crate::mcp::McpSupervisor;
use crate::protocol::{
    codes, DaemonInfo, McpCallParams, McpEnsureParams, ParseCheckParams, Request, Response,
    ShellCancelParams, ShellExecParams, ShellExecResult, PROTOCOL_VERSION,
};
use crate::shell::{ExecStop, ShellPool, SHELL_IDLE_SECS};

pub struct AppState {
    pub started: Instant,
    pub shell: ShellPool,
    pub jvm: JvmBridge,
    pub mcp: McpSupervisor,
    /// In-flight `shell.exec` requests, keyed by request id, each with a sender
    /// that cancels it when `shell.cancel` arrives.
    in_flight: Mutex<HashMap<u64, oneshot::Sender<()>>>,
    /// Bumped whenever a request arrives; the idle watchdog reads it.
    pub last_activity: Mutex<Instant>,
    pub shutdown: Notify,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            shell: ShellPool::new(),
            jvm: JvmBridge::new(),
            mcp: McpSupervisor::new(),
            in_flight: Mutex::new(HashMap::new()),
            last_activity: Mutex::new(Instant::now()),
            shutdown: Notify::new(),
        }
    }

    pub async fn in_flight_count(&self) -> usize {
        self.in_flight.lock().await.len()
    }

    async fn touch(&self) {
        *self.last_activity.lock().await = Instant::now();
    }
}

/// Handle one client connection. `S` is a split-able duplex stream. The first
/// request on the connection must present `expected_token`; a connection that
/// cannot is answered once and dropped without serving anything.
pub async fn serve_connection<S>(state: Arc<AppState>, stream: S, expected_token: String)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);
    let (tx, mut rx) = mpsc::channel::<Response>(64);

    let writer = tokio::spawn(async move {
        while let Some(resp) = rx.recv().await {
            let Ok(mut buf) = serde_json::to_vec(&resp) else {
                continue;
            };
            buf.push(b'\n');
            if write_half.write_all(&buf).await.is_err() {
                break;
            }
            let _ = write_half.flush().await;
        }
    });

    let mut authenticated = false;
    loop {
        let line = match read_request_line(&mut reader, MAX_REQUEST_BYTES).await {
            Ok(Some(RequestLine::Line(line))) => line,
            Ok(Some(RequestLine::TooLong { id })) => {
                let message = format!("request exceeds {MAX_REQUEST_BYTES} bytes");
                let _ = tx
                    .send(Response::err(id, codes::INVALID_PARAMS, message))
                    .await;
                continue;
            }
            Ok(None) | Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(err) => {
                let _ = tx
                    .send(Response::err(0, codes::INVALID_PARAMS, err.to_string()))
                    .await;
                continue;
            }
        };
        if !authenticated {
            if !request_presents_token(&req, &expected_token) {
                let _ = tx
                    .send(Response::err(
                        req.id,
                        codes::UNAUTHORIZED,
                        "missing or invalid daemon token",
                    ))
                    .await;
                break;
            }
            authenticated = true;
        }
        state.touch().await;
        let state = state.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let resp = dispatch(state, req).await;
            if let Some(resp) = resp {
                let _ = tx.send(resp).await;
            }
        });
    }

    drop(tx);
    let _ = writer.await;
}

/// Whether `req.params.token` matches `expected` in constant time.
fn request_presents_token(req: &Request, expected: &str) -> bool {
    req.params
        .get("token")
        .and_then(Value::as_str)
        .is_some_and(|token| auth::constant_time_eq(token, expected))
}

/// Largest request line accepted. `parse.check` carries a whole file's source,
/// so this is generous, but it is a ceiling: a multi-GB line used to be
/// buffered whole before anything looked at it (the request-side twin of
/// M-26's per-line shell capture bound).
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

enum RequestLine {
    Line(String),
    /// Over the cap and discarded; `id` is recovered from the line's start
    /// (the client writes `{"id":N,…` first) so the caller gets a matching
    /// error instead of waiting out its timeout. 0 if it could not be read.
    TooLong {
        id: u64,
    },
}

/// Read one request line of at most `max` bytes. An over-long line is drained
/// to its `\n` without being kept, so the next request still frames correctly.
/// `Ok(None)` at EOF.
async fn read_request_line<R>(reader: &mut R, max: usize) -> std::io::Result<Option<RequestLine>>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            if line.is_empty() && !too_long {
                return Ok(None);
            }
            break;
        }
        let (piece, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(nl) => (nl, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            if line.len() + piece > max {
                too_long = true;
                // Keep just enough of the start to recover the id.
                let keep = 64usize.saturating_sub(line.len()).min(piece);
                line.extend_from_slice(&chunk[..keep]);
            } else {
                line.extend_from_slice(&chunk[..piece]);
            }
        }
        reader.consume(if done { piece + 1 } else { piece });
        if done {
            break;
        }
    }
    if too_long {
        return Ok(Some(RequestLine::TooLong {
            id: leading_id(&line),
        }));
    }
    Ok(Some(RequestLine::Line(
        String::from_utf8(line)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
    )))
}

/// The `id` from the start of a request line like `{"id":42,"method":…`.
fn leading_id(prefix: &[u8]) -> u64 {
    let text = String::from_utf8_lossy(prefix);
    let Some(at) = text.find("\"id\"") else {
        return 0;
    };
    let rest = text[at + 4..].trim_start();
    let Some(rest) = rest.strip_prefix(':') else {
        return 0;
    };
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().unwrap_or(0)
}

async fn dispatch(state: Arc<AppState>, req: Request) -> Option<Response> {
    let id = req.id;
    match req.method.as_str() {
        "daemon.info" => Some(Response::ok(id, daemon_info(&state).await)),
        "daemon.ping" => Some(Response::ok(id, json!({ "pong": true }))),
        "daemon.shutdown" => {
            state.shutdown.notify_waiters();
            Some(Response::ok(id, json!({ "ok": true })))
        }
        "shell.exec" => Some(shell_exec(state, id, req.params).await),
        "parse.check" => Some(parse_check(id, req.params)),
        "jvm.check" | "jvm.info" => Some(jvm_forward(state, id, &req.method, req.params).await),
        "mcp.ensure" => Some(mcp_ensure(state, id, req.params).await),
        "mcp.call" => Some(mcp_call(state, id, req.params).await),
        "shell.cancel" => match serde_json::from_value::<ShellCancelParams>(req.params) {
            Ok(params) => {
                if let Some(sender) = state.in_flight.lock().await.remove(&params.target) {
                    let _ = sender.send(());
                }
                Some(Response::ok(id, json!({ "ok": true })))
            }
            Err(err) => Some(Response::err(id, codes::INVALID_PARAMS, err.to_string())),
        },
        other => Some(Response::err(
            id,
            codes::METHOD_NOT_FOUND,
            format!("unknown method: {other}"),
        )),
    }
}

async fn daemon_info(state: &AppState) -> Value {
    let info = DaemonInfo {
        version: env!("CARGO_PKG_VERSION"),
        protocol: PROTOCOL_VERSION,
        pid: std::process::id(),
        uptime_ms: state.started.elapsed().as_millis() as u64,
        shell_workers: state.shell.worker_count().await,
        jvm_available: JvmBridge::available(),
        mcp_servers: state.mcp.server_count().await,
    };
    serde_json::to_value(info).unwrap_or(Value::Null)
}

async fn shell_exec(state: Arc<AppState>, id: u64, params: Value) -> Response {
    let params: ShellExecParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => return Response::err(id, codes::INVALID_PARAMS, err.to_string()),
    };

    let (cancel_tx, cancel_rx) = oneshot::channel();
    if id != 0 {
        state.in_flight.lock().await.insert(id, cancel_tx);
    }

    let outcome = state
        .shell
        .exec(&params.command, &params.cwd, params.timeout_ms, cancel_rx)
        .await;

    if id != 0 {
        state.in_flight.lock().await.remove(&id);
    }

    match outcome {
        Ok(Ok(res)) => {
            let payload = ShellExecResult {
                exit_code: res.exit_code,
                stdout: res.stdout,
                stderr: res.stderr,
                elapsed_ms: res.elapsed_ms,
                timed_out: res.timed_out,
            };
            Response::ok(id, serde_json::to_value(payload).unwrap_or(Value::Null))
        }
        Ok(Err(ExecStop::Cancelled)) => {
            let payload = ShellExecResult {
                exit_code: 130,
                stdout: String::new(),
                stderr: "cancelled by operator".into(),
                elapsed_ms: 0,
                timed_out: false,
            };
            Response::ok(id, serde_json::to_value(payload).unwrap_or(Value::Null))
        }
        Err(err) if err.to_string().contains("__elia_timeout__") => {
            let payload = ShellExecResult {
                exit_code: 124,
                stdout: String::new(),
                stderr: "timed out (killed)".into(),
                elapsed_ms: params.timeout_ms,
                timed_out: true,
            };
            Response::ok(id, serde_json::to_value(payload).unwrap_or(Value::Null))
        }
        Err(err) => Response::err(id, codes::SHELL_SPAWN_FAILED, err.to_string()),
    }
}

async fn jvm_forward(state: Arc<AppState>, id: u64, method: &str, params: Value) -> Response {
    match state.jvm.call(method, params).await {
        Ok(result) => Response::ok(id, result),
        Err(err) => Response::err(id, codes::INTERNAL, err.to_string()),
    }
}

async fn mcp_ensure(state: Arc<AppState>, id: u64, params: Value) -> Response {
    let params: McpEnsureParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => return Response::err(id, codes::INVALID_PARAMS, err.to_string()),
    };
    let result = state.mcp.ensure(params.servers).await;
    Response::ok(id, serde_json::to_value(result).unwrap_or(Value::Null))
}

async fn mcp_call(state: Arc<AppState>, id: u64, params: Value) -> Response {
    let params: McpCallParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => return Response::err(id, codes::INVALID_PARAMS, err.to_string()),
    };
    match state
        .mcp
        .call(&params.server, &params.tool, params.arguments)
        .await
    {
        Ok(result) => Response::ok(id, result),
        Err(err) => Response::err(id, codes::INTERNAL, err.to_string()),
    }
}

fn parse_check(id: u64, params: Value) -> Response {
    let params: ParseCheckParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => return Response::err(id, codes::INVALID_PARAMS, err.to_string()),
    };
    let lang = params
        .language
        .as_deref()
        .and_then(elia_parse::Language::from_hint)
        .unwrap_or_else(|| elia_parse::Language::from_path(&params.path));
    let result = elia_parse::check(&params.source, lang);
    Response::ok(id, serde_json::to_value(result).unwrap_or(Value::Null))
}

/// Ticks every 30s; shuts the daemon down once it has been idle (no requests,
/// nothing in flight) for `idle_secs`.
pub async fn idle_watchdog(state: Arc<AppState>, idle_secs: u64) {
    if idle_secs == 0 {
        return;
    }
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let idle_for = state.last_activity.lock().await.elapsed().as_secs();
        if idle_for >= idle_secs && state.in_flight_count().await == 0 {
            state.shutdown.notify_waiters();
            return;
        }
    }
}

/// Ticks every 60s; evicts shell workers that have been idle past
/// `SHELL_IDLE_SECS`, independent of `idle_watchdog` above — a directory that
/// goes quiet must not keep its worker processes alive just because the
/// daemon as a whole is still busy with other directories.
pub async fn shell_reap_loop(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        state
            .shell
            .reap_idle(Duration::from_secs(SHELL_IDLE_SECS))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{socket, transport};

    /// Bind a real listener on a scratch address, run the accept loop, and
    /// return the address, the shared token, and a shutdown signal.
    async fn spawn_server() -> (String, String, Arc<AppState>) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        // A unique scratch address per test — pid + monotonic seq + clock.
        let tag = format!(
            "elia-eliad-srvtest-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed),
            fastrand_like(),
        );
        let addr = if cfg!(windows) {
            format!(r"\\.\pipe\{tag}")
        } else {
            std::env::temp_dir()
                .join(format!("{tag}.sock"))
                .to_string_lossy()
                .into_owned()
        };
        let mut listener = transport::Listener::bind(&addr).expect("bind scratch listener");
        let state = Arc::new(AppState::new());
        let token = auth::generate();
        let accept_state = state.clone();
        let accept_token = token.clone();
        tokio::spawn(async move {
            while let Ok(conn) = listener.accept().await {
                tokio::spawn(serve_connection(
                    accept_state.clone(),
                    conn,
                    accept_token.clone(),
                ));
            }
        });
        (addr, token, state)
    }

    fn fastrand_like() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    }

    async fn call(addr: &str, request: &str) -> Value {
        let stream = transport::connect(addr).await.expect("connect");
        let (r, mut w) = tokio::io::split(stream);
        w.write_all(request.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
        let mut lines = BufReader::new(r).lines();
        let line = tokio::time::timeout(std::time::Duration::from_secs(20), lines.next_line())
            .await
            .expect("response within 20s")
            .expect("read ok")
            .expect("a line");
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn daemon_info_reports_protocol_version() {
        let (addr, token, _state) = spawn_server().await;
        let res = call(
            &addr,
            &format!(r#"{{"id":1,"method":"daemon.info","params":{{"token":"{token}"}}}}"#),
        )
        .await;
        assert_eq!(res["id"], 1);
        assert_eq!(res["result"]["protocol"], PROTOCOL_VERSION);
        transport::cleanup(&addr);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shell_exec_runs_a_command() {
        let (addr, token, _state) = spawn_server().await;
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .replace('\\', "\\\\");
        let req = format!(
            r#"{{"id":7,"method":"shell.exec","params":{{"command":"echo daemon-e2e","cwd":"{cwd}","timeout_ms":20000,"token":"{token}"}}}}"#
        );
        let res = call(&addr, &req).await;
        assert_eq!(res["id"], 7);
        assert_eq!(res["result"]["exit_code"], 0);
        assert!(res["result"]["stdout"]
            .as_str()
            .unwrap()
            .contains("daemon-e2e"));
        transport::cleanup(&addr);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_method_is_an_error_not_a_panic() {
        let (addr, token, _state) = spawn_server().await;
        let res = call(
            &addr,
            &format!(r#"{{"id":2,"method":"nope.nope","params":{{"token":"{token}"}}}}"#),
        )
        .await;
        assert_eq!(res["error"]["code"], codes::METHOD_NOT_FOUND);
        transport::cleanup(&addr);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn parse_check_flags_a_broken_edit() {
        let (addr, token, _state) = spawn_server().await;
        let clean = call(
            &addr,
            &format!(
                r#"{{"id":1,"method":"parse.check","params":{{"source":"export const x = {{ a: 1 }}","path":"a.ts","token":"{token}"}}}}"#
            ),
        )
        .await;
        assert_eq!(clean["result"]["ok"], true);

        let broken = call(
            &addr,
            &format!(
                r#"{{"id":2,"method":"parse.check","params":{{"source":"export function f() {{\n  return 1;\n","path":"a.ts","token":"{token}"}}}}"#
            ),
        )
        .await;
        assert_eq!(broken["result"]["ok"], false);
        assert_eq!(broken["result"]["errors"][0]["message"], "unclosed '{'");
        transport::cleanup(&addr);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_connection_without_the_token_gets_nowhere() {
        let (addr, _token, _state) = spawn_server().await;
        // First request carries no token: answered with UNAUTHORIZED and the
        // connection is closed, so even a guessed method never dispatches.
        let res = call(&addr, r#"{"id":9,"method":"daemon.info","params":{}}"#).await;
        assert_eq!(res["error"]["code"], codes::UNAUTHORIZED);

        // Wrong token: same refusal.
        let bad = call(
            &addr,
            &format!(
                r#"{{"id":10,"method":"daemon.info","params":{{"token":"{}"}}}}"#,
                auth::generate()
            ),
        )
        .await;
        assert_eq!(bad["error"]["code"], codes::UNAUTHORIZED);
        transport::cleanup(&addr);
    }

    #[tokio::test]
    async fn an_oversized_request_is_refused_by_id_and_the_next_one_still_frames() {
        let big = format!(
            "{{\"id\":42,\"method\":\"parse.check\",\"params\":{{\"source\":\"{}\"}}}}\n",
            "x".repeat(200)
        );
        let input = format!("{big}{{\"id\":43,\"method\":\"daemon.ping\"}}\n");
        let mut reader = BufReader::new(input.as_bytes());

        match read_request_line(&mut reader, 100).await.unwrap() {
            Some(RequestLine::TooLong { id }) => assert_eq!(id, 42),
            _ => panic!("expected TooLong"),
        }
        match read_request_line(&mut reader, 100).await.unwrap() {
            Some(RequestLine::Line(line)) => assert!(line.contains("\"id\":43"), "{line}"),
            _ => panic!("expected the next request intact"),
        }
        assert!(read_request_line(&mut reader, 100).await.unwrap().is_none());
    }

    #[test]
    fn leading_id_reads_the_id_or_falls_back_to_zero() {
        assert_eq!(leading_id(br#"{"id":7,"method":"x"}"#), 7);
        assert_eq!(leading_id(br#"{ "id" : 12 , "#), 12);
        assert_eq!(leading_id(br#"{"method":"x"}"#), 0);
    }

    #[test]
    fn address_matches_the_documented_scheme() {
        std::env::remove_var("ELIA_ELIAD_SOCKET");
        let addr = socket::address();
        if cfg!(windows) {
            assert!(addr.starts_with(r"\\.\pipe\elia-eliad-"));
        } else {
            assert!(addr.ends_with(".sock"));
        }
    }
}
