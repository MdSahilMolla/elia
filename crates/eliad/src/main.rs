//! `eliad` — Elia's resident daemon.
//!
//! One per user per machine. The Elia CLI (`src/daemon/client.ts`) spawns it on
//! demand, talks newline-delimited JSON over a named pipe / unix socket (see
//! `socket.rs` and `transport.rs`), and replaces it when the reported protocol
//! version does not match. Everything it does has an in-process fallback on the
//! TypeScript side, so a daemon that will not start is never fatal.

mod auth;
mod jvm;
mod killtree;
mod mcp;
mod protocol;
mod server;
mod shell;
mod socket;
mod transport;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::server::{idle_watchdog, serve_connection, shell_reap_loop, AppState};

const DEFAULT_IDLE_SECS: u64 = 900;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!(
            "eliad {} (protocol {})",
            env!("CARGO_PKG_VERSION"),
            protocol::PROTOCOL_VERSION
        );
        return Ok(());
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("eliad [--idle-timeout <secs>] [--version] [stop]");
        return Ok(());
    }
    if args.iter().any(|a| a == "--print-address") {
        println!("{}", socket::address());
        return Ok(());
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    if args.first().map(String::as_str) == Some("stop") {
        return rt.block_on(send_shutdown());
    }

    let idle_secs = parse_flag(&args, "--idle-timeout").unwrap_or(DEFAULT_IDLE_SECS);
    rt.block_on(run(idle_secs))
}

/// Whether to keep an accepted connection. Linux checks `SO_PEERCRED` so a
/// sibling user is dropped before negotiation; elsewhere there is no portable
/// syscall, so the permission layers are the gate.
#[cfg(unix)]
fn keep_peer(conn: &tokio::net::UnixStream) -> bool {
    crate::socket::peer_is_same_user(conn)
}

#[cfg(windows)]
fn keep_peer<T>(_conn: &T) -> bool {
    true
}

fn parse_flag(args: &[String], flag: &str) -> Option<u64> {
    let pos = args.iter().position(|a| a == flag)?;
    args.get(pos + 1)?.parse().ok()
}

async fn run(idle_secs: u64) -> Result<()> {
    let addr = socket::address();

    // Single-instance: if a daemon already answers, step aside.
    if daemon_responds(&addr).await {
        eprintln!("eliad: another instance is already listening on {addr}");
        return Ok(());
    }

    let mut listener =
        transport::Listener::bind(&addr).context("failed to bind the daemon socket")?;
    // We won the bind, so this token is authoritative: generate/refresh the
    // socket-side file now, after the loser of a spawn race has already exited.
    let expected_token = auth::server_token();
    let state = Arc::new(AppState::new());
    println!(
        "eliad {} listening (pid {})",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    );

    let watchdog = tokio::spawn(idle_watchdog(state.clone(), idle_secs));
    let shell_reaper = tokio::spawn(shell_reap_loop(state.clone()));
    let accept_state = state.clone();
    let acceptor = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok(conn) => {
                    // SO_PEERCRED (Linux): a sibling user connecting to our
                    // 0600 socket is dropped without a single byte written.
                    // Other platforms have no portable equivalent; the 0700 dir
                    // / 0600 file / token layers carry that weight instead.
                    if keep_peer(&conn) {
                        let token = expected_token.clone();
                        tokio::spawn(serve_connection(accept_state.clone(), conn, token));
                    }
                }
                Err(err) => {
                    eprintln!("eliad: accept error: {err}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        }
    });

    // Ctrl-C is a convenience for a foreground daemon. When spawned detached by
    // the CLI there is no console to register a handler against and `ctrl_c()`
    // resolves immediately with an error — which must NOT be read as "shut down".
    let interrupt = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        _ = state.shutdown.notified() => {}
        _ = interrupt => {}
    }

    acceptor.abort();
    watchdog.abort();
    shell_reaper.abort();
    transport::cleanup(&addr);
    Ok(())
}

async fn send_shutdown() -> Result<()> {
    let addr = socket::address();
    let stream = transport::connect(&addr)
        .await
        .context("no daemon to stop")?;
    let (r, mut w) = tokio::io::split(stream);
    let request = format!(
        "{{\"id\":1,\"method\":\"daemon.shutdown\",\"params\":{{\"token\":\"{}\"}}}}\n",
        auth::server_token()
    );
    w.write_all(request.as_bytes()).await?;
    w.flush().await?;
    let mut lines = BufReader::new(r).lines();
    let _ = tokio::time::timeout(Duration::from_secs(3), lines.next_line()).await;
    println!("eliad: shutdown requested");
    Ok(())
}

/// Connect-and-ping, used only for the single-instance check.
///
/// Responses are matched by id rather than taken as "the first line": the
/// server answers requests concurrently, so on a shared connection a response
/// can arrive out of order. This connection is private and carries one
/// request, but matching by id (and on `result.pong`, not a substring anywhere
/// in the line, which an error message could contain) keeps a live daemon from
/// ever looking dead, or a non-daemon from looking alive.
async fn daemon_responds(addr: &str) -> bool {
    const PING_ID: u64 = 1;
    let Ok(stream) = transport::connect(addr).await else {
        return false;
    };
    let (r, mut w) = tokio::io::split(stream);
    let ping = format!(
        "{{\"id\":{PING_ID},\"method\":\"daemon.ping\",\"params\":{{\"token\":\"{}\"}}}}\n",
        auth::server_token()
    );
    if w.write_all(ping.as_bytes()).await.is_err() {
        return false;
    }
    let _ = w.flush().await;
    let mut lines = BufReader::new(r).lines();
    let wait_for_pong = async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(answer) = pong_answer(&line, PING_ID) {
                return answer;
            }
        }
        false
    };
    tokio::time::timeout(Duration::from_secs(2), wait_for_pong)
        .await
        .unwrap_or(false)
}

/// `Some(is_pong)` if `line` is the response to request `id`, `None` if it is
/// some other line (another id, or not JSON) to skip.
fn pong_answer(line: &str, id: u64) -> Option<bool> {
    let msg: serde_json::Value = serde_json::from_str(line).ok()?;
    if msg.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
        return None;
    }
    Some(msg.pointer("/result/pong") == Some(&serde_json::Value::Bool(true)))
}

#[cfg(test)]
mod tests {
    use super::pong_answer;

    #[test]
    fn the_ping_is_matched_by_id_not_by_line_order() {
        assert_eq!(
            pong_answer(r#"{"id":1,"result":{"pong":true}}"#, 1),
            Some(true)
        );
        // Another request's response, or noise, is skipped rather than decisive.
        assert_eq!(pong_answer(r#"{"id":9,"result":{"ok":true}}"#, 1), None);
        assert_eq!(pong_answer("not json", 1), None);
        // An error that merely mentions "pong" is not a pong.
        assert_eq!(
            pong_answer(r#"{"id":1,"error":{"code":-1,"message":"no pong"}}"#, 1),
            Some(false)
        );
    }
}
