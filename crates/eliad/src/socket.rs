//! Where the daemon listens. One daemon per user per machine; every request
//! carries its own `cwd`, so one daemon serves every repo. `src/daemon/client.ts`
//! computes the identical address.
//!
//! - Windows: a named pipe, `\\.\pipe\elia-eliad-<user>`
//! - Unix: a socket file at `${XDG_RUNTIME_DIR:-~/.elia}/eliad-<user>.sock`
//!
//! `ELIA_ELIAD_SOCKET` overrides it: a bare pipe name on Windows, a full path
//! elsewhere (tests point it at a scratch location).

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

/// The Windows pipe address for an `ELIA_ELIAD_SOCKET` override: a full
/// `\\…` path is used as is; anything else is a bare pipe name. A pipe name may
/// contain any character except `\`, so `foo\bar` (which would make the
/// invalid `\\.\pipe\foo\bar`) becomes `foo-bar`. `src/daemon/client.ts` does
/// the same.
#[cfg(any(windows, test))]
fn pipe_address(explicit: &str) -> String {
    if explicit.starts_with(r"\\") {
        explicit.to_string()
    } else {
        format!(r"\\.\pipe\{}", explicit.replace('\\', "-"))
    }
}

/// The address to bind / dial, honouring `ELIA_ELIAD_SOCKET`.
pub fn address() -> String {
    if let Ok(explicit) = std::env::var("ELIA_ELIAD_SOCKET") {
        #[cfg(windows)]
        {
            return pipe_address(&explicit);
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
        socket_dir()
            .join(format!("eliad-{tag}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// Where the connection token lives on disk, mirroring `address()`'s location
/// rules so `src/daemon/client.ts` can compute the identical file. The daemon
/// writes it `0600`; a sibling user can't read a `0700` directory.
pub fn token_path() -> String {
    let tag = user_tag();
    #[cfg(windows)]
    {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".elia")
            .join(format!("elia-eliad-{tag}.token"))
            .to_string_lossy()
            .into_owned()
    }
    #[cfg(not(windows))]
    {
        socket_dir()
            .join(format!("eliad-{tag}.token"))
            .to_string_lossy()
            .into_owned()
    }
}

/// The unix socket directory (default `~/.elia` or `$XDG_RUNTIME_DIR`).
#[cfg(not(windows))]
fn socket_dir() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".elia")
        })
}

/// Whether the peer of an accepted unix connection is the same user as us.
/// On Linux this is `SO_PEERCRED`; other unices have no portable equivalent
/// without a per-OS syscall module, so there the (0600-file / 0700-dir / token)
/// layers do the work alone.
#[cfg(unix)]
pub fn peer_is_same_user(stream: &tokio::net::UnixStream) -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let rc = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut libc::ucred as *mut libc::c_void,
                &mut len,
            )
        };
        rc == 0 && cred.uid == unsafe { libc::getuid() }
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let _ = stream;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::pipe_address;

    #[test]
    fn a_bare_pipe_name_override_never_carries_a_backslash_into_the_name() {
        assert_eq!(pipe_address("elia-test"), r"\\.\pipe\elia-test");
        assert_eq!(pipe_address(r"foo\bar"), r"\\.\pipe\foo-bar");
        assert_eq!(pipe_address(r"\\.\pipe\full"), r"\\.\pipe\full");
    }
}
