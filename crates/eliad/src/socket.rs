//! Where the daemon listens. One daemon per user per machine; every request
//! carries its own `cwd`, so one daemon serves every repo. `src/daemon/client.ts`
//! computes the identical address.
//!
//! - Windows: a named pipe, `\\.\pipe\elia-eliad-<user>`
//! - Unix: a socket file at `${XDG_RUNTIME_DIR:-~/.elia}/eliad-<user>.sock`
//!
//! `ELIA_ELIAD_SOCKET` overrides it: a bare pipe name on Windows, a full path
//! elsewhere (tests point it at a scratch location).

#[cfg(not(windows))]
use std::path::PathBuf;

fn user_tag() -> String {
    let tag: String = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if tag.is_empty() {
        "default".to_string()
    } else {
        tag
    }
}

/// The address to bind / dial, honouring `ELIA_ELIAD_SOCKET`.
pub fn address() -> String {
    if let Ok(explicit) = std::env::var("ELIA_ELIAD_SOCKET") {
        #[cfg(windows)]
        {
            return if explicit.starts_with(r"\\") {
                explicit
            } else {
                format!(r"\\.\pipe\{explicit}")
            };
        }
        #[cfg(not(windows))]
        {
            return explicit;
        }
    }
    let tag = user_tag();
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\elia-eliad-{tag}")
    }
    #[cfg(not(windows))]
    {
        let dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".elia")
            });
        dir.join(format!("eliad-{tag}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}
