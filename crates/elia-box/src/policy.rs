//! The policy a sandboxed run is held to, and its validation.
//!
//! A policy is data, not code: the caller (elia) states what a run may read,
//! write, reach and consume, and the backend either enforces that or refuses to
//! start. Nothing here widens by default.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Files inside a writable workspace that later steer the host rather than the
/// run itself: git hooks and config execute or redirect on the user's next `git`
/// call, and `.elia` holds elia's own trust state. A run may read them but never
/// change them, so a writable tree is not a way to plant code outside the box.
pub fn protected_paths(run_dir: &Path) -> Vec<PathBuf> {
    vec![run_dir.join(".git").join("hooks"), run_dir.join(".git").join("config"), run_dir.join(".elia")]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Auto,
    Seatbelt,
    Docker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Run against the real workspace; the sandbox bounds what the command can reach.
    #[default]
    Inplace,
    /// Run against a copy-on-write clone; the original is never touched and the
    /// receipt lists what the run changed.
    Fork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NetMode {
    /// No network of any kind.
    #[default]
    None,
    /// Only through the egress broker, to allowlisted hosts; every attempt is recorded.
    Brokered,
    /// Unrestricted host network. Recorded in the receipt as not enforced.
    Open,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Network {
    #[serde(default)]
    pub mode: NetMode,
    #[serde(default)]
    pub allow: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Limits {
    pub wall_ms: u64,
    pub cpu_seconds: Option<u64>,
    pub memory_mb: u64,
    pub pids: u64,
    pub file_size_mb: u64,
    pub open_files: u64,
    /// Cap on captured stdout and on captured stderr, each.
    pub output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            wall_ms: 120_000,
            cpu_seconds: None,
            memory_mb: 2048,
            pids: 512,
            file_size_mb: 512,
            open_files: 1024,
            output_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub backend: Backend,
    pub workspace: PathBuf,
    #[serde(default)]
    pub mode: Mode,
    /// Extra paths the run may read (tool installs, caches). Read-only.
    #[serde(default)]
    pub read_paths: Vec<PathBuf>,
    /// Extra paths the run may write. Prefer none.
    #[serde(default)]
    pub write_paths: Vec<PathBuf>,
    #[serde(default)]
    pub network: Network,
    #[serde(default)]
    pub limits: Limits,
    /// Environment given to the command. The host environment is NOT inherited.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Names of host variables to pass through by value (never secrets by default).
    #[serde(default)]
    pub env_passthrough: Vec<String>,
    /// Record a before/after manifest of the workspace. Defaults on for fork mode.
    #[serde(default)]
    pub snapshot: Option<bool>,
    /// Base names skipped by the manifest.
    #[serde(default = "default_excludes")]
    pub exclude: Vec<String>,
    /// Docker image (docker backend only).
    #[serde(default)]
    pub image: Option<String>,
    /// Keep the fork after the run and report its path.
    #[serde(default)]
    pub keep_fork: bool,
}

fn one() -> u32 {
    1
}

fn default_excludes() -> Vec<String> {
    vec!["node_modules".into(), "target".into(), ".DS_Store".into()]
}

pub const DEFAULT_IMAGE: &str = "elia-box-base:latest";

impl Policy {
    pub fn parse(json: &str) -> Result<Policy> {
        let p: Policy = serde_json::from_str(json).map_err(|e| anyhow!("invalid policy: {e}"))?;
        if p.version != 1 {
            bail!("unsupported policy version {}", p.version);
        }
        Ok(p)
    }

    pub fn wants_snapshot(&self) -> bool {
        self.snapshot.unwrap_or(self.mode == Mode::Fork)
    }

    pub fn image(&self) -> &str {
        self.image.as_deref().unwrap_or(DEFAULT_IMAGE)
    }

    /// Validate and canonicalize every path. Returns a policy whose paths are all
    /// absolute and symlink-free, so that what is enforced is what was checked.
    pub fn resolve(mut self) -> Result<Policy> {
        self.workspace = canonical_dir(&self.workspace, "workspace")?;
        refuse_too_broad(&self.workspace, "workspace")?;
        self.read_paths = self
            .read_paths
            .iter()
            .map(|p| {
                let c = canonical_existing(p, "readPaths")?;
                refuse_too_broad(&c, "readPaths")?;
                Ok(c)
            })
            .collect::<Result<_>>()?;
        self.write_paths = self
            .write_paths
            .iter()
            .map(|p| {
                let c = canonical_existing(p, "writePaths")?;
                refuse_too_broad(&c, "writePaths")?;
                Ok(c)
            })
            .collect::<Result<_>>()?;
        for name in self.env.keys().chain(self.env_passthrough.iter()) {
            if name.is_empty() || name.contains('=') || name.contains('\0') {
                bail!("invalid environment variable name {name:?}");
            }
        }
        for host in &self.network.allow {
            if host.is_empty() || host.contains('/') || host.contains(':') || host.contains(char::is_whitespace) {
                bail!("network.allow entries are host patterns like example.com or *.example.com, got {host:?}");
            }
        }
        if self.network.mode != NetMode::Brokered && !self.network.allow.is_empty() {
            bail!("network.allow only applies to network.mode \"brokered\"");
        }
        if self.network.mode == NetMode::Brokered && self.network.allow.is_empty() {
            bail!("network.mode \"brokered\" needs at least one network.allow host; use \"none\" to deny everything");
        }
        let l = &self.limits;
        if l.wall_ms == 0 || l.memory_mb == 0 || l.pids == 0 || l.open_files == 0 || l.file_size_mb == 0 {
            bail!("limits must be positive");
        }
        Ok(self)
    }
}

fn canonical_existing(p: &Path, what: &str) -> Result<PathBuf> {
    if !p.is_absolute() {
        bail!("{what} entries must be absolute paths, got {}", p.display());
    }
    reject_control_chars(p, what)?;
    std::fs::canonicalize(p).map_err(|e| anyhow!("{what} entry {} is not usable: {e}", p.display()))
}

fn canonical_dir(p: &Path, what: &str) -> Result<PathBuf> {
    let c = canonical_existing(p, what)?;
    if !c.is_dir() {
        bail!("{what} {} is not a directory", c.display());
    }
    Ok(c)
}

fn reject_control_chars(p: &Path, what: &str) -> Result<()> {
    let s = p.to_str().ok_or_else(|| anyhow!("{what} path is not valid UTF-8"))?;
    if s.chars().any(|c| c.is_control()) {
        bail!("{what} path contains a control character");
    }
    Ok(())
}

/// A writable or workspace root of `/`, the home directory, or any ancestor of
/// the home directory would put credentials and every other project in reach.
fn refuse_too_broad(p: &Path, what: &str) -> Result<()> {
    if p.parent().is_none() {
        bail!("{what} may not be the filesystem root");
    }
    if let Some(home) = std::env::var_os("HOME").and_then(|h| std::fs::canonicalize(h).ok()) {
        if home.starts_with(p) {
            bail!("{what} {} contains the home directory; choose a project directory", p.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(ws: &Path) -> String {
        format!(r#"{{"workspace":"{}"}}"#, ws.display())
    }

    #[test]
    fn defaults_deny_everything_optional() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let p = Policy::parse(&base(&dir)).unwrap();
        assert_eq!(p.network.mode, NetMode::None);
        assert_eq!(p.mode, Mode::Inplace);
        assert!(p.env.is_empty() && p.env_passthrough.is_empty() && p.write_paths.is_empty());
        assert!(!p.wants_snapshot());
    }

    #[test]
    fn partial_limits_keep_the_other_defaults() {
        let dir = std::env::temp_dir();
        let json = format!(r#"{{"workspace":"{}","limits":{{"wallMs":5}}}}"#, dir.display());
        let p = Policy::parse(&json).unwrap();
        assert_eq!(p.limits.wall_ms, 5);
        assert_eq!(p.limits.memory_mb, Limits::default().memory_mb);
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let dir = std::env::temp_dir();
        let json = format!(r#"{{"workspace":"{}","netwrok":{{}}}}"#, dir.display());
        assert!(Policy::parse(&json).is_err(), "a typo must not silently mean 'no restriction'");
    }

    #[test]
    fn broad_roots_are_refused() {
        assert!(Policy::parse(r#"{"workspace":"/"}"#).unwrap().resolve().is_err());
        if let Some(home) = std::env::var_os("HOME") {
            let json = format!(r#"{{"workspace":{}}}"#, serde_json::to_string(&home.to_string_lossy()).unwrap());
            assert!(Policy::parse(&json).unwrap().resolve().is_err(), "HOME is too broad");
            let parent = Path::new(&home).parent().unwrap();
            let json = format!(r#"{{"workspace":{}}}"#, serde_json::to_string(&parent.to_string_lossy()).unwrap());
            assert!(Policy::parse(&json).unwrap().resolve().is_err(), "an ancestor of HOME is too broad");
        }
    }

    #[test]
    fn network_rules_are_consistent() {
        let ws = std::env::temp_dir().canonicalize().unwrap();
        let mk = |net: &str| Policy::parse(&format!(r#"{{"workspace":"{}","network":{}}}"#, ws.display(), net));
        assert!(mk(r#"{"mode":"brokered"}"#).unwrap().resolve().is_err(), "brokered with no hosts");
        assert!(mk(r#"{"mode":"none","allow":["a.com"]}"#).unwrap().resolve().is_err(), "allow without brokered");
        assert!(mk(r#"{"mode":"brokered","allow":["https://a.com"]}"#).unwrap().resolve().is_err());
        assert!(mk(r#"{"mode":"brokered","allow":["*.pypi.org"]}"#).unwrap().resolve().is_ok());
    }

    #[test]
    fn relative_and_missing_paths_are_refused() {
        let ws = std::env::temp_dir().canonicalize().unwrap();
        let json = format!(r#"{{"workspace":"{}","readPaths":["relative/dir"]}}"#, ws.display());
        assert!(Policy::parse(&json).unwrap().resolve().is_err());
        let json = format!(r#"{{"workspace":"{}","readPaths":["/definitely/not/here"]}}"#, ws.display());
        assert!(Policy::parse(&json).unwrap().resolve().is_err());
    }
}
