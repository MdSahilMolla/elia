# Elia Workspace Integration Guide

## Quick start (two terminals, localhost)

This guide shows how to run Elia with integrated realtime workspace mesh on localhost. When two peers pair, each automatically transitions to the workspace board (TUI) showing both nodes as connected.

### 1) Build the Go sidecar

```bash
cd /mnt/d/SMALL_ATTACHABLE_COMPONENTS/realtime-workspace
go build ./...
# produces ./workspace binary
```

Set `ELIA_RWS_PATH` to that binary in all steps.

### 2) Terminal 1 — Node A (host)

```bash
export ELIA_HOME=/tmp/mesh-a
export ELIA_WORKSPACE_ROOT=/tmp/mesh-a
export ELIA_WORKSPACE_DB=/tmp/mesh-a/.elia/workspace.sqlite
export ELIA_RWS_STATE_DIR=/tmp/mesh-a/.elia/workspace
export ELIA_WORKSPACE_MESH=require
export ELIA_RWS_PATH=/mnt/d/SMALL_ATTACHABLE_COMPONENTS/realtime-workspace/workspace
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

Copy the full `p2pws://join/...` code. Keep this terminal open — once B joins, it auto-spawns the workspace board (TUI) showing both nodes online.

### 3) Terminal 2 — Node B (join)

```bash
export ELIA_HOME=/tmp/mesh-b
export ELIA_WORKSPACE_ROOT=/tmp/mesh-b
export ELIA_WORKSPACE_DB=/tmp/mesh-b/.elia/workspace.sqlite
export ELIA_RWS_STATE_DIR=/tmp/mesh-b/.elia/workspace
export ELIA_WORKSPACE_MESH=require
export ELIA_RWS_PATH=/mnt/d/SMALL_ATTACHABLE_COMPONENTS/realtime-workspace/workspace
mkdir -p /tmp/mesh-b/.elia /tmp/mesh-b/.elia/workspace

cd /path/to/elia
# Extract tokens from A
A_ID=/tmp/mesh-a/.elia/identity.json
export HARNESS_TOKEN=$(node -e "p=require('fs').readFileSync(process.env.A,'utf8');console.log(JSON.parse(p).token)" A=$A_ID)
export HARNESS_AGENT_TOKEN=$(node -e "p=require('fs').readFileSync(process.env.A,'utf8');console.log(JSON.parse(p).agentToken)" A=$A_ID)

# Adopt credentials
bun harness/node.ts adopt

# One-time pairing (persists pin)
# Replace with code from Terminal 1
/mnt/d/SMALL_ATTACHABLE_COMPONENTS/realtime-workspace/workspace attach --join "p2pws://join/..." --root /tmp/mesh-b
# Ctrl-C after "initial synchronisation complete"

# Serve — will reconnect from persisted pin, wait for peer, then launch TUI
bun bin/elia.ts workspace serve
```

Both terminals transition to the workspace board once connected. You’ll see both nodes in presence/recent activity.

## Notes

- Pairing is one-time. After the first successful join, `serve` reconnects automatically from the persisted pin — no need to re-paste the code.
- If you want verbose mesh tracing, set `ELIA_WORKSPACE_MESH_TRACE=1` on both terminals before `serve`.
- The auto-TUI transition only occurs in a TTY with `mesh !== false`. Headless `serve` is unchanged.
- The sidecar supervisor is integrated: Elia spawns `workspace attach` (host/member) and manages reconnection, control relaying, and the pairing code flow.
- For containerized two-node verification, use `./harness/verify.sh`.
