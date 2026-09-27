# elia as an MCP server

Elia can be **served** over the Model Context Protocol, not just consume other MCP servers. That means Claude Desktop, Cursor, Zed, Continue, or anything else that speaks MCP can drive the governed agent loop directly, instead of shelling out to the CLI and scraping stdout.

The surface is **39 tools, 6 resources, 2 resource templates, and 5 prompts**. It is verified working end to end against a real model — see [Verified live](#verified-live) below.

> If you want the other direction (elia *consuming* other people's MCP servers), see [`docs/guide/integrations.md`](docs/guide/integrations.md).

---

## Contents

- [Quick start](#quick-start)
- [The four ways to start it](#the-four-ways-to-start-it)
- [Client configuration](#client-configuration)
- [Protocol version and negotiation](#protocol-version-and-negotiation)
- [HTTP transport](#http-transport)
- [What the tools do](#what-the-tools-do)
- [Resources, templates, and prompts](#resources-templates-and-prompts)
- [What a client can and cannot do](#what-a-client-can-and-cannot-do)
- [Configuration reference](#configuration-reference)
- [Cost](#cost)
- [Verified live](#verified-live)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requirements: [Bun](https://bun.sh), and a provider key configured the same way you would for any elia command (see [`docs/guide/configuration.md`](docs/guide/configuration.md)).

```bash
# from a clone
bun install
bun run mcp            # stdio, speaks MCP on stdin/stdout
```

Point any MCP client at it and ask for something real:

```json
{ "goal": "Add a test for the retry helper and make it pass" }
```

If you have the `elia` binary on your `PATH`, `elia --mcp` is the same server.

---

## The four ways to start it

There are four because there are four ways an operator actually arrives.

| Command | Use it when |
| --- | --- |
| `elia --mcp` | You already use the `elia` binary and want the server from the CLI |
| `bun run mcp` | You are working in a clone of the repo |
| `bun run mcp:http` | A client needs HTTP (remote, containerised, or shared) instead of stdio |
| `elia-mcp` | A client spawns a bare command and you want it off the repo `PATH` |

All four expose the identical 39-tool surface. `elia --mcp` and `elia mcp` are equivalent.

---

## Client configuration

`mcp-configs/` has a ready file for each client shape. Copy one into your client's settings directory and set `cwd` to the project you want governed — that directory is the blast radius, because that is where runs write.

| File | Client shape |
| --- | --- |
| `mcp-configs/claude-desktop.json` | command + args |
| `mcp-configs/cursor.json` | command + args |
| `mcp-configs/zed.json` | command + env |
| `mcp-configs/continue.json` | command + env |
| `mcp-configs/http-example.json` | HTTP endpoint + bearer token |

A minimal stdio entry looks like this:

```json
{
  "mcpServers": {
    "elia": {
      "command": "elia-mcp",
      "args": [],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

The stdio clients (`claude-desktop`, `cursor`, `zed`, `continue`) need no token. Only the HTTP transport does.

---

## Protocol version and negotiation

The server negotiates rather than hardcoding. It accepts:

- `2025-06-18`
- `2025-03-26`
- `2024-11-05`

Anything else — an unknown version, a non-string, or a missing one — falls back to `2024-11-05` rather than echoing a dialect the server does not actually speak.

`outputSchema` and `structuredContent` were introduced in `2025-06-18`, so they are advertised **only** to a client that negotiated that version. A client stuck on `2024-11-05` gets plain text content, which it is guaranteed to understand. That difference is the negotiation working, not a bug.

Negotiation is remembered for the life of the connection — including per HTTP session — so a later request cannot silently reset the version mid-session.

Elia keeps requesting `2024-11-05` when it is the *client*, deliberately. Raising that would make elia demand a modern dialect from every third-party server it connects to, which is a different risk from the one the server role has.

### Verify it yourself

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | bun run mcp
```

You should get `protocolVersion: "2025-06-18"` and 39 tools, each carrying an `outputSchema`. Change the requested version to `2024-11-05` and the schemas disappear.

---

## HTTP transport

```bash
bun run mcp:http        # 127.0.0.1:3284 by default
```

- **Loopback only by default.** It binds `127.0.0.1:3284` and refuses anything else unless you pass `--allow-remote-host`. It will not expose itself to a network by accident.
- **Bearer token required.** Generated on first start at `~/.elia/mcp-token` (override with `--token-path` or `ELIA_MCP_TOKEN_PATH`). Unauthenticated requests get `401`.
- **Session-aware.** Clients get an `mcp-session-id` back and send it on subsequent requests. An unknown session gets `404`, as does the wrong path.
- **Progress streams.** Send `Accept: text/event-stream` and progress events arrive ahead of the response, so a long run visibly makes progress instead of hanging on a pending POST.

---

## What the tools do

39 tools in eight groups. `costTier` is the honest cost class; `[approval]` means the governor requires an approval decision before it runs.

### Agent loop (7)

The plan → execute → verify → review → repair cycle.

| Tool | Cost | Notes |
| --- | --- | --- |
| `elia_run_task` | expensive | Start a governed run. The main entry point. |
| `elia_get_plan` | free | Read a server-held plan without approving it. |
| `elia_approve_plan` | free | `[approval]` Approve a held plan. |
| `elia_fork_run` | expensive | `[approval]` Fork a run into a new derived run. |
| `elia_run_variants` | expensive | `[approval]` Bounded best-of-N variants. |
| `elia_repair_run` | expensive | `[approval]` Governed repair of a failed run. |
| `elia_quick_ask` | model-call | Fast path for a short question, no full run. |

`elia_run_task` returns a `plan_id` and waits by default. Pass `approve_plan_automatically: true` to approve and execute in one call.

### Sessions (9)

`elia_session_create` `[approval]` · `elia_session_list` · `elia_session_status` · `elia_session_context` · `elia_session_inject` `[approval]` · `elia_session_sync` (cheap) `[approval]` · `elia_session_kill` `[approval]` · `elia_context_drop` `[approval]` · `elia_context_subscribe`

### Memory and lessons (5)

`elia_memory_read` · `elia_memory_write` `[approval]` · `elia_memory_search` (cheap) · `elia_lesson_promote` (cheap) `[approval]` · `elia_lesson_trial` (cheap) `[approval]`

### Self-improvement (6)

`elia_evolve` (expensive) `[approval]` · `elia_bench` (expensive) `[approval]` · `elia_distill` (model-call) `[approval]` · `elia_promote` (expensive) `[approval]` · `elia_compounding_status` · `elia_bench_latency`

### Domain (4)

`elia_research` (model-call) · `elia_analyze_data` (model-call) · `elia_write_document` (cheap) `[approval]` · `elia_strategic_analysis` (expensive)

### Observability (4)

`elia_runs_list` · `elia_run_receipt` · `elia_run_diff` (cheap) · `elia_cost_report`

### Governance (2)

`elia_policy_read` · `elia_policy_update` `[approval]`

### Config (2)

`elia_set_mode` · `elia_import_context`

Governance tool I/O is canonical **snake_case** (`max_wall_clock_s`, `estimated_cost_tier`). camelCase aliases are still accepted for compatibility, and a request that supplies both with conflicting values is rejected rather than silently resolved. Raw receipt fields, `receipt_changes[].field`, and `usage` token counters keep their on-disk shapes.

---

## Resources, templates, and prompts

### Resources (6)

| URI | Contents |
| --- | --- |
| `elia://runs` | Recent runs |
| `elia://sessions` | Live sessions |
| `elia://compounding` | Compounding status |
| `elia://modes` | Available modes |
| `elia://config` | Effective server config |
| `elia://bench/latest` | Latest benchmark result |

### Resource templates (2)

| URI template | Contents |
| --- | --- |
| `elia://memory/{project}` | Project-scoped memory |
| `elia://ledger/{run_id}` | One run's full action ledger |

### Prompts (5)

These frame a request; they deliberately do **not** start the work.

| Prompt | Frames |
| --- | --- |
| `elia_task_prompt` | A bounded task plan, separating planning from approval and execution |
| `elia_research_prompt` | A bounded, evidence-seeking research request |
| `elia_audit_prompt` | A read-only audit with evidence requirements and no implied remediation |
| `elia_evolve_prompt` | A bounded self-improvement hypothesis, withholding promotion approval |
| `elia_morning_brief_prompt` | A read-only briefing from current mode, memory, and run state |

---

## What a client can and cannot do

Three boundaries are enforced in code, not documented as advice.

**Mode is server state.** A client cannot widen the active mode through `tools/call`; the server rejects a mismatched `mode` outright. `elia_set_mode` changes what `tools/list` advertises *and* what executes, so a mode switch is observable rather than a claim.

**A client cannot approve anything.** Every mutation goes through the governor, which owns the approval decision, the actor, and the policy version. `elia_policy_update` rejects a client-supplied `approved`/`actor` rather than quietly overriding it, and policy changes are monotonic — you can tighten, not weaken. Benchmark-gated promotion stays behind its own guard.

**Cost is enforced, not reported afterwards.** A run that would cross `--cost-limit-per-session-usd` is refused before it happens. `ELIA_MCP_MAX_CONCURRENT_SESSIONS` caps live sessions.

This means an MCP client is a *proposer*, not an authority. It can ask elia to do something; it cannot talk elia into doing something the governor would refuse from a human operator either.

---

## Configuration reference

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--transport` | `ELIA_MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `--port` | `ELIA_MCP_PORT` | `3284` | HTTP port |
| `--host` | `ELIA_MCP_HOST` | `127.0.0.1` | Bind address; non-loopback needs `--allow-remote-host` |
| `--allow-remote-host` | `ELIA_MCP_ALLOW_REMOTE_HOST` | off | Permit a non-loopback bind |
| `--token-path` | `ELIA_MCP_TOKEN_PATH` | `~/.elia/mcp-token` | Where the HTTP bearer token lives |
| `--approval-mode` | `ELIA_MCP_APPROVAL_MODE` | `auto` | `auto`, `always`, or `never` |
| `--cost-limit-per-session-usd` | `ELIA_MCP_COST_LIMIT_PER_SESSION_USD` | none | Hard per-session spend ceiling |
| `--max-concurrent-sessions` | `ELIA_MCP_MAX_CONCURRENT_SESSIONS` | none | Cap on live sessions |
| `--allowed-operations` | `ELIA_MCP_ALLOWED_OPERATIONS` | all | Restrict which operations are exposed |
| `--stream-progress` / `--no-stream-progress` | `ELIA_MCP_STREAM_PROGRESS` | on | SSE progress channel |
| `--domain-auto-detect` / `--no-domain-auto-detect` | `ELIA_MCP_DOMAIN_AUTO_DETECT` | on | Detect specialist mode from the goal |

Provider selection is *not* an MCP flag — it uses elia's normal resolution, so `ELIA_PROVIDER` and that provider's key work exactly as they do for the CLI.

---

## Cost

Cost classes are `free`, `cheap`, `model-call`, and `expensive`. Anything that runs the agent loop is `expensive`; read-only inspection is `free`.

Set a ceiling before you expose this to anything autonomous:

```bash
bun run mcp -- --cost-limit-per-session-usd 2.00
```

A run that would cross the ceiling is **refused**, not truncated and not billed past the limit.

When a receipt carries no priced model, `elia_cost_report` answers `cost_known: false` with `estimate_only: true` and the token counts it *can* prove. It does not invent a dollar figure — a null cost is the honest answer, and the flag tells you which one you got.

---

## Verified live

The test suite drives `elia_run_task` against a *fake* execution context, so it proves the governor, the transports, the mode pinning, and the cost ceiling — but it cannot prove the model actually does the work. That gap is covered by a separate opt-in smoke that spends real money and is deliberately **not** wired into `bun test`:

```bash
bun run mcp:smoke
```

It runs one real `elia_run_task` in a throwaway temp directory, bounded by a cost ceiling, wall clock, and action count, and only reports success if all of these hold:

1. a receipt landed on disk,
2. the receipt's last verification event passed,
3. the run actually created the file it was asked to create.

It refuses to run on the local test key, and refuses to run at all if no provider resolves. It does **not** bypass the governor to get a green result — the approver grants `safe` actions and refuses `review` and `critical`, so a planner reaching for something risky stops and says why.

A passing run prints something like:

```
[mcp-run-task-smoke] provider mercury/mercury-2.5, cost ceiling $0.50
[mcp-run-task-smoke] negotiated 2025-06-18, server elia-mcp 0.1.2
[mcp-run-task-smoke] status=completed run_id=2026-09-26-hjfk-zhpb
[mcp-run-task-smoke] wrote hello.txt: true
[mcp-run-task-smoke] receipt outcome=completed completion=verified/high
[mcp-run-task-smoke] verify events: 1, last verdict: true
[mcp-run-task-smoke] actions: 11/60; approver consulted 0x (0 granted, 0 refused)
[mcp-run-task-smoke] real tokens: 90035 in, 5378 out
[mcp-run-task-smoke] ok — a real model planned, executed, and passed its own verification.
```

Exit `0` means a real model planned, executed, and passed its own verification. Exit `1` means it did not, and the message says which of the three conditions failed.

Run artefacts land in `.elia/runs/<run_id>/` — `receipt.json`, `receipt.md`, `actions.ndjson`, `events.ndjson`, `board.json`, and `goal-graph.json`.

---

## Troubleshooting

**Client says the server failed to start.** Run it by hand and read stderr: `bun run mcp`. On stdio, *anything* printed to stdout corrupts the JSON-RPC stream, so all logging goes to stderr.

**`401` over HTTP.** The bearer token is missing or stale. It lives at `~/.elia/mcp-token`; delete it and restart to regenerate.

**`404` over HTTP.** Either the path is not `/mcp` or you sent an `mcp-session-id` the server does not know. Drop the header to start a fresh session.

**No tools, or the wrong tools.** The active mode filters `tools/list`. Check `elia_set_mode`, or read `elia://modes`.

**A mutation is refused.** That is the governor, working. Read the refusal reason — it names the risk and the missing condition. Do not reach for `--approval-mode never` to make it go away; that removes the control rather than satisfying it.

**The model keeps retrying a shell command.** On Windows, `run_command` executes through `cmd.exe` and cannot run PowerShell cmdlets like `Get-ChildItem` directly. The error says so. Wrap the pipeline: `powershell -NoProfile -Command "Get-ChildItem …"`.

**`no usable provider`.** That is the MCP server reporting elia's normal provider resolution failing. Set `ELIA_PROVIDER` and that provider's key; see [`docs/guide/configuration.md`](docs/guide/configuration.md).
