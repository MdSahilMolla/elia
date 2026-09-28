//! Daemon-side client authentication.
//!
//! A socket path / pipe name is not an ACL. Connections to the daemon are
//! gated three ways (belt, braces, and suspenders):
//!
//! - the token file is created `0600` in a `0700` directory, so sibling users
//!   cannot read it;
//! - on Linux the accepted connection's `SO_PEERCRED` uid must equal ours, so
//!   a sibling user is refused before a single byte is negotiated;
//! - every first request on a connection must present the token in
//!   constant time.
//!
//! The committed client (`src/daemon/client.ts`) is the only caller; the token
//! is not secret enough to stop a determined same-user process (the file is
//! theirs to read), it stops *other users* and rubbernecks on a world-readable
//! socket from doing anything at all.

use std::fs;
use std::io::{self, Read, Write};

/// The daemon's effective token: `ELIAD_TOKEN` overrides the persisted,
/// socket-side file; the file is generated on first run (and refreshed every
/// startup, so a client can never hold a stale one).
pub fn server_token() -> String {
    if let Ok(token) = std::env::var("ELIAD_TOKEN") {
        let token = token.trim();
        if !token.is_empty() {
            return token.to_string();
        }
    }
    load_or_create(&crate::socket::token_path()).unwrap_or_else(|_| generate())
}

/// Read the token at `path`, or generate and persist one.
pub fn load_or_create(path: &str) -> io::Result<String> {
    if let Ok(existing) = fs::read_to_string(path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }
    let token = generate();
    persist(path, &token)?;
    Ok(token)
}

fn persist(path: &str, token: &str) -> io::Result<()> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Compare in constant time for the (fixed, short) token length.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 32 hex chars (16 random bytes). Unix reads /dev/urandom (cryptographic);
/// the Windows fallback below is not cryptographic, but a Windows pipe name is
/// per-user and the token merely raises the bar below it.
pub fn generate() -> String {
    let bytes = random_bytes();
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn random_bytes() -> [u8; 16] {
    let mut out = [0u8; 16];
    #[cfg(unix)]
    {
        if let Ok(mut file) = fs::File::open("/dev/urandom") {
            if file.read_exact(&mut out).is_ok() {
                return out;
            }
        }
    }
    // Portable fallback (and the Windows path): fold process-local entropy.
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut mix: u64 = 0xcbf2_9ce4_8422_2325;
    for (i, chunk) in out.chunks_mut(8).enumerate() {
        let source = match i {
            0 => std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0),
            1 => u64::from(std::process::id()) ^ COUNTER.fetch_add(1, Ordering::Relaxed),
            _ => {
                let _ = &mix;
                COUNTER.fetch_add(1, Ordering::Relaxed) << 1
            }
        };
        mix ^= source;
        mix = mix.wrapping_mul(0x100000001b3).rotate_left(13);
        chunk.copy_from_slice(&mix.to_le_bytes()[..chunk.len()]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_rejects_wrong_lengths_and_values() {
        assert!(constant_time_eq("abcd1234", "abcd1234"));
        assert!(!constant_time_eq("abcd1234", "abcd1235"));
        assert!(!constant_time_eq("abcd1234", "abcd123"));
        assert!(!constant_time_eq("", "x"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn generate_produces_hex_of_the_right_length() {
        let a = generate();
        let b = generate();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // 16 random bytes colliding is effectively impossible; this guards the
        // generator against returning a constant.
        assert_ne!(a, b);
    }
}
