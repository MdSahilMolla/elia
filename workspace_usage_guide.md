# Elia Workspace Integration Guide

## Quick start (two terminals, localhost)

This guide shows how to run Elia with the integrated realtime workspace mesh (no external SMALL_ATTACHABLE_COMPONENTS dependency). When two peers pair, each automatically transitions to the workspace board (TUI) showing both nodes as connected.

### 1) Use the integrated mesh sidecar

Elia now includes the mesh sidecar in this repo. Either build it or use the prebuilt binary at the repo root:

**Option A: Use prebuilt**
```bash
./elia-mesh --version 2>/dev/null || true
```
Point `ELIA_RWS_PATH` to `./elia-mesh` in the repo root.

**Option B: Build from source**
```bash
cd go
go build -o ../elia-mesh ./cmd/elia-mesh
```

### 2) Terminal 1 — Node A (host)

```bash
export ELIA_HOME=/tmp/mesh-a
export ELIA_WORKSPACE_ROOT=/tmp/mesh-a
export ELIA_WORKSPACE_DB=/tmp/mesh-a/.elia/workspace.sqlite
export ELIA_RWS_STATE_DIR=/tmp/mesh-a/.elia/workspace
export ELIA_WORKSPACE_MESH=require
export ELIA_RWS_PATH=/path/to/elia/elia-mesh  # or ./elia-mesh if in repo
export ELIA_RWS_LISTEN=127.0.0.1:9777
export ELIA_RWS_ADVERTISE=127.0.0.1
mkdir -p /tmp/mesh-a/.elia /tmp/mesh-a/.elia/workspace

cd /path/to/elia
bun bin/elia.ts workspace init --name mesh
bun bin/elia.ts workspace serve
```

`serve` hosts and prints:
```
Workspace mesh: pairing code AEEXO-... — copy this to the other machine to join
```

Copy the full `p2pws://join/...` code. Keep this terminal open — once B joins, it auto-spawns the workspace board (TUI).

### 3) Terminal 2 — Node B (join)

```bash
export ELIA_HOME=/tmp/mesh-b
export ELIA_WORKSPACE_ROOT=/tmp/mesh-b
export ELIA_WORKSPACE_DB=/tmp/mesh-b/.elia/workspace.sqlite
export ELIA_RWS_STATE_DIR=/tmp/mesh-b/.elia/workspace
export ELIA_WORKSPACE_MESH=require
export ELIA_RWS_PATH=/path/to/elia/elia-mesh
mkdir -p /tmp/mesh-b/.elia /tmp/mesh-b/.elia/workspace

cd /path/to/elia
# Extract tokens from A
A_ID=/tmp/mesh-a/.elia/identity.json
export HARNESS_TOKEN=$(node -e "p=require('fs').readFileSync(process.env.A,'utf8');console.log(JSON.parse(p).token)" A=$A_ID)
export HARNESS_AGENT_TOKEN=$(node -e "p=require('fs').readFileSync(process.env.A,'utf8');console.log(JSON.parse(p).agentToken)" A=$A_ID)

# Adopt credentials
bun harness/node.ts adopt

# One-time pairing (persists pin) — replace with code from Terminal 1
/path/to/elia/elia-mesh attach --join "p2pws://join/..." --root /tmp/mesh-b
# Ctrl-C after "initial synchronisation complete"

# Serve — will reconnect from persisted pin, wait for peer, then launch TUI
bun bin/elia.ts workspace serve
```

Both terminals transition to the workspace board once connected.

## Notes

- Pairing is one-time. After the first successful join, `serve` reconnects automatically from the persisted pin.
- If you want verbose mesh tracing, set `ELIA_WORKSPACE_MESH_TRACE=1` on both terminals before `serve`.
- The auto-TUI transition only occurs in a TTY with `mesh !== false`. Headless `serve` is unchanged.
- The sidecar is integrated into this repo (`go/cmd/elia-mesh`, `go/internal/mesh`).
