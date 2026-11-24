//! Launches the Go egress broker (go/cmd/elia-egress) for a brokered run and folds its
//! log into evidence for the receipt.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

pub fn find_binary() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("ELIA_EGRESS_BIN") {
        return Some(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sib = dir.join("elia-egress");
            if sib.is_file() {
                return Some(sib);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join("elia-egress");
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

pub struct Broker {
    child: Child,
    pub port: u16,
    log: PathBuf,
}

impl Broker {
    pub fn start(allow: &[String], log: &Path) -> Result<Broker> {
        let bin = find_binary().ok_or_else(|| {
            anyhow!("the egress broker (elia-egress) was not found; build it with `go build -o bin/elia-egress ./cmd/elia-egress` in go/ or set ELIA_EGRESS_BIN")
        })?;
        let mut child = Command::new(bin)
            .arg("--allow")
            .arg(allow.join(","))
            .arg("--log")
            .arg(log)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| anyhow!("could not start the egress broker: {e}"))?;
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("piped")).read_line(&mut line)?;
        let v: Value = serde_json::from_str(line.trim()).map_err(|_| {
            let _ = child.kill();
            anyhow!("the egress broker did not report a port")
        })?;
        let addr = v["listening"].as_str().unwrap_or_default();
        let port = addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok());
        match port {
            Some(port) => Ok(Broker {
                child,
                port,
                log: log.to_path_buf(),
            }),
            None => {
                let _ = child.kill();
                bail!("the egress broker reported an unusable address: {addr}")
            }
        }
    }

    pub fn proxy_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Stop the broker and summarise what it saw.
    pub fn finish(mut self) -> Value {
        unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        let _ = self.child.wait();
        summarize(&self.log)
    }
}

fn summarize(log: &Path) -> Value {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let (mut allowed, mut denied) = (0u64, 0u64);
    let mut events: Vec<Value> = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["allowed"].as_bool().unwrap_or(false) {
            allowed += 1;
        } else {
            denied += 1;
        }
        if events.len() < 200 {
            events.push(json!({
                "host": v["host"], "port": v["port"], "method": v["method"],
                "allowed": v["allowed"], "reason": v["reason"],
                "bytesUp": v["bytesUp"], "bytesDown": v["bytesDown"],
            }));
        }
    }
    json!({ "allowed": allowed, "denied": denied, "events": events })
}
