# eliad

Elia's resident daemon. One process per user per machine that holds warm state
the CLI would otherwise rebuild on every invocation.

Today it provides **one** thing: a persistent shell pool. Later workstreams add a
warm provider-connection pool, the MCP client supervisor, the workspace index,
and lifecycle for the C++ / Java subsystems.

Everything here has an in-process fallback on the TypeScript side
(`src/daemon/client.ts` → `src/shell.ts`). A daemon that will not start, a
missing binary, a version mismatch — none of it is fatal; Elia just runs the
old path.

## Protocol

Newline-delimited JSON, one message per line, over a named pipe
(`\\.\pipe\elia-eliad-<user>` on Windows) or a unix socket
(`${XDG_RUNTIME_DIR:-~/.elia}/eliad-<user>.sock`). `ELIA_ELIAD_SOCKET` overrides
the address. The envelope and every method live in
[`src/protocol.rs`](src/protocol.rs) and are mirrored field-for-field in
[`../../src/daemon/types.ts`](../../src/daemon/types.ts).

| Method | Params | Result |
| --- | --- | --- |
| `daemon.info` | – | `{ version, protocol, pid, uptime_ms, shell_workers }` |
| `daemon.ping` | – | `{ pong: true }` |
| `daemon.shutdown` | – | `{ ok: true }` |
| `shell.exec` | `{ command, cwd, timeout_ms }` | `{ exit_code, stdout, stderr, elapsed_ms, timed_out }` |
| `shell.cancel` | `{ target: <exec request id> }` | `{ ok: true }` |

Bump `PROTOCOL_VERSION` on any breaking change. The client checks it on connect
and replaces a daemon that does not match.

## Persistent shell

One shell process (`cmd.exe` on Windows, `/bin/sh` elsewhere) per working
directory, kept alive for the life of the daemon. Each command is framed between
random `BEGIN`/`END` markers written to both stdout and stderr, so its output
and exit code are read back cleanly from the long-lived streams. `cd` is reset
before every command, so a `cd` inside one command never leaks into the next.

A command that exits the shell itself (a bare `exit N`) is handled: the real
exit code is recovered from the process and the dead worker is retired. A
command that overruns its timeout or is cancelled kills its worker; the next
command for that directory spawns a fresh one.

## Lifecycle

`src/daemon/client.ts` spawns `eliad` on first use (detached, stdio ignored) and
reuses it across CLI invocations. The daemon shuts itself down after
`--idle-timeout` seconds idle (default 900). `eliad stop` asks a running daemon
to exit.

`ELIA_DAEMON`: `off` (default) · `auto` (use it, fall back on any failure) ·
`require` (surface failures — for benchmarking the intended path).

## Build

```
cargo build -p eliad            # debug
cargo build -p eliad --release  # release
cargo test  -p eliad
```

Windows needs an LLVM-MinGW toolchain rather than MSVC — see
[`../../.cargo/config.toml`](../../.cargo/config.toml).
