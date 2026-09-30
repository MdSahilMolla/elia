//! The listener and a dial helper, on tokio's own primitives so the exact
//! address matches what Node's `net` module connects to from `src/daemon/`:
//! `\\.\pipe\elia-eliad-<user>` on Windows, a unix socket path elsewhere.

use std::io;

#[cfg(not(windows))]
pub use nix::{connect, Listener};
#[cfg(windows)]
pub use win::{connect, Listener};

/// Remove any on-disk artifact for `addr` (a unix socket file). No-op on Windows.
pub fn cleanup(addr: &str) {
    #[cfg(not(windows))]
    let _ = std::fs::remove_file(addr);
    #[cfg(windows)]
    let _ = addr;
}

#[cfg(windows)]
mod win {
    use super::*;
    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };

    pub type Conn = NamedPipeServer;

    pub struct Listener {
        path: String,
        next: NamedPipeServer,
    }

    impl Listener {
        pub fn bind(addr: &str) -> io::Result<Self> {
            let next = ServerOptions::new()
                .first_pipe_instance(true)
                .create(addr)?;
            Ok(Self {
                path: addr.to_string(),
                next,
            })
        }

        /// Accept one client and immediately open the next pipe instance so a
        /// client that connects a microsecond later is never refused.
        ///
        /// `self.next` is replaced with a fresh instance on BOTH the success and
        /// error path of `connect()` — a failed/attempted pipe instance cannot be
        /// reused, so leaving it in place on error would wedge every subsequent
        /// `accept()` (and the caller's retry loop) on the same dead instance.
        pub async fn accept(&mut self) -> io::Result<Conn> {
            match self.next.connect().await {
                Ok(()) => {
                    let fresh = ServerOptions::new().create(&self.path)?;
                    Ok(std::mem::replace(&mut self.next, fresh))
                }
                Err(err) => {
                    if let Ok(fresh) = ServerOptions::new().create(&self.path) {
                        self.next = fresh;
                    }
                    Err(err)
                }
            }
        }
    }

    pub async fn connect(addr: &str) -> io::Result<NamedPipeClient> {
        ClientOptions::new().open(addr)
    }
}

#[cfg(not(windows))]
mod nix {
    use super::*;
    use std::fs;
    use tokio::net::{UnixListener, UnixStream};

    pub type Conn = UnixStream;

    pub struct Listener {
        inner: UnixListener,
    }

    impl Listener {
        pub fn bind(addr: &str) -> io::Result<Self> {
            // A leftover socket file from a crashed daemon blocks the bind.
            let _ = std::fs::remove_file(addr);
            if let Some(parent) = std::path::Path::new(addr).parent() {
                let _ = std::fs::create_dir_all(parent);
                // mkdir honours umask (commonly 0755), which would let sibling
                // users at least *try* to connect to the socket and read the
                // token file. Owner-only keeps both out of reach.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
                }
            }
            // Bind under a restrictive umask so the socket file never exists with wider
            // access than the chmod below leaves it; the previous umask is put back at once.
            #[cfg(unix)]
            let previous_umask = unsafe { libc::umask(0o177) };
            let bound = UnixListener::bind(addr);
            #[cfg(unix)]
            unsafe {
                libc::umask(previous_umask);
            }
            let inner = bound?;
            // The listener creates its file with umask too; tighten it so a
            // same-user process on a shared machine is the only plausible peer.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(addr, fs::Permissions::from_mode(0o600));
            }
            Ok(Self { inner })
        }

        pub async fn accept(&mut self) -> io::Result<Conn> {
            let (stream, _) = self.inner.accept().await?;
            Ok(stream)
        }
    }

    pub async fn connect(addr: &str) -> io::Result<UnixStream> {
        UnixStream::connect(addr).await
    }
}
