# Integrations and workflows

[← Back to the README](../../README.md)

## End-to-end web deployment

Elia’s Tech and Production workflows can carry a web project through inspect → implement → test → build → preview deploy → live verification. The governed `deployment` tool supports Vercel and Netlify when the project is already linked locally: `.vercel/project.json` for Vercel, or `.netlify/state.json`/`NETLIFY_SITE_ID` for Netlify. It uses the project’s declared build script, returns bounded provider output, extracts the deployment URL, and records a receipt in `.elia/deployments.jsonl`.

Use `{"action":"plan","provider":"vercel","target":"preview"}` to inspect readiness, `{"action":"build","provider":"vercel"}` to run the local build, `{"action":"deploy","provider":"vercel","target":"preview"}` to create a preview, and `{"action":"verify","provider":"vercel","url":"https://...vercel.app"}` to check the live result. Netlify uses the same actions with `"provider":"netlify"`. Preview deployment is reviewable external work. Production deployment is a separate **critical action** requiring exact approval immediately before execution; unattended runs block it. Elia does not create provider projects, perform interactive login, upload secrets, modify domains or environment variables, or report success without provider output and a successful HTTPS postcondition.

## Full VS Code extension

Elia includes a full VS Code client under [`extensions/vscode`](../../extensions/vscode). It provides an Elia engineering panel, streamed chat and tool events, active-file and selection context, workspace diagnostics, autonomous run controls, task/run/skill tree views, skill-bundle selection, native diff review, environment inspection, receipts, preview deployment, live verification, and production approval controls.

The extension is a thin local client over `elia bridge`; it does not duplicate the model layer or weaken Elia’s governance. Install its dependencies and compile it with `cd extensions/vscode && pnpm install && pnpm run compile`, then configure `elia.cliPath` to the absolute `bin/elia.ts` path for a source checkout or leave it as `elia` for an installed executable. The bridge uses the open workspace as its working root, communicates over local stdin/stdout rather than a TCP server, and keeps provider credentials in Elia’s normal process environment. See [`extensions/vscode/README.md`](../../extensions/vscode/README.md).

## Bridge protocol over HTTP (for external clients other than VS Code)

The same request/response/event protocol the VS Code extension speaks is also reachable over WebSocket: `elia bridge --http [--port 4319] [--host 127.0.0.1]`. Binds to localhost only unless you explicitly pass a different `--host` — this opens a network-reachable port, which is a meaningfully different exposure than the stdio bridge's local-pipe-only reach, so that's opt-in. Each WebSocket connection gets its own isolated session (own chat history, own pending approvals) — nothing is shared between concurrent clients. This is the basis for a future SDK or a non-VS-Code client (another editor) without re-implementing the protocol.

## Skills: create, install, and select

Elia can synthesize a repeated routine into a tested skill with `elia skills candidates` followed by `elia skills synth`. Users can also create or add a skill manually by placing a self-contained `*.skill.ts` module in the project’s `.elia/skills/` directory or the user-wide `~/.elia/skills/` directory. Use `elia skills path` to print the exact folders and contract. Invalid skills are quarantined instead of crashing startup.

For explicitly selected shared libraries, set `ELIA_SKILL_DIRS` to a colon-separated list on Unix or semicolon-separated list on Windows. External directories are scanned only when configured by the operator and have lower precedence than user and project skills, so a local skill can safely override a shared default. Elia does not discover arbitrary parent directories or remote repositories.

A project can group existing skill names in `.elia/skill-bundles.json`:

```json
{
  "frontend-dev": {
    "description": "UI implementation and review tools",
    "skills": ["ui_review", "react_test"]
  }
}
```

Use `elia skills bundles` to inspect bundles. Inside an interactive session, type **`@skills`** and press Enter to browse loaded skills and configured bundles. Selecting a bundle expands only to its existing skill tool names; it does not execute configuration, rewrite the user’s text, alter the system prompt, or add hidden instructions to the model. `ELIA_SKILLS=off` disables all skill loading.

## Production SaaS delivery

The Production Engineering specialist is routed for release, deployment, migration, rollback, observability, SLO, incident, backup, and CI/CD requests. Its read-only `production_readiness` tool scans the actual repository for CI configuration, deployment manifests, verification scripts, environment/secret hygiene, database and migration evidence, observability, health checks, rollback, incident, and backup artifacts. It returns a scored evidence checklist and recommendations; a detected file is never treated as proof that a production system is safe or deployed.

Production work remains bounded and auditable. Elia can inspect a repository, prepare changes, run dry-run or staging checks, write release and incident plans, and verify observable postconditions. Deployment, production data mutation, destructive migrations, secret rotation, and irreversible infrastructure actions require explicit approval and project-specific credentials. No local repository audit can prove that an external environment is healthy.

## Data science and finance workflows

The `data_science` tool provides deterministic, reproducible workflows for CSV, TSV, JSON, and JSONL files: schema and type profiling, missingness and duplicate detection, explicit data-quality validation, grouped summaries, Pearson correlation, and bounded ordinary-least-squares linear regression. It reports bounded input size, excludes invalid values from aggregates rather than silently repairing them, and clearly states that association is not causation. Advanced statistical inference, causal analysis, experiment design, and domain-specific leakage review still require project-specific code and acceptance criteria.

The `visualize` tool creates bounded bar charts and flow diagrams from structured values. It renders a readable terminal preview immediately, then saves a deterministic SVG and accessible Markdown companion under `.elia/artifacts/` for `/artifact` and the existing local `preview` workflow. It rejects raw HTML/SVG/scripts/URLs, validates finite values and graph edges, strips terminal controls, escapes generated markup, serializes repository writes, and refuses to replace a different artifact with the same slug.

The `finance` tool provides deterministic unit-economics, runway, bounded scenario, and DCF valuation calculations with sensitivity cases. Every result includes the input basis, reference date, assumptions, source disclosure, confidence caveat, formulas or interpretation, and the required financial-analysis disclaimer. It does not fetch market data, decide personal investments, establish accounting policy, or substitute for a licensed adviser. For company or investment analysis, use primary filings or approved data sources and preserve fiscal-period and metric-basis traceability.

## Native Excel and presentation workflows

Elia’s Office workflow is now first-class for local workbooks. The `spreadsheet` tool supports `inspect`, `analyze`, `audit`, and bounded `write` operations. Analysis selects numeric measures, computes totals and averages, groups results by categorical columns, counts formula cells, reports blank values, detects duplicate keys when requested, and returns structured JSON that can be reconciled before it is used in a decision. Workbook writes are atomic, limited to 200 cell operations per request, and must create an output file inside the current repository or `workspace/` directory rather than silently overwriting an arbitrary source file.

The `presentation` tool turns a verified workbook into an editable management `.pptx` deck. It creates KPI cards, grouped-performance charts, audit findings, and recommended actions, and writes a JSON sidecar containing the source, analysis, and audit data. Its `verify` action checks the PPTX package and slide count and can optionally render through LibreOffice when available. The generated deck is an artifact that should still be visually reviewed before publication; native creation does not claim that the deck is automatically perfect for every template or brand system.

Example request:

```text
Analyze workspace/q3-sales.xlsx by Region using Sales, audit duplicate Order IDs, and create a management presentation with the top risks and recommended actions.
```

The finance, business, data, research, and automation specialists can use these Office tools. Presentation and workbook generation remain governed as reviewable artifact actions, while inspection and analysis are read-only. This keeps the Office layer broad without weakening the existing model behavior or action safety boundaries.

## External communication and browser tasks

Elia can prepare and, when the user has enabled a trusted browser or service connector, execute external-party workflows such as drafting email to a co-founder, preparing a calendar invitation, or updating a web application. The system deliberately separates **draft** from **send**: it must verify the recipient, channel, content, attachments, timing, and final page or connector state, and obtain explicit approval immediately before sending, publishing, deleting, purchasing, transferring, or changing account state. Login, CAPTCHA, payment, and sensitive-input steps require user takeover. If Gmail, Calendar, Outlook, Slack, an SMS provider, or another connector is disabled, Elia must report that limitation instead of pretending it can access the account.

The `communication` tool provides a connector-neutral durable workflow for `status`, `draft`, `inspect`, `list`, `send`, `verify`, and `cancel`. Drafts are stored under `.elia/communications/` with atomic persistence and can be resumed after interruption. Sending requires an exact five-minute approval token bound to the unchanged recipient, channel, body, attachments, and schedule. The configured adapter must return an acceptance response, and Elia preserves the resulting external identifier or failure receipt; it never claims that a message was delivered merely because a model intended to send it.

Configure `ELIA_COMMUNICATION_BRIDGE_COMMAND` for a trusted wrapper that accepts one JSON request on stdin, or `ELIA_COMMUNICATION_MCP_SERVER` for a communication connector. Use the communication status action before attempting external work. Credentials should remain in the browser session or adapter environment, never in prompts, source files, or command-line arguments.

## Browser tasks

Elia exposes a lead-agent `browser` tool for status checks, navigation, refresh/back/forward, page snapshots, text extraction, clicking, typing, key presses, bounded scrolling, waits, wait-for conditions, and explicit post-action verification. Safe observational operations can retry once; mutating actions are not blindly retried because a duplicate click or submission can create a side effect. Optional `expectText` and `expectUrl` checks force the action to be followed by a fresh page observation, so a successful transport response is not confused with a successful UI state change. It never pretends browser work succeeded: every configured browser action returns its result to the agent, and the agent is instructed to re-read the page after meaningful actions.

The browser tool connects through an enabled user-browser connector, a trusted local bridge, or a Chrome DevTools endpoint:

```bash
# Direct connector route, when the enabled connector exposes browser_navigate, browser_snapshot, etc.
# Browser MCP tools configured in .elia/mcp.json are auto-detected.
# Set this only to select one server when several provide browser_* tools:
ELIA_BROWSER_MCP_SERVER="My Browser" elia "open the dashboard and summarize its current status"
# or
ELIA_BROWSER_BRIDGE_COMMAND="/path/to/your/browser-bridge" elia "open the dashboard and summarize its current status"
# or
ELIA_BROWSER_CDP_URL=http://127.0.0.1:9222 elia "inspect the active page"
```

Connected MCP tools named `browser_*` are called through Elia's existing live MCP client, so `manus-mcp-cli` is not required for configured `.elia/mcp.json` servers. If only the legacy external MCP route is configured, override nonstandard tool names with variables such as `ELIA_BROWSER_NAVIGATE_TOOL` and `ELIA_BROWSER_SNAPSHOT_TOOL`.

A bridge receives one JSON request on stdin and should return one JSON or text response. Keep login credentials in the bridge or browser session, never in Elia prompts, source files, or command-line arguments. Elia must not bypass login challenges, CAPTCHAs, paywalls, or site safety controls. Actions that may send, buy, publish, delete, or change subscriptions pause and return an exact five-minute `confirmationToken`. The user must approve that exact action before the token is supplied; tokens are bound to the action details and cannot be reused for a changed target or message. `wait_for`, `expectText`, and `expectUrl` are intended for stateful sites where navigation or clicks complete asynchronously; they time out rather than claiming success.

## MCP servers

Elia is a real MCP client: any server's tools become available to the dev-mode agent (and everything spawned under it — sub-agents, the autonomous loop's roles, `elia evolve`) automatically, with no per-tool code to write. Configure servers in `.elia/mcp.json` (project, checked into the repo) and/or `~/.elia/mcp.json` (personal — credentials, local paths you don't want in the repo). Project entries override user entries with the same name. Same shape most other MCP hosts use, so an existing config can be copied in as-is:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } },
    "local-tool": { "command": "/path/to/server", "disabled": true }
  }
}
```

Servers are spawned over stdio and connected once at startup; a server that fails to start or handshake is logged and skipped rather than blocking the rest. In the interactive terminal the connect pass is kicked off first and runs *while* the intro plays and you read the prompt, so spawning a slow server's child process and handshake no longer holds up the REPL — its tools attach as soon as they're ready and are available from the next turn. Each tool is registered as `mcp_<server>_<tool>` and, like any tool with no built-in safety contract, requires explicit approval before it runs — Elia has no way to know an arbitrary third-party server's tool is safe ahead of time, so it doesn't guess.

### Adding servers and connectors from the terminal

You don't have to hand-edit `mcp.json`. In the interactive terminal:

- **`/mcp`** — everything configured, connected or not, with its tools. Add a server from a curated catalog (GitHub, Filesystem, Postgres, Slack, Playwright, …) or by hand, `reload` after an edit, and per-server **test connection / enable / disable / remove**. `/marketplace` → `mcp` (or `connector`) opens the same thing as a sub-menu: **Installed / configured**, **Suggested** (the catalog), **Add custom** — the same shape every `/marketplace` source uses (npm, pip, skills all get an *Installed* list and a *Suggested* shortlist too).
- **`/connector`** — the same, scoped to **remote** MCP servers reached over HTTP instead of a local process. Pick one from the catalog (DeepWiki, Context7, Hugging Face, Notion, Linear, Sentry, Stripe, hosted GitHub, …) or paste any Streamable-HTTP endpoint URL plus an auth header. Elia writes the entry, reconnects, and tells you the tool count right away.

Every add ends with a live reconnect, so the tools are usable in the same session — and you choose whether the entry lands in the project file or your personal `~/.elia/mcp.json`.

### Remote connectors

A `url` instead of a `command` makes an entry a **connector** — a hosted MCP endpoint, no local process:

```json
{
  "mcpServers": {
    "deepwiki": { "url": "https://mcp.deepwiki.com/mcp" },
    "notion":   { "url": "https://mcp.notion.com/mcp", "headers": { "Authorization": "Bearer ntn_..." } },
    "linear":   { "url": "https://mcp.linear.app/sse", "transport": "sse" }
  }
}
```

Connectors use the MCP **Streamable HTTP** transport (JSON or SSE responses, `Mcp-Session-Id` handled automatically). `headers` carries auth and is never logged. `"transport": "sse"` marks a legacy SSE-only endpoint, which Elia does not connect to — ask the provider for a `/mcp` Streamable HTTP URL. Connector tools are governed exactly like stdio ones: `mcp_<name>_<tool>`, approval required.

For browser use, a configured Playwright MCP server is detected automatically and routed through Elia's governed `browser` tool:

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  }
}
```

Use `browser` with `status`/`snapshot` first. Accessibility-snapshot targets can then be passed to click or type. Login, CAPTCHA, payment, sensitive input, publishing, sending, purchasing, deletion, and account changes retain their existing approval or user-takeover boundaries.

## Delegating to the real OpenAI Codex CLI

The `codex_delegate` tool (dev mode, top-level only) hands a task to the real, separately-installed [OpenAI Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`, then `codex login` with your own ChatGPT subscription or an API key, exactly as you would use it standalone. Elia only shells out to the real binary (`codex exec ... --approve-for-me`, scoped to a given directory, its final answer captured and returned) — it does not implement Codex's authentication itself, does not read or reuse its stored credentials, and does not route elia's own model calls through it. If `codex` isn't installed or not signed in, the tool says so and stops rather than trying to authenticate on your behalf. Like `task`/`preview`, this is governed as a `critical`-risk action requiring explicit approval — elia's governor has no visibility into what Codex does once a task is delegated to it.
