# elia-box

Elia's own agent sandbox. A run happens in a deny-by-default confinement with a cleared
environment, a bounded budget, an optional brokered network, and a sealed receipt of what it
was allowed and what it did.

Built for a different job than a general container runtime: elia runs code an agent just wrote
(and, when compounding, code that rewrites elia itself), so the sandbox has to *prove* what a
run was held to, not just contain it.

| Piece | Language | Where | Job |
|---|---|---|---|
| Supervisor, backends, receipts, CLI | Rust | `crates/elia-box` | policy, Seatbelt profile generation, hardened Docker runs, limits, process-tree kill, sealed receipts |
| Copy-on-write workspace | C++ | `native/elia-box-fs` | instant fork (APFS `clonefile`), tree manifests, diffs, SHA-256 |
| Egress broker | Go | `go/cmd/elia-egress` | allowlist proxy; refuses private/loopback destinations; logs every attempt |
| Escape suite | Python | `crates/elia-box/escape` | 23 attacks, each with a control run outside the box |
| Wiring | TypeScript | `src/sandbox/box.ts`, `src/evolve/containment.ts` | `ELIA_SANDBOX=box` for shell commands; `ELIA_EVOLVE_BOX` for evolve gates |

## Build

```bash
cargo build --release -p elia-box && cp target/release/elia-box bin/
(cd go && go build -o ../bin/elia-egress ./cmd/elia-egress)
bin/elia-box image build      # only for the docker backend; pulls alpine once
bin/elia-box probe            # what this machine can do
```

## Use

```bash
ELIA_SANDBOX=box elia                     # every shell command runs in the box; fails closed
ELIA_BOX_NETWORK=brokered ELIA_BOX_ALLOW='pypi.org,*.pythonhosted.org' elia
ELIA_BOX_FALLBACK=host                    # only if you want an unavailable box to mean "run unsandboxed"
ELIA_EVOLVE_BOX=require elia evolve ...   # evolve gates run in the box, or the generation is refused
```

Directly: `elia-box run --policy policy.json -- argv...`. A policy is JSON (unknown fields are
rejected, so a typo cannot silently mean "no restriction"):

```json
{ "workspace": "/path/to/project", "mode": "fork",
  "network": { "mode": "brokered", "allow": ["example.com"] },
  "limits": { "wallMs": 60000, "memoryMb": 1024, "pids": 128 } }
```

`mode: "fork"` runs on a copy-on-write clone: the original is never touched and the receipt lists
what the run added, modified and deleted. Other commands: `verify`, `diff`, `fork`, `profile`
(prints the Seatbelt profile a policy compiles to, for review).

## Backends

| | Seatbelt (macOS) | Docker (Linux userland) |
|---|---|---|
| Files | read and write allowlists, enforced by the kernel | read-only root, mount allowlist |
| Network | none, brokered (loopback proxy only) or open | none or open (brokered is refused, not faked) |
| Memory / processes | rlimits plus a tree watcher (every 40ms) | kernel cgroup limits |
| Processes that daemonize | found by the sandbox they were born into and killed | container is killed as a whole |
| Toolchain | your own (`bun`, `git`, …) | what the image has |

## What it does not do

The receipt's `containment.notEnforced` lists these per run, so nothing is claimed silently.

- **Not a separate kernel.** Seatbelt shares the host kernel and user; Docker Desktop shares its VM's.
  A kernel exploit is out of scope. Use a VM if the code is hostile to that degree.
- **Seatbelt cannot hide that a path exists**: metadata reads stay allowed (path resolution needs
  them); contents do not. Memory is watched, not capped by the kernel.
- **No syscall filter** on the Seatbelt backend.
- **If `elia-box` itself is `SIGKILL`ed** it cannot clean up: its children keep running until they finish
  (macOS has no parent-death signal). SIGINT, SIGTERM and SIGHUP are handled and kill the whole tree.
- **The Seatbelt profile has no Security/trust daemon access**, so tools that need Security.framework
  trust evaluation (rather than a CA file, as `curl` uses) may fail TLS inside the box.
- **Receipts are tamper-evident, not tamper-proof.** Without `ELIA_BOX_RECEIPT_KEY` the seal is a
  hash (catches accidents). With it, an HMAC-SHA256 that only a key holder can produce.
- **No Windows backend**, and no native Linux backend yet (Landlock/seccomp); on Linux, use Docker.
- Seatbelt (`sandbox-exec`) is deprecated by Apple but still shipped and enforced.

## Test

```bash
cargo test -p elia-box                      # units + supervisor behaviour
(cd go && go test ./internal/egress/)       # broker
python3 crates/elia-box/escape/run.py       # every attack must be contained
python3 crates/elia-box/escape/run.py --backend docker
bun test src/sandbox src/evolve/containment.test.ts
```

The escape suite runs each attack twice where it is safe to: once outside the box as a control
(it must succeed there, or the test proves nothing) and once inside (it must fail). It found a
real gap while this was written: a process that double-forks and calls `setsid` outlived its run.
That is now closed and is a permanent attack in the suite.
