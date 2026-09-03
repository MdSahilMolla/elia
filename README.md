# elia

A fast, general-purpose autonomous agent for the terminal, built on Bun. It streams model output live, calls tools (file read/write/edit, glob, grep, shell, browser) automatically in a loop, and works with multiple LLM providers. Every meaningful tool call passes through a deterministic autonomy governor, and autonomous runs produce a redacted action ledger plus a human-readable receipt.

Beyond the usual loop, elia does three things most terminal agents don't:

- **It works a task the way a person does** — orients, tells you what it intends to do, executes it with a fleet of specialised sub-agents running in parallel, checks its own work, repairs what broke, and writes down what it learned for next time.
- **It improves itself, measurably.** `elia evolve` has elia read its own source, form one hypothesis about its weakest link, implement it in a sandboxed copy, and benchmark that copy *using the copy's own code*. It only replaces itself if the score actually goes up.
- **It writes its own tools.** Elia counts what it keeps doing by hand and can turn a repeated routine into a real, tested tool that loads on every future run.

## Working on Elia / joining the team

Elia is developed in the open here, by **[Custumizer](https://linkedin.com/company/custumizer)**.
The team's core repository — how "production-grade" is defined, the concurrent
multi-developer workflow, the architecture notes, and the R&D agenda toward a
self-improving general autonomous intelligence — is a separate **private**
repository: **[`custumizer-core`](https://github.com/MdSahilMolla/custumizer-core)**.

It's invite-only, so you won't see its contents until you're added. If you want
to contribute or join the team, open an issue here titled `Access request` —
tell us who you are and what you'd like to work on — and a maintainer will
follow up.

## Requirements

- [Bun](https://bun.sh) >= 1.3

## Install

Run without installing:

```bash
bunx elia-ai
```

Or install globally with Bun or npm:

```bash
bun add --global elia-ai
# or
npm install --global elia-ai

elia --help
```

Interactive sessions check npm for a newer Elia release at most once every 24 hours and print the exact global update command when one is available. The check times out quickly and fails silently when offline. Set `ELIA_NO_UPDATE_CHECK=1` to disable it.

## License

Elia is licensed under the [GNU Affero General Public License v3.0](LICENSE).

### Dev mode

Elia’s default general-purpose coding mode is called **dev mode**. It covers building, debugging, refactoring, testing, software operations, browser work, and task delegation. Start it explicitly with `elia --dev`, or switch back to it interactively with `/dev`. The old `/normal` command remains accepted as a compatibility alias but is not shown in command completion.

Dev mode is separate from execution policy: manual policy asks before risky actions, while auto policy skips preliminary risk checks but keeps governed irreversible actions behind explicit approval unless unattended execution has been explicitly requested.

### Dev-mode project hooks

Dev mode can load optional declarative validators from `.elia/dev-hooks.json`, or from the `ELIA_DEV_HOOKS` environment variable. Hooks can block a matching tool request with a static explanation, which is useful for repository conventions such as preferring `rg`, requiring a project-specific command, or disallowing browser mutations in an unsupervised workflow. They match only an exact tool name and/or a literal substring in the tool input; they cannot execute scripts, load modules, call URLs, grant approvals, or override the autonomy governor.

```json
[
  {
    "id": "prefer-rg",
    "tool": "run_command",
    "inputContains": "grep ",
    "message": "Use rg instead of grep for repository searches."
  }
]
```

Malformed or oversized hook configuration fails closed. Hooks are inherited by delegated workers and autonomous repair passes in dev mode, but they are not loaded in Cybersecurity, Sports, or Fitness modes. See [`docs/dev-mode-hooks.md`](docs/dev-mode-hooks.md) for the full contract and safety model.

## Configuration

The recommended first-run setup stores the selected provider and API key in a user-level file rather than in the project repository:

```bash
elia config set --provider nvidia --model openai/gpt-oss-20b
elia config
elia "summarize this project"
```

The interactive API-key prompt does not echo the key. For automation, read the key from an existing environment variable or pipe it through stdin; never put a secret in a command-line argument:

```bash
export NVIDIA_API_KEY_FROM_SECRET_STORE="..."
elia config set --provider nvidia --api-key-env NVIDIA_API_KEY_FROM_SECRET_STORE
printf '%s' "$NVIDIA_API_KEY_FROM_SECRET_STORE" | elia config set --provider nvidia --api-key-stdin
```

Elia writes this configuration to `~/.elia/config.env` with restrictive permissions and never prints the key. Explicit process variables and the project `.env` take precedence over the user-level file. Inspect readiness with `elia config`; it reports configured/not-configured providers without displaying values.

On the first interactive run, if the active provider is not fully configured, Elia opens a setup flow before loading the model runtime. It asks you to choose a provider, enter its API key with input hidden, and select a model from the provider’s discovered list when available. If discovery is unavailable, it asks for a model ID and uses the provider’s documented default when one exists. The saved provider and model are then used for the current process immediately; no restart is required.

During a session, `/settings` → **Provider API keys** lets you add or update another provider, select its model, activate it immediately, or remove a saved provider profile. Removal requires confirmation and never displays the credential. The equivalent noninteractive command is `elia config remove --provider <name>`. The current session may finish using an already-created provider object after removal, but the removed profile will not be loaded by the next process.

The model picker also shows **ChatGPT subscription (Codex)**. You can select it directly from **Settings** → **Provider connections** with the arrow keys, then press Enter to start the official Codex CLI's ChatGPT sign-in flow. A successful sign-in switches Elia to its subscription-backed `codex` provider immediately and remembers that selection. This is deliberately separate from the `openai` API-key provider: Elia does not expose or save your subscription credentials. A ChatGPT subscription is not copied into `OPENAI_API_KEY` or used for ordinary OpenAI API calls. The subscription provider keeps one authenticated Codex app-server process alive and reuses it instead of paying process startup and initialization latency on every request. Each Elia chat has its own Codex conversation thread. During the turn, Elia displays bounded, credential-redacted Codex plans, commands, command output, file changes, diffs, model reroutes, warnings, and completion state in the terminal, JSON event stream, and editor bridge. Codex runs in a network-disabled `workspace-write` sandbox, so it can inspect, edit, and test the active project. Elia records that Codex hand-off as a critical action and requires explicit approval before it starts; the adapter never grants a noninteractive child automatic approval for network or other consequential external actions.

For local development from the repository, use:

```bash
bun install
cp .env.example .env
```

Edit `.env` to pick a provider and set its key. `ELIA_PROVIDER` defaults to `anthropic`. The user-level `elia config set` flow and `.env` are alternative configuration paths; you do not need both.

| Provider | `ELIA_PROVIDER` | API key env var | Default model |
|---|---|---|---|
| Anthropic | `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| Groq | `groq` | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `openrouter/auto` |
| Mistral AI | `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| Google Gemini | `google` | `GEMINI_API_KEY` | `gemini-3.7-flash` |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` | `nvidia/llama-3.3-nemotron-super-49b-v1.5` |
| Inception (Mercury) | `mercury` | `INCEPTION_API_KEY` | `mercury-2` |
| Any other OpenAI-compatible endpoint | `custom` | `ELIA_API_KEY` | none — set `ELIA_MODEL` |

Any provider's model can be overridden with `ELIA_MODEL`. `openrouter` uses OpenRouter's OpenAI-compatible endpoint and its `openrouter/auto` router by default; set `ELIA_MODEL` to pin a specific OpenRouter model. `mistral` uses Mistral's OpenAI-compatible endpoint and `mistral-large-latest` by default; set `ELIA_MODEL` to choose another Mistral model. `google` uses Google's OpenAI-compatible Gemini endpoint and `gemini-3.7-flash` by default; set `ELIA_MODEL` to choose another compatible Gemini model. `nvidia` uses NVIDIA's hosted NIM OpenAI-compatible endpoint and `nvidia/llama-3.3-nemotron-super-49b-v1.5` by default; set `ELIA_MODEL` to choose another available NIM model. `custom` (and any provider, if you need to point at a proxy or self-hosted gateway) also honors `ELIA_BASE_URL`; configure it with `elia config set --provider custom --base-url <url> --model <model-id>`.

### Security boundaries

Elia applies defense-in-depth controls before local or network-sensitive work. File tools resolve every existing path component canonically and reject `..` traversal, absolute paths outside the active or explicitly designated workspace, symlink escapes, and dangling symlink ancestors. Paths that commonly contain credentials—such as `.env` files, SSH keys and directories, cloud credential stores, browser profiles, npm configuration, and token or password files—are blocked before bytes can enter model context. Directory listing and recursive search omit protected entries, and shell commands that would disclose protected files remain critical even after a user approves the surrounding action.

Durable run state, checkpoints, task snapshots, journals, ledgers, schedules, coordination notes, and communication drafts are stored with private directories (`0700` where supported), owner-only files (`0600` where supported), atomic replacement, and permission repair for older state. These are local filesystem safeguards, not encryption or a substitute for a protected operating-system account.

`web_fetch` accepts only HTTP(S) URLs, rejects embedded credentials and local, private, link-local, metadata, multicast, and reserved targets, resolves public hostnames before requesting, bounds response size and duration, and refuses automatic redirects. Custom model endpoints must use HTTPS. A localhost development endpoint is permitted only when `ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT=1` is explicitly set; it remains a local development exception, not a production trust model. DNS checks are defense in depth and do not claim to eliminate every time-of-check/time-of-use or network-rebinding risk, so use network isolation for stronger guarantees.

The React artifact server binds to loopback and uses a bounded, traversal-safe resolver. It is intended for local preview, not public hosting. Elia remains a local application rather than a hardened multi-user sandbox: it does not provide kernel isolation, hosted identity, a secure keyring, or guaranteed protection from a user who grants the process broad operating-system access. See [`SECURITY.md`](SECURITY.md) for reporting and supported-version guidance.

#### Deterministic policy: `.elia/policy.json`

A checked-in `.elia/policy.json` tightens the autonomy governor before the model runs — enforced by code at the tool boundary, not by a prompt the model can argue its way around. It can only make the governor stricter, never looser. Fields (all optional):

- `denyTools` — tool names blocked outright, e.g. `["codex_delegate", "communication"]`.
- `denyIntents` — governor intents blocked outright, e.g. `["github.push", "browser.click"]` (a `tool.action` pair, so `github.push` is denied while `github.commit` is not).
- `denyCommandPatterns` — case-insensitive regular expressions; a `run_command` is blocked when any matches.
- `requireApprovalAtOrAbove` — `"safe"`, `"review"`, or `"critical"` (default). Any action assessed at this risk or higher stops being auto-allowed in unattended mode and needs an explicit approval.

A malformed policy file fails loudly rather than being ignored. A refused action reports `Blocked by .elia/policy.json`.

### Automatic provider fallback

The selected provider and model remain primary. Use `/model auto` or set `ELIA_ROUTING_MODE=auto` to try another configured provider when the selected route fails before output because of a missing model, outage, network error, rate limit, or retryable server response. Fallback is immediate when another ready provider exists and never retries after partial output.

### Specialist modes and capability contracts

Elia routes requests across explicit specialist modes: **Sports**, **Fitness**, **Marketing**, **Finance**, **Business Analyst**, **Data Analyst**, **Research**, **Cybersecurity**, **Automation**, **Communications**, **AI/ML**, **Production Engineering**, and **Tech**. Automatic routing is available through `elia agent "<request>"`; interactive sessions can pin a specialist with `/sports`, `/fitness`, `/marketing`, `/finance`, `/business`, `/data`, `/research`, `/cybersecurity`, `/automation`, `/communications`, `/ai`, `/production`, or `/tech`. `/sports` and `/fitness` are also true operating modes, so their system prompts and delegated workers inherit the selected domain. Use `/capabilities` to inspect each mode’s risk class, preferred tools, and required output contract.

Each specialist must separate facts, assumptions, recommendations, and unknowns. Finance and cybersecurity work require explicit assumptions or authorized scope; data work requires quality checks and reproducibility; research requires sources and citations; Sports work must separate supplied facts from metrics, estimates, and opinion; Fitness work must remain conservative and non-medical; communications and automation require exact approval immediately before consequential external actions.

### Sports mode and Fitness mode

Sports mode supports evidence-aware match and opponent analysis, scouting, athlete or player comparisons, performance metrics, league and tournament research, event operations, fan engagement, sponsorship analysis, and sports-business workflows. Its deterministic `sports` tool can summarize team-match rows, rank players by a supplied metric, and validate structured sports data. It never fetches or invents scores, rankings, injuries, contracts, or predictions; current external facts require configured research tools and source verification.

Fitness mode supports sustainable goal setting, workout organization, strength and conditioning basics, mobility, cardio, habit tracking, recovery reflection, sleep and activity summaries, and conservative plan adaptation. Its deterministic `fitness` tool can create a bounded generic weekly template, summarize supplied activity logs, and validate tracking rows. It is not a doctor, physiotherapist, dietitian, or emergency service: it does not diagnose, prescribe treatment, guarantee results, or infer health conditions from wearable data. Pain, injury, concerning symptoms, eating-disorder concerns, pregnancy-related questions, and medical conditions require qualified professional guidance.

### Battmann strategic-intelligence mode

Start with `elia --battmann`, switch with `/mode battmann`, or run governed autonomy with `elia auto --battmann "<goal>"`. Battmann produces evidence-backed strategic briefs across trade, geopolitics, financial markets, supply chains, policy, and commodities. Its workspace-local SQLite system of record defaults to `.elia/battmann.sqlite` and preserves evidence, claim-level excerpts and reviews, resolvable questions, immutable forecast revisions, accepted/disputed resolution events, versioned ontology objects, links, scenarios, decisions, outcomes, benchmark runs, datasets with lineage, action proposals, geolocated events, deployment stages, and a hash-chained audit log.

The deterministic `battmann` tool supports dependence-aware evidence updates and ensembles, Brier score/log loss/calibration diagnostics, chronological domain/base-rate benchmarks, and as-of-safe reports. Observed ledger timestamps cannot be future-dated; future forecast and scenario horizons remain valid. Live scoring excludes forecasts not physically recorded before accepted resolution; historical replays must use `forecastClass: "backtest"` and cannot support a live-superiority claim. A final system-backed report fails closed until every included claim has a supported review; draft reports surface unresolved reviews. `report_from_store` writes Markdown, machine-readable JSON, and printable HTML. Use an output such as `.elia/artifacts/risk-brief.md` to expose all three companions in Elia's artifact panel.

Four analytic primitives turn the ledger into decision support without ever inventing a number:

- **`risk_assessment`** — a 0-100 score from dated, sourced, weighted factors. Correlated factors are averaged within an independence group so repeated coverage of one driver does not compound the score; the output carries each factor's contribution, a confidence level, a leave-one-group-out sensitivity, and a direction of travel from the supplied factor momentum.
- **`consequence_chain`** — annotates a tree of first-, second-, and third-order consequences. Each edge carries `P(effect | cause)`; the tool returns the path probability to every node, the dominant path, the weakest link, and the deep low-probability tail risks.
- **`find_path` / `object_detail` / `list_objects`** — traverse the evidence-linked ontology built with `upsert_object`/`link_objects`. `find_path` enumerates the bounded dependency paths between two entities (a chokepoint two hops from the client, a tier-2 supplier owned by a sanctioned entity), respecting each link's validity window.
- **`explain_causality`** — a deterministic provenance trace: the upstream contribution paths behind a target entity's risk, scored by link confidence and per-hop decay, with the weakest edge and the evidence gaps on each path named explicitly. It is a static structural trace, not a dynamical propagation model.

The mode is shaped like Palantir's four pillars, at CLI scale:

- **Foundry** — the evidence-linked ontology, plus `register_dataset` / `dataset_lineage` for a hash-chained provenance graph, and a writeback engine (`define_action` → `propose_action` → `decide_action_proposal`). A proposal records an intent and executes nothing; the human decision is a separate signed record and any real side effect is still governed at the tool boundary.
- **Gotham / Maven** — `register_geo_event`, `geo_query` (radius search around a coordinate or a geolocated object), and `situation_snapshot` (a categorised common operating picture with the objects under active geo-pressure). Built only from registered events — there are no live sensor feeds.
- **AIP** — the agent is the reasoning layer, calling the deterministic tools rather than computing numbers itself. Every record carries a `securityClassification` (`public`/`internal`/`confidential`/`restricted`); a read that passes a lower `clearance` withholds classified records and redacts paths through them in `find_path` and `explain_causality`.
- **Apollo** — `define_deployment_target` and `stage_deployment` produce constraint-checked, versioned manifests under `.elia/artifacts/deploy/` (classification ≤ target maximum, required formats present, SHA-256 per file). Transmitting a bundle is a separate step that needs explicit approval.

Every write to the store appends to a tamper-evident `audit_trail` — an actor-stamped SHA-256 hash chain that `audit_trail` re-verifies on read.

Two domains get dedicated primitives:

- **Financial / economic** — `exposure_assessment` aggregates sourced FX / rate / commodity / credit / geographic exposures into a diversified scenario loss: exposures in one independence group add, groups combine by root-sum-of-squares, and an HHI reports concentration. It is a deterministic scenario loss, not a value-at-risk. `define_indicator` / `record_indicator_reading` / `indicator_series` keep a dated macro-indicator ledger with change, trend, and a z-score against the indicator's own history. (The general [`finance`](src/tools/finance.ts) tool remains for corporate DCF and runway.)
- **Defence / security** — `posture_assessment` computes a sourced correlation-of-forces balance between two actors per capability category (a quality-weighted bean-count, explicitly not an operational outcome model); `effector_pairing` runs a deterministic priority-ordered threat-to-effector assignment and names the coverage gaps.
- **Alternatives** — `alternatives` ranks sourced substitutes (suppliers, routes, sources) across weighted, min-max-normalised criteria, with a per-criterion breakdown, an incumbent comparison, and a drop-one-criterion stability check.

`dashboard` renders the entire store as one picture — a derived alert strip (rising forecasts, high-severity events, indicator outliers, live scenarios, review backlog), open questions with their latest probability and revision trend, scenarios, macro indicators with trend and z-score, the geospatial common operating picture, pending action proposals, and the forecast track record — written to `.elia/artifacts/` as **HTML, JSON, and Markdown** so it opens in Elia's workspace panel. It is refreshed on demand from stored, dated, sourced records; it is not a live feed.

These controls make forecasts reproducible and harder to contaminate; they do not establish that Battmann is universally more accurate than external forecasting systems. That requires a large independently resolved live sample, a frozen evaluation protocol, competitive baselines, and external review. SQLite is a local single-workspace store; the classification labels and clearance filter are workspace-level metadata, not enterprise access control, and the deployment actions stage bundles without transmitting them.

Recurring intelligence runs preserve the mode: `elia schedule add --mode battmann --every 6h "refresh the supply-chain risk brief"`. The daemon is local and runs only while its host is online.

### Cybersecurity mode

Start with `elia --cyber` or switch with `/mode cyber`. Cyber mode is for **authorized** security testing, CTF, vulnerability research, and defensive hardening — it acts only against systems the user owns or has written authorization to test, and refuses destructive techniques, denial-of-service, opportunistic scanning of third-party infrastructure, and detection-evasion tooling built for malicious use.

Work is organised around an **engagement** — a `workspace/engagements/<slug>/` folder scaffolded by `new_engagement` with a `SCOPE.md` authorization record that every downstream action stays inside:

- **`run_security_tool`** runs any installed scanner (nmap, nuclei, sqlmap, gobuster, …) for a scaffolded engagement and saves the raw output under `recon/`.
- **`http_probe`** sends one HTTP request to an in-scope target and records the full request/response pair to `recon/traffic.jsonl`. The target host must appear in `SCOPE.md` — hostnames, IPs, and IPv4 CIDR ranges are matched, and an out-of-scope host is refused.
- **`log_finding`** records a confirmed finding and *requires evidence*: one or more files under `recon/` that actually exist. A claim with no tool output behind it is rejected — a finding cites a file or it does not get logged. Findings land in `findings.jsonl` and `findings.md`.
- **`engagement_report`** compiles `report.md` from the logged findings, ordered by severity, with an excerpt of each finding's evidence embedded for reproducibility. Any finding whose evidence file has since gone missing is flagged and the report is marked a **draft**.

`http_probe` and `run_security_tool` reach a live target, so they are critical actions that need an authorization boundary; in unattended mode they are blocked, while `log_finding` (a workspace-local write) is not. Recurring authorized re-tests preserve the mode: `elia schedule add --mode cyber --every 6h "re-run recon for the acme-webapp engagement"`.

### Web research providers

`web_search` is available in every Elia mode and normalizes Exa, Serper, and Brave results into one dated source format. Set `ELIA_SEARCH_PROVIDER=auto` and one or more of `EXA_API_KEY`, `SERPER_API_KEY`, or `ELIA_SEARCH_API_KEY` (Brave). Auto selection prefers Exa, then Serper, then Brave. A returned snippet is discovery evidence, not proof; agents should fetch and inspect material primary sources before relying on a claim.

The capability inventory, architecture boundaries, and current limitations are documented in [`docs/agent-capability-audit.md`](docs/agent-capability-audit.md). The repeatable evaluation matrix and quality thresholds are in [`docs/general-agent-evaluation.md`](docs/general-agent-evaluation.md). Use `/capabilities` inside a session to inspect the live registry of specialist domains, risk classes, preferred tools, and output contracts.

### Coding language and framework support

Elia’s Tech specialist is compatible with projects built in **Python**, **TypeScript/JavaScript**, **Bun**, and **React/TSX**, including common adjacent tooling such as Vite, Next.js, pytest, npm, pnpm, and project-specific scripts. Compatibility means Elia can inspect the project, edit source and configuration, run the declared commands, debug failures, and verify the result; it does not require the target project to use Elia’s own Bun stack.

| Stack | Project signals Elia detects | Typical verification |
|---|---|---|
| Python | `pyproject.toml`, `requirements.txt`, `setup.cfg`, virtual-environment metadata, `.py` files | pytest, project scripts, type/lint tools such as mypy or ruff when declared |
| TypeScript/JavaScript | `package.json`, `tsconfig.json`, `.ts`/`.tsx`/`.js` files | package-manager test, typecheck, lint, and build scripts |
| Bun | `bunfig.toml`, Bun lockfiles, Bun package scripts, `bun test`/`bun run` commands | Bun tests, scripts, typecheck, and build commands |
| React/TSX | React dependencies, `.jsx`/`.tsx`, Vite/Next configuration, component and route structure | project test, typecheck, lint, and production build scripts |

Elia uses the target project’s existing package manager and conventions rather than assuming one toolchain. Before coding in an unfamiliar repository, the Tech agent can use the deterministic `project_profile` tool to report detected stacks, package manager, manifest signals, and declared verification commands. It can work across these stacks in one delegated task, for example updating a Python API, a TypeScript service, and a React client in separate dependency-aware steps, then running the relevant verification for each. `run_command` accepts a workspace-confined `cwd`, so Windows projects do not need fragile `cd`, `cmd /c`, or nested PowerShell composition. Its managed background mode returns success only after bounded startup output proves readiness and registers the process for cancellation and shutdown cleanup.

### End-to-end web deployment

Elia’s Tech and Production workflows can carry a web project through inspect → implement → test → build → preview deploy → live verification. The governed `deployment` tool supports Vercel and Netlify when the project is already linked locally: `.vercel/project.json` for Vercel, or `.netlify/state.json`/`NETLIFY_SITE_ID` for Netlify. It uses the project’s declared build script, returns bounded provider output, extracts the deployment URL, and records a receipt in `.elia/deployments.jsonl`.

Use `{"action":"plan","provider":"vercel","target":"preview"}` to inspect readiness, `{"action":"build","provider":"vercel"}` to run the local build, `{"action":"deploy","provider":"vercel","target":"preview"}` to create a preview, and `{"action":"verify","provider":"vercel","url":"https://...vercel.app"}` to check the live result. Netlify uses the same actions with `"provider":"netlify"`. Preview deployment is reviewable external work. Production deployment is a separate **critical action** requiring exact approval immediately before execution; unattended runs block it. Elia does not create provider projects, perform interactive login, upload secrets, modify domains or environment variables, or report success without provider output and a successful HTTPS postcondition. See [`docs/deployment-workflows.md`](docs/deployment-workflows.md).

### Full VS Code extension

Elia includes a full VS Code client under [`extensions/vscode`](extensions/vscode). It provides an Elia engineering panel, streamed chat and tool events, active-file and selection context, workspace diagnostics, autonomous run controls, task/run/skill tree views, skill-bundle selection, native diff review, environment inspection, receipts, preview deployment, live verification, and production approval controls.

The extension is a thin local client over `elia bridge`; it does not duplicate the model layer or weaken Elia’s governance. Install its dependencies and compile it with `cd extensions/vscode && pnpm install && pnpm run compile`, then configure `elia.cliPath` to the absolute `bin/elia.ts` path for a source checkout or leave it as `elia` for an installed executable. The bridge uses the open workspace as its working root, communicates over local stdin/stdout rather than a TCP server, and keeps provider credentials in Elia’s normal process environment. See [`extensions/vscode/README.md`](extensions/vscode/README.md).

### Bridge protocol over HTTP (for external clients other than VS Code)

The same request/response/event protocol the VS Code extension speaks is also reachable over WebSocket: `elia bridge --http [--port 4319] [--host 127.0.0.1]`. Binds to localhost only unless you explicitly pass a different `--host` — this opens a network-reachable port, which is a meaningfully different exposure than the stdio bridge's local-pipe-only reach, so that's opt-in. Each WebSocket connection gets its own isolated session (own chat history, own pending approvals) — nothing is shared between concurrent clients. This is the basis for a future SDK or a non-VS-Code client (another editor) without re-implementing the protocol.

### Skills: create, install, and select

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

### Codex-inspired architecture

Elia adopts several compatible Codex architecture patterns: an explicit bounded turn loop, durable parent/child task state, policy inheritance through the action governor, one-fleet-per-lead delegation limits, structured verification and postconditions, and a separate read-only reviewer context. Repository guidance is loaded from a bounded `AGENTS.md` or higher-priority `AGENTS.override.md` file as project guidance only; it cannot override the user request, system policy, or Elia’s safety gates.

This improves reliability by keeping planning, execution, verification, review, repair, and delivery distinct and observable. It does **not** make Elia identical to Codex: Elia currently has application-level governance rather than Codex-equivalent OS/kernel sandboxing, managed network policy, secure OS-keyring credential storage, enterprise compliance telemetry, or hosted 24/7 execution. Those boundaries remain explicit in [`docs/codex-comparison-notes.md`](docs/codex-comparison-notes.md) and the capability audit.

### Self-supervised execution and polish

For a fully autonomous run, use `--autonomous` (an alias for `--yolo`):

```bash
bun run dev auto "improve the authentication flow and make the tests pass" --autonomous
```

Elia will orient itself, run a read-only environment preflight, propose a plan internally, delegate independent work, execute the plan, run verification commands, repair failures, and perform a bounded final quality pass before reporting completion. The polish pass is conservative: it can improve concrete rough edges, tests, documentation, and error handling, but it may leave the tree unchanged when no safe improvement is justified. Use `--no-polish` only when a task explicitly requires the older execution path. External side effects such as purchases, publishing, deletion, sending messages, or subscription changes still require explicit confirmation.

### Production hardening and supervised operation

Autonomous runs are durable rather than process-local. Elia persists a versioned goal graph, append-only journal, action ledger, checkpoints, proposal contracts, verification evidence, and a redacted receipt under `.elia/runs/<run-id>/`. Node and action execution uses expiring leases with heartbeat renewal; when a process is interrupted, opening the run reconciles stale leases into retryable or human-review states instead of silently duplicating work. `elia resume <run-id>` reports any recovered stale nodes or actions before continuing.

The completion assessor records whether a run is `verified`, `partial`, `blocked`, `failed`, or `aborted`, with confidence, evidence, blockers, and next actions. A model saying “done” is not treated as proof, and a run requested as completed is downgraded to `needs-attention` if the durable graph cannot prove completion. Every autonomous run now has a parent task session linked from its receipt and journal; child workers preserve acceptance criteria, verification commands, evidence, blocker reasons, and retry/takeover guidance in the live dashboard.

Tool execution is bounded and cancellable end to end. Shell commands run in process groups, terminate descendants on timeout or operator cancellation, and cap captured output. Browser bridge, CDP, and provider requests have deadlines; provider retries are disabled at the transport boundary so the agent-level fallback policy remains visible and bounded. Set a default wall-clock budget with `ELIA_MAX_RUN_MS`, or override it per invocation with `elia auto "<goal>" --max-run-ms 900000`. Autonomous profiles also impose finite governed-tool budgets (fast 120, balanced 300, thorough 600 by default); override a direct run with `--max-actions N`. When a tool request would exceed the budget, Elia records the blocked request, stops claiming success, and leaves an actionable `needs-attention` recovery state rather than retrying indefinitely. Budget use, token usage, recovery counts, verification results, and action failure classes are included in the run receipt.

Every delegated plan and proposal may declare `acceptanceCriteria`, `verificationCommands`, `sideEffects`, and `recovery`. These fields are persisted and shown for approval. Plans are bounded to 32 work steps and 16 verification commands; oversized goals receive split-and-resume guidance instead of creating an unmanageable unattended run. Verification commands are checked by the same autonomy governor as ordinary shell actions; credential reads and outbound data writes are critical and fail closed when unattended. Structured JSONL events, `--plain`, `--quiet`, `--verbose`, and `--json` modes make long-running and CI execution observable without changing the underlying model prompt or its raw generation behavior.

For specialist work, `elia agent "<request>" --dry-run` performs routing only and prints the selected persona chain and rationale without running specialist tools or side effects. Use this to inspect an execution plan before allowing a full specialist turn.

### Background autonomy and safe unattended actions

Elia now has a local, durable background control plane for recurring AI goals. **Autonomous work is supervised by default**: the plan requires an operator decision, and review or critical tool actions require an approval boundary. Use `--supervised` or `ELIA_SUPERVISION=supervised` to make that intent explicit. `--unattended`, `--yolo`, and `--autonomous` are opt-in exceptions; unattended mode still blocks critical actions and never treats the absence of a prompt as permission for publishing, sending, purchasing, authentication, destructive changes, or other irreversible effects.

Operators can inspect or stop a durable run from another terminal without touching its process directly:

```bash
elia control status
elia control pause <run-id>
elia control stop <run-id>
elia resume <run-id>             # only after reviewing the receipt and blockers
```

Pause and stop requests are written atomically under the run directory, validated against a safe run-ID format, picked up by the owning process at a bounded polling interval, recorded in the run journal, and propagated to the internal abort signal. `Ctrl+C`, the `/task` dashboard’s `c` control, wall-clock budgets, and governed action budgets remain additional stop boundaries. A stopped run is reported as paused/aborted rather than falsely completed.

For one-off safe work, `elia auto "<goal>" --unattended` runs the plan without routine interactive prompts; it still uses the autonomy governor and stops at consequential actions. Create a schedule, inspect it, pause or resume it, and run due work through a single-flight daemon:

```bash
elia schedule add --every 1h --max-actions 300 --title "Repository health" "Inspect the repository, run the declared checks, and report only evidence-backed findings"
elia schedule list
elia daemon --once
elia daemon --poll-ms 30000
```

Schedules are stored atomically in `.elia/schedules.json`. Each claimed run has a lease, a bounded wall-clock budget, an optional finite action-count budget (`--max-actions`, capped at 10,000), a persisted outcome, and a recovery path if the worker stops. The daemon invokes `elia auto` with unattended governance, but unattended does **not** mean unrestricted: read-only, reversible, and idempotent work may proceed; non-zero command results, missing browser transports, unmet postconditions, stale leases, exhausted action budgets, and ambiguous outcomes become retryable or human-review states. Concurrent daemons use a reclaimable store lock and skip already-claimed work instead of terminating. Sending messages, publishing, purchasing, deleting, changing account state, production mutations, authentication, CAPTCHA, and payment steps remain blocked or require exact user approval/takeover.

Tool actions now carry an internal contract containing an idempotency key, readiness preconditions, postconditions/evidence, bounded retry behavior, and an escalation disposition. The environment preflight reports `ready`, `missing-config`, or `unavailable` for model, browser, source-control, data-science, and deployment capabilities without returning secrets or claiming that a credential is authorized. A successful model response is never treated as proof that an external-world action succeeded.

This is **Gemini Spark-inspired**, not a claim that Elia is Gemini Spark. Google’s Spark product is a separate consumer agent with its own Google-hosted tasks, connected apps, schedules, and supervision model [gemini-spark]. Google’s support material also describes Spark as experimental and supervised [gemini-spark-support]. Elia’s `google` provider calls Gemini models through the documented OpenAI-compatible Gemini endpoint [gemini-api], while Elia’s scheduler and local browser/communication adapters provide its own control plane. The repository does not claim a direct Spark API or Spark account integration. A local daemon also cannot guarantee 24/7 operation in the ephemeral sandbox: for unattended execution across restarts, run it on an always-on user machine or a properly hosted worker with explicitly configured connectors, credentials, monitoring, and stop controls.

### Production SaaS delivery

The Production Engineering specialist is routed for release, deployment, migration, rollback, observability, SLO, incident, backup, and CI/CD requests. Its read-only `production_readiness` tool scans the actual repository for CI configuration, deployment manifests, verification scripts, environment/secret hygiene, database and migration evidence, observability, health checks, rollback, incident, and backup artifacts. It returns a scored evidence checklist and recommendations; a detected file is never treated as proof that a production system is safe or deployed.

Production work remains bounded and auditable. Elia can inspect a repository, prepare changes, run dry-run or staging checks, write release and incident plans, and verify observable postconditions. Deployment, production data mutation, destructive migrations, secret rotation, and irreversible infrastructure actions require explicit approval and project-specific credentials. No local repository audit can prove that an external environment is healthy.

### Data science and finance workflows

The `data_science` tool provides deterministic, reproducible workflows for CSV, TSV, JSON, and JSONL files: schema and type profiling, missingness and duplicate detection, explicit data-quality validation, grouped summaries, Pearson correlation, and bounded ordinary-least-squares linear regression. It reports bounded input size, excludes invalid values from aggregates rather than silently repairing them, and clearly states that association is not causation. Advanced statistical inference, causal analysis, experiment design, and domain-specific leakage review still require project-specific code and acceptance criteria.

The `visualize` tool creates bounded bar charts and flow diagrams from structured values. It renders a readable terminal preview immediately, then saves a deterministic SVG and accessible Markdown companion under `.elia/artifacts/` for `/artifact` and the existing local `preview` workflow. It rejects raw HTML/SVG/scripts/URLs, validates finite values and graph edges, strips terminal controls, escapes generated markup, serializes repository writes, and refuses to replace a different artifact with the same slug.

The `finance` tool provides deterministic unit-economics, runway, bounded scenario, and DCF valuation calculations with sensitivity cases. Every result includes the input basis, reference date, assumptions, source disclosure, confidence caveat, formulas or interpretation, and the required financial-analysis disclaimer. It does not fetch market data, decide personal investments, establish accounting policy, or substitute for a licensed adviser. For company or investment analysis, use primary filings or approved data sources and preserve fiscal-period and metric-basis traceability.

### Native Excel and presentation workflows

Elia’s Office workflow is now first-class for local workbooks. The `spreadsheet` tool supports `inspect`, `analyze`, `audit`, and bounded `write` operations. Analysis selects numeric measures, computes totals and averages, groups results by categorical columns, counts formula cells, reports blank values, detects duplicate keys when requested, and returns structured JSON that can be reconciled before it is used in a decision. Workbook writes are atomic, limited to 200 cell operations per request, and must create an output file inside the current repository or `workspace/` directory rather than silently overwriting an arbitrary source file.

The `presentation` tool turns a verified workbook into an editable management `.pptx` deck. It creates KPI cards, grouped-performance charts, audit findings, and recommended actions, and writes a JSON sidecar containing the source, analysis, and audit data. Its `verify` action checks the PPTX package and slide count and can optionally render through LibreOffice when available. The generated deck is an artifact that should still be visually reviewed before publication; native creation does not claim that the deck is automatically perfect for every template or brand system.

Example request:

```text
Analyze workspace/q3-sales.xlsx by Region using Sales, audit duplicate Order IDs, and create a management presentation with the top risks and recommended actions.
```

The finance, business, data, research, and automation specialists can use these Office tools. Presentation and workbook generation remain governed as reviewable artifact actions, while inspection and analysis are read-only. This keeps the Office layer broad without weakening the existing model behavior or action safety boundaries.

### External communication and browser tasks

Elia can prepare and, when the user has enabled a trusted browser or service connector, execute external-party workflows such as drafting email to a co-founder, preparing a calendar invitation, or updating a web application. The system deliberately separates **draft** from **send**: it must verify the recipient, channel, content, attachments, timing, and final page or connector state, and obtain explicit approval immediately before sending, publishing, deleting, purchasing, transferring, or changing account state. Login, CAPTCHA, payment, and sensitive-input steps require user takeover. If Gmail, Calendar, Outlook, Slack, an SMS provider, or another connector is disabled, Elia must report that limitation instead of pretending it can access the account.

The `communication` tool provides a connector-neutral durable workflow for `status`, `draft`, `inspect`, `list`, `send`, `verify`, and `cancel`. Drafts are stored under `.elia/communications/` with atomic persistence and can be resumed after interruption. Sending requires an exact five-minute approval token bound to the unchanged recipient, channel, body, attachments, and schedule. The configured adapter must return an acceptance response, and Elia preserves the resulting external identifier or failure receipt; it never claims that a message was delivered merely because a model intended to send it.

Configure `ELIA_COMMUNICATION_BRIDGE_COMMAND` for a trusted wrapper that accepts one JSON request on stdin, or `ELIA_COMMUNICATION_MCP_SERVER` for a communication connector. Use the communication status action before attempting external work. Credentials should remain in the browser session or adapter environment, never in prompts, source files, or command-line arguments.

### Browser tasks

Elia exposes a lead-agent `browser` tool for status checks, navigation, refresh/back/forward, page snapshots, text extraction, clicking, typing, key presses, bounded scrolling, waits, wait-for conditions, and explicit post-action verification. Safe observational operations can retry once; mutating actions are not blindly retried because a duplicate click or submission can create a side effect. Optional `expectText` and `expectUrl` checks force the action to be followed by a fresh page observation, so a successful transport response is not confused with a successful UI state change. It never pretends browser work succeeded: every configured browser action returns its result to the agent, and the agent is instructed to re-read the page after meaningful actions.

The browser tool connects through an enabled user-browser connector, a trusted local bridge, or a Chrome DevTools endpoint:

```bash
# Direct connector route, when the enabled connector exposes browser_navigate, browser_snapshot, etc.
# Browser MCP tools configured in .elia/mcp.json are auto-detected.
# Set this only to select one server when several provide browser_* tools:
ELIA_BROWSER_MCP_SERVER="My Browser" bun run dev "open the dashboard and summarize its current status"
# or
ELIA_BROWSER_BRIDGE_COMMAND="/path/to/your/browser-bridge" bun run dev "open the dashboard and summarize its current status"
# or
ELIA_BROWSER_CDP_URL=http://127.0.0.1:9222 bun run dev "inspect the active page"
```

Connected MCP tools named `browser_*` are called through Elia's existing live MCP client, so `manus-mcp-cli` is not required for configured `.elia/mcp.json` servers. If only the legacy external MCP route is configured, override nonstandard tool names with variables such as `ELIA_BROWSER_NAVIGATE_TOOL` and `ELIA_BROWSER_SNAPSHOT_TOOL`.

A bridge receives one JSON request on stdin and should return one JSON or text response. Keep login credentials in the bridge or browser session, never in Elia prompts, source files, or command-line arguments. Elia must not bypass login challenges, CAPTCHAs, paywalls, or site safety controls. Actions that may send, buy, publish, delete, or change subscriptions pause and return an exact five-minute `confirmationToken`. The user must approve that exact action before the token is supplied; tokens are bound to the action details and cannot be reused for a changed target or message. `wait_for`, `expectText`, and `expectUrl` are intended for stateful sites where navigation or clicks complete asynchronously; they time out rather than claiming success.

### MCP servers

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

#### Adding servers and connectors from the terminal

You don't have to hand-edit `mcp.json`. In the interactive terminal:

- **`/mcp`** — everything configured, connected or not, with its tools. Add a server from a curated catalog (GitHub, Filesystem, Postgres, Slack, Playwright, …) or by hand, `reload` after an edit, and per-server **test connection / enable / disable / remove**. `/marketplace` → `mcp` (or `connector`) opens the same thing as a sub-menu: **Installed / configured**, **Suggested** (the catalog), **Add custom** — the same shape every `/marketplace` source uses (npm, pip, skills all get an *Installed* list and a *Suggested* shortlist too).
- **`/connector`** — the same, scoped to **remote** MCP servers reached over HTTP instead of a local process. Pick one from the catalog (DeepWiki, Context7, Hugging Face, Notion, Linear, Sentry, Stripe, hosted GitHub, …) or paste any Streamable-HTTP endpoint URL plus an auth header. Elia writes the entry, reconnects, and tells you the tool count right away.

Every add ends with a live reconnect, so the tools are usable in the same session — and you choose whether the entry lands in the project file or your personal `~/.elia/mcp.json`.

#### Remote connectors

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

### Delegating to the real OpenAI Codex CLI

The `codex_delegate` tool (dev mode, top-level only) hands a task to the real, separately-installed [OpenAI Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`, then `codex login` with your own ChatGPT subscription or an API key, exactly as you would use it standalone. Elia only shells out to the real binary (`codex exec ... --approve-for-me`, scoped to a given directory, its final answer captured and returned) — it does not implement Codex's authentication itself, does not read or reuse its stored credentials, and does not route elia's own model calls through it. If `codex` isn't installed or not signed in, the tool says so and stops rather than trying to authenticate on your behalf. Like `task`/`preview`, this is governed as a `critical`-risk action requiring explicit approval — elia's governor has no visibility into what Codex does once a task is delegated to it.

### Terminal UI

On a real TTY, `bun run dev` / `elia` uses the Ink terminal workspace; plain or piped output keeps the streaming fallback. Assistant replies render headings, lists, checklists, blockquotes, fenced code, tables, rules, and safe visible links without exposing terminal control sequences. The live Workspace panel shows structured plans, parallel subagents with their provider/model and dependency wave, other chats, and recent artifacts.

`edit_file` and `write_file` results render as a colored unified diff (folded to the changed hunks; `/expand` reprints any tool result the scrollback truncated). Visualizations render their terminal chart without requiring expansion. A line starting with `!` runs the rest as a shell command and carries its output into the next turn as context. `/team` shows the active deep/fast tiers and configured role routes; `/cost` shows usage; `/export [path]` writes the conversation to Markdown.

### LSP diagnostics on every edit

`write_file` and `edit_file` check the changed file against a real language server, not just a text diff. If a server is available for the file's language, elia opens/updates the document and appends any errors or warnings the server reports directly to the tool result — catching a broken reference or a type error the instant it's introduced, well before the next `tsc`/`pytest`/`go build`. One server process per language is started lazily and reused for the rest of the session.

Elia doesn't install these — bring your own, same as any editor:

| Language | Server it looks for |
| --- | --- |
| TypeScript / JavaScript | `typescript-language-server` |
| Python | `pyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |

A missing binary just means diagnostics are silently unavailable for that language — the tool's normal result is unchanged, nothing blocks or errors. Set `ELIA_LSP=off` to disable this entirely.

### Manual model discovery and raw model performance

`/model` first shows every known provider and its readiness. Selecting a provider queries that provider’s models endpoint **on demand**, then opens a second picker containing the available model IDs. Direct selection remains available with `/model <provider> <model-id>` or `/model <model-id>` for the current provider. This keeps startup fast and lets users choose newly released provider models without waiting for a code release. If a provider does not expose a models endpoint, its configured default and direct model-ID syntax still work.

Elia does not replace the underlying model with a smaller “agent personality,” hidden chain-of-thought imitation, or prompt-heavy wrapper. The autonomy layer contributes tools, planning, safety gates, routing, verification, and recovery; the selected model receives the normal request through the existing provider adapter. The user can therefore select the model manually while keeping its native reasoning and generation capability intact.

### Coding speed, accuracy, and benchmark discipline

Elia keeps speed and correctness separate. Read-only file, data, and web observations can run in a bounded higher-concurrency pool; mutating tools, shared browser navigation, and external side effects remain conservative. The optional fast model tier is used for scouts and low-risk summaries, while builders, testers, critics, security reviewers, and final verification retain the deep tier. `ELIA_TOOL_CONCURRENCY` is capped at 8 for read-only batches and at 4 for batches that include mutations.

The coding benchmark records per-task steps, elapsed time, stop reason, token usage, cache hits/misses, total agent time, and suite wall-clock time. Promotion is correctness-first: a candidate that regresses any previously passing task is rejected, and a tied-correctness candidate must show a material token or wall-clock improvement. This prevents Elia from becoming “faster” by skipping verification or silently lowering task quality.

### The fast tier (optional, recommended)

Elia routes work across two model tiers. The **deep** tier plans, builds, and reviews. The **fast** tier does the high-volume legwork — read-only scouts, summarising, end-of-run note taking — where a cheap model is indistinguishable but several times quicker. Set `ELIA_TOOL_CONCURRENCY` to tune tool batches; read-only reconnaissance is bounded at 8 concurrent calls, while any batch containing mutations or external side effects remains capped at 4. Speed controls never remove deep-tier implementation or verification work.

```bash
ELIA_FAST_PROVIDER=groq
ELIA_FAST_MODEL=openai/gpt-oss-20b
```

Investigation is where an agent spends most of its wall clock, and almost none of it needs the strong model. With a fast tier configured, a five-scout recon sweep costs a fraction of what it would otherwise, while every actual decision still goes through the deep model. Leave it unset and both tiers are the same model — behaviour is identical, you just don't get the speed-up.

### Per-role providers (optional, for true multi-model fleets)

Any role can be pinned to its own dedicated provider, on top of (or instead of) the tier system — e.g. run scouts on Groq for raw inference speed while critics stay on Claude for judgment:

```bash
ELIA_SCOUT_PROVIDER=groq
ELIA_SCOUT_MODEL=openai/gpt-oss-20b
```

The pattern is `ELIA_<ROLE>_PROVIDER` / `ELIA_<ROLE>_MODEL` / `ELIA_<ROLE>_BASE_URL` / `ELIA_<ROLE>_API_KEY` for any of `SCOUT`, `BUILDER`, `FRONTEND`, `BACKEND`, `CRITIC`, `SECURITY`, `BUGHUNTER`, `TESTER`, `SCRIBE`. Unset roles fall back to their tier exactly as before.

This is what makes a fleet a genuine multi-model system rather than one model wearing different hats: a wave of five scouts and a critic isn't five-plus-one calls to the same provider's rate limit, it can be two calls to two providers running fully in parallel. Fleet concurrency scales with how many distinct providers a batch actually uses (`fleetConcurrency` in `src/autonomy/fleet.ts`), so spreading roles across providers also widens how much runs at once — a single-provider fleet still caps at 4 concurrent workers, but a two-provider fleet can run 8, up to a hard ceiling of 16.

Use `/team` during an interactive session to see the routes Elia actually resolved. Independent workers share a dependency wave only when their work is separable; colliding or dependent writers remain serialized, and multi-persona parallel investigation waves are read-only before deep-tier synthesis.

## Usage

```bash
bun run dev                    # interactive session
bun run dev "list the files in this directory"   # one-shot prompt
bun run dev --continue         # resume the most recent session in this directory
bun run dev --resume <id>      # resume a specific session

bun run dev auto "<goal>"                # plan, delegate to a fleet, verify, repair, and learn — end to end
bun run dev auto "<goal>" --fast         # bounded fast path for simple work: one reviewer, one repair, no polish/lessons
bun run dev auto "<goal>" --thorough     # deeper bounded review and repair for high-risk changes
bun run dev auto "<goal>" --max-run-ms 900000  # hard wall-clock budget for this run
bun run dev auto "<goal>" --yolo         # same, without pausing for plan approval
bun run dev bench                        # score the current elia against its own benchmark suite
bun run dev evolve                       # elia proposes and tries one improvement to its own source
bun run dev evolve -n 3 --dry-run        # three generations, evaluated but never promoted to live source
bun run dev skills                       # list tools elia has written for itself
bun run dev skills path                  # print skill folders and the manual skill contract

bun run dev skills candidates            # show repeated work that could become a new tool
bun run dev skills synth                 # write a tool for the strongest candidate
bun run dev config                       # show provider readiness without printing keys
bun run dev config set --provider nvidia # securely save a provider key and model

bun run dev runs                         # list past autonomous runs
bun run dev runs <id>                    # show one run's timeline, graph state, and forkable points
bun run dev fork <id> --at <n> --with "<change>"   # re-plan an earlier run from a checkpoint
bun run dev resume <id>                    # continue a durable goal and reconcile pending approvals and stale leases
bun run dev agent "<request>" --dry-run       # show specialist routing without executing tools

elia --dev                    # explicit dev mode (the default)
elia --help
elia --version
elia config                                      # show provider readiness
elia config set --provider nvidia                 # securely add an API key
elia control status                               # inspect active runs and control requests

# Production-friendly output modes
elia auto "run the verification suite" --json    # stable JSONL lifecycle events for CI/orchestration
elia "summarize the project" --plain             # no color, animation, or in-place redraws
elia "summarize the project" --quiet             # final answer and essential failures only
elia "summarize the project" --verbose           # additional progress detail
```

In an interactive session, type `exit` or press Ctrl+C to quit. Elia's startup logo and live animation appear only in interactive dev mode. Use `--plain` or `ELIA_UI_MODE=plain` for an accessible, no-color, no-animation presentation; `--quiet` suppresses progress noise; and `--json`/`--jsonl` emits one stable JSON object per lifecycle event. Human-readable errors go to stderr so stdout can be safely redirected or piped.

While a request is running, Elia maintains task sessions in `.elia/tasks.json`. Coding work, browser work, and queued or confirmation-waiting work are shown as separate task types. The live **Action window** reports the current action, status, and step count from real tool events. Type `/task` to open the task dashboard; use Up/Down or Left/Right to move between tasks, PageUp/PageDown or Home/End for large task lists, `c` to stop an active task cooperatively, and Escape or `q` to close the dashboard. The dashboard also works in piped output by printing a plain task list instead of using terminal cursor control.

The `/model` and `@skills` pickers are bounded and support PageUp/PageDown plus Home/End, so large provider catalogs and skill libraries do not flood the terminal. Tool previews are redacted before they reach scrollback; use the structured run receipt for full audit data rather than relying on terminal text.

In manual mode, Elia performs its preliminary risk check and asks before risky user-requested work. Auto mode skips that preliminary check, but governed irreversible actions still require explicit approval unless unattended execution was explicitly requested with the appropriate autonomous flag. This distinction is shown in the startup status line and is not merely cosmetic.

After every response you'll see a dim usage line — `2.5s · 1,840 tokens · $0.0041` — and a `Session: N turns · ... · $... · ...` total when you exit. Sub-agent usage (`task` calls) counts toward the total even though sub-agents run silently. Cost is a best-effort estimate from a small hardcoded pricing table (`src/usage.ts`) verified against provider pricing pages as of 2026-08-18 — providers change pricing without notice, so treat it as orientation, not a bill. An unrecognized model shows "cost unknown" rather than a fabricated number. Autonomous runs also write `.elia/runs/<run-id>/receipt.md`, `receipt.json`, and a redacted `actions.ndjson` ledger that records the actor, role, tool, risk decision, outcome, and replay pointers without storing credential-like inputs.

Elia has a `workspace/` folder (created on first use, next to `.elia/` but visible — not a dotfile) for standalone output: prototypes, generated pages, anything that isn't an edit to your existing project. Ask it to show you something and it calls `preview`, which opens a real Chrome window (falls back to your OS default browser if Chrome isn't found, and says so) — files under `workspace/` are served locally with push-based live-reload over a WebSocket, so the window updates itself as elia keeps editing, no manual refresh. An already-running URL (e.g. a dev server elia started itself) opens directly instead, without live-reload.

## Autonomous work: `elia auto`

For plan-first work, `elia plan "<goal>"` and interactive `/plan <goal>` enter the same structured autonomous workflow as `elia auto`: orient, submit a validated proposal, persist it to `.elia/artifacts/plan.md` and `.elia/runs/<run-id>/plan.md`, request approval, execute dependency waves, verify, and review. A bare `elia plan` or `/plan` displays the latest plan; `elia artifact [name]` or `/artifact [name]` displays a bounded Markdown artifact under `.elia` without initializing a model provider.

```bash
elia auto "add rate limiting to the API client"
elia auto "migrate the config loader to zod" --yolo   # skip the approval gate
elia auto "fix the race condition in the queue" --variants 3   # best-of-3, see below
```

This runs a full work cycle instead of a single conversation turn. Each phase has its own tool set and its own prompt, so elia is never simultaneously exploring and committing:

1. **Orient** — reads the project, then sends several read-only *scouts* out in parallel on the fast tier to answer specific questions. Recon is the part of a task that parallelises best and matters least which model does it.
2. **Propose** — submits a structured plan: what it found (with real file paths), what it's assuming, the steps decomposed into dependency waves, the risks, and the exact commands that will prove the work is correct. **Nothing has been changed at this point.** You approve it, reject it, or type what to change and it re-plans. A plan with no verification command is rejected before you ever see it.
3. **Execute** — runs the steps in dependency waves: everything in a wave goes at once, each wave waits for the last. Steps that claim the same file are automatically split into separate waves, even if the planner forgot to declare a dependency. The planner assigns *frontend* and *backend* specialists to their respective steps so UI work and server work genuinely run side by side instead of one generalist doing both serially. A live status board shows every worker, its role, and what it's doing. Workers publish findings to a shared blackboard as they go, so the second wave inherits what the first learned. Every tool call is checked by the autonomy governor before it runs: safe work flows, reversible review work can flow in unattended mode, and irreversible shell/browser actions are blocked or require exact approval.
4. **Verify** — runs your verification commands, fail-fast. If they pass, three specialist reviewers run concurrently against the same diff: a *critic* (was what was promised actually done), a *security* reviewer (exploitable weaknesses), and a *bughunter* (functional/logic defects). Their verdicts are merged — any one voting "revise" blocks — so review runs at the speed of the slowest single reviewer instead of three run one after another.
5. **Reflect** — on failure, feeds the actual error back into a repair pass and re-verifies. Bounded retries, then it stops and says a human is needed rather than thrashing.
6. **Learn** — appends durable, project-specific lessons to `.elia/lessons.md`, which is injected into the *next* run's planning. Elia gets better at your project over time instead of rediscovering it every session.

### Roles

The `task` tool takes a `role`, and the role decides three things before a token is generated: which model tier runs it, which tools exist at all, and what the worker optimises for.

| Role | Tier | Can write? | For |
|---|---|---|---|
| `scout` | fast | no | read-only investigation; run several in parallel |
| `builder` | deep | yes | making the actual changes |
| `frontend` | deep | yes | UI/component/styling/client-side changes; may coordinate a bounded child fleet |
| `backend` | deep | yes | API/business-logic/data changes; may coordinate a bounded child fleet |
| `designer` | fast | no | page structure, visual direction, responsive behavior, and interaction specifications |
| `accessibility` | fast | no | semantics, keyboard flow, contrast, focus, responsive behavior, and assistive-technology review |
| `critic` | deep | no | adversarial review of work already done — was it actually done as promised |
| `security` | deep | no | adversarial review for exploitable security weaknesses, run alongside `critic` and `bughunter` |
| `bughunter` | deep | no | adversarial review for functional/logic bugs, run alongside `critic` and `security` |
| `tester` | deep | yes | writing and running tests, diagnosing failures |
| `scribe` | fast | yes | docs and comments only |

A scout physically cannot damage your tree — `write_file` and `edit_file` aren't in its tool set — so aggressive parallel recon carries no risk.

### Hierarchical coding delegation

Coding leads use a bounded `delegate_tasks` capability when a task is large enough to benefit from specialist decomposition. A frontend lead developing an initial landing page can delegate a design brief, frontend implementation, accessibility review, and test/documentation work as separate child assignments. The scheduler runs independent assignments in parallel, serializes declared dependencies and file collisions, passes completed-wave reports into later waves, and keeps every worker in the same governed working directory.

The hierarchy is deliberately bounded rather than recursively open-ended. A lead can create at most four child assignments in one delegation call, and child workers run at depth one without any further delegation capability. Child workers inherit the parent run’s cancellation signal, autonomy governor, provider fallback behavior, shared blackboard, durable goal graph, and working directory. Their reports and progress appear in the task dashboard with role, depth, and parent lineage, while the durable graph records child nodes and action idempotency keys.

Delegation is not a substitute for verification. The lead remains responsible for integrating reports, resolving conflicts, running the project’s tests and type checks, and satisfying the autonomous run’s final critic, security, bughunter, verification, and approval gates. If a child fails, the failure is returned explicitly to the lead instead of being silently treated as success.

### Best-of-N: `--variants N`

`--variants N` runs the *execute* phase N times in parallel, each in its own isolated git worktree — genuinely independent implementation attempts of the same approved plan, not N copies hoping for different random output. Verification (typecheck/tests/build — an objective, cheap, non-LLM oracle) picks the winner: an attempt that fails verification can never win over one that passes, no matter how confident its own report sounds. Only the winning worktree's files are copied into your real working tree; every worktree, winner included, is discarded afterward, so you're never left with stray branches or directories. If every attempt fails verification, it falls back to the first one and hands off to the normal reflect/repair loop exactly as a single-attempt run would.

It deliberately skips the critic/security/bughunter panel per variant — paying for three reviewers on N-1 attempts that get thrown away regardless would be pure waste. That panel still runs once, on the merged winner, exactly as it does without `--variants`.

Cost is roughly Nx the execute phase (N parallel builder fleets instead of one) for the same wall-clock time, so it's opt-in — default is 1, today's behavior, unchanged. Worth it when an implementation approach is genuinely uncertain and you'd rather spend tokens than guess wrong; not worth it for a change whose shape is already obvious.

## Time travel: `elia runs` / `elia fork`

Every autonomous run journals its phases, checkpoints the exact message history each one started from, and persists `.elia/runs/<id>/goal-graph.json` with the proposal nodes, dependencies, action reservations, approvals, and evidence required for completion.

```bash
elia runs                 # list runs
elia runs <id>            # timeline + forkable decision points
elia fork <id> --at 1 --with "use a token bucket instead of a fixed window"
```

A fork replays the investigation that was already correct — for free — and only re-takes the decision. Normally exploring "what if the plan had been different" means paying for the whole run again. The original run is untouched; the fork gets its own id, so you can compare them. `elia resume <id>` is different: it continues the same durable graph, skips completed nodes, reopens only nodes with unresolved actions, and reconciles stale execution leases plus pending plan or side-effect approvals before continuing. `elia runs` includes a recovered-node count, while `elia runs <id>` shows the graph, timeline, verification evidence, and receipt-oriented diagnostics.

## Self-improvement: `elia bench` / `elia evolve`

```bash
elia bench                # score the current elia
elia evolve               # one generation
elia evolve -n 3          # three, each building on the last
elia evolve --dry-run     # evaluate but never touch the live source
```

`src/evolve/suite.ts` is elia's fitness function: real tasks in real temporary repositories. Edit one occurrence of three identical lines. Find where a symbol is *defined*, not called. Fix a failing test without touching the test. Propagate a rename to every call site including the internal one. And the hard one — fix a failing test where a shared constant serves two callers with different requirements, so the obvious fix breaks the other test.

Every check is exact: file contents, exit codes, and hashes of the files the agent was told not to touch. **No model is in the scoring path.**

A generation goes: measure the current elia → read the whole ledger of what's already been tried → form one specific hypothesis about the weakest link → implement it in a sandboxed copy → gate it → promote only if the benchmark agrees.

What makes this recursive rather than just repeated:

- **The candidate is measured by running the candidate.** Benchmark tasks are launched as child processes from the sandbox's own source, so a change to the agent loop, the system prompt, or a tool description is measured through its own effects.
- **Mutations are allowed to target the parts that do the improving** — the planner prompt, the role definitions, the loop's policy on batching and delegation. A generation that makes elia a better engineer makes the next generation's attempt better too.
- **Each generation stands on the last.** A promoted change becomes the new baseline, and the ledger (`.evolution/ledger.jsonl`) carries both the wins and the rejections forward, so generation 12 doesn't re-propose what generation 3 already disproved.

And what keeps it honest:

- **The benchmark is off limits.** `src/evolve/suite.ts`, `fitness.ts`, `engine.ts`, `ledger.ts`, `sandbox.ts`, and `benchTask.ts` cannot be modified by a candidate — touching any of them voids the generation outright. A model asked to improve its score can improve it far more cheaply by editing the benchmark, and it will: not from malice, but because that genuinely is the shortest path to the stated objective.
- **The whole gate is off limits.** Existing tests, `package.json`, and `tsconfig.json` are immutable too, and their changes are included in candidate diffing. A candidate cannot win by deleting an assertion or weakening type checking.
- **Candidate builders are confined to the sandbox.** Their file tools reject paths outside the copied tree, and their shell can only run `bun test` or `bun run typecheck`, always with the sandbox as its working directory. The live installation is not exposed as an editable target during mutation.
- **A tie is a rejection.** Equal pass rate needs a ≥5% token or time win to promote, so benchmark noise can't manufacture a false victory that later generations then "build on".
- **A win has to repeat.** Every provisional winner is measured in a second, independent candidate/baseline pair (run in reverse order) and is rejected unless the improvement reproduces. One lucky model sample cannot promote itself.
- **A regression is disqualifying** even when the total ties, so capabilities can't be quietly traded for each other.
- **Provider outages don't count as failures.** A transient 500 or rate limit is retried; a wrong answer never is. Otherwise a network blip could reject a genuinely better candidate, and the ledger would carry that false result into every later generation.
- **Transient provider calls recover in place.** The shared agent loop retries connection, rate-limit, timeout, and 5xx failures when they occur before any text is streamed. It never retries a partially emitted response, which would duplicate output or tool calls.
- **The live tree is only touched after the gate passes**, and everything it overwrites is backed up to `.evolution/gen-N-backup/`. Promotion is transactional: a partial copy is rolled back, including removal of newly introduced files.

`elia evolve` makes real API calls and, on success, modifies elia's own source. Use `--dry-run` to see what it would do first.

### `elia bench-latency` — the overhead the model doesn't explain

`elia bench` needs a real model and measures whether elia is *correct*. `elia bench-latency` needs neither an API key nor a network, and measures whether elia is *fast* — specifically, how much wall-clock elia's own machinery adds on top of whatever the model costs.

```bash
elia bench-latency                     # compare against the committed baseline
elia bench-latency --realistic         # add simulated 400ms TTFT + 8ms/token model pacing
elia bench-latency --live              # run the scenarios against the real configured model (real API calls)
elia bench-latency --update-baseline   # record the current numbers as the new baseline
elia bench-latency --strict            # fail (not just warn) on a wall-clock regression — same-machine only
```

`--live` reports real round-trips, output tokens, tokens/sec, and wall-clock per scenario for whatever provider is configured — useful for seeing how a given model actually behaves (does it batch its reads, or walk the directory one turn at a time?).

A deterministic scripted provider replays the assistant turns a competent model *would* make on each scenario (`src/bench/latency/scenarios.ts`), so the only thing that moves between runs is elia. The scenarios target the paths whose cost elia owns: streaming a bare turn, running six independent reads in one batch, a read→edit cycle, and a grep followed by opening its hit. For each it records round-trips, how many tool reads were served from the speculative cache instead of blocking, time-to-first-token, and median wall-clock — plus a separate cold-start measurement (a bare `elia` process loading its module graph and exiting).

The structural metrics — round-trips and speculative hits — are fully deterministic, so **`bun test` gates on them**: a change that adds a model round-trip or makes a previously pre-run read block fails CI. Wall-clock has run-to-run noise even with a scripted model, so it only warns unless `--strict`, and the committed baseline's absolute millisecond numbers are machine-specific.

## Learned tools: `elia skills`

```bash
elia skills               # list the tools elia has written for itself
elia skills candidates    # show repeated work that could become a tool
elia skills synth         # write a tool for the strongest candidate
```

Elia counts two kinds of repetition as it works, for free, with no model involved: shell-command *shapes* (`git diff --stat HEAD~1` and `git diff --cached` are the same habit) and sliding trigrams of tool names (a `grep → read_file → edit_file` routine that costs three round-trips every time). Once a habit crosses a threshold, `elia skills synth` has a builder write a real tool for it — plus a test — into `~/.elia/skills/`.

A synthesized skill is only kept if it survives the same gate a human contribution would: it has to import cleanly, expose a valid tool schema, and pass a test that actually ran. Anything else is quarantined rather than loaded. Skills are ordinary modules exporting a `Tool`, so they're indistinguishable from built-ins at the call site, and they're self-contained (no imports from elia's source) so they keep working across upgrades. `ELIA_SKILLS=off` disables loading entirely.

## How it works

- **`src/agentLoop.ts`** — the shared core loop: send messages to the active provider, stream text, execute tool calls (in parallel — 8 read-only, 4 if any mutate), feed results back, repeat. Runs read-only tools speculatively the moment their block finishes streaming, and folds a background compaction's summary in at a step boundary. Takes an optional provider (for tier routing), a step budget, a tool-event hook, and a speculative cache. Used by the top-level agent, sub-agents, the planner, and the evolution engine.
- **`src/agent.ts`** — the top-level agent: full tool set (including `task` and `preview`), live streaming, thinking animation, prefetch, and usage accounting.
- **`src/subagent.ts`** + **`src/autonomy/roles.ts`** + **`src/tools/task.ts`** — role-typed sub-agents. The role resolves to a model tier, a tool allowlist, a step budget, and a specialised prompt. Sub-agents can't spawn sub-agents (no role's allowlist contains `task`), which caps recursion at one level.
- **`src/autonomy/loop.ts`** — the orient → propose → execute → verify → reflect → learn cycle, with durable graph resumption across process boundaries.
- **`src/autonomy/goalGraph.ts`** — atomic goal-graph persistence, dependency-aware node states, stable action idempotency keys, failure classes, resumable approvals, and evidence-gated completion.
- **`src/autonomy/actionContract.ts`** — inferred action contracts with readiness preconditions, exit/artifact/UI postconditions, bounded retry dispositions, idempotency metadata, and takeover escalation.
- **`src/autonomy/scheduler.ts`** + **`src/autonomy/daemon.ts`** — atomic recurring-goal storage, reclaimable leases, single-flight background execution, pause/resume controls, and explicit local-daemon lifecycle.

- **`src/autonomy/proposal.ts`** — the `submit_proposal` tool, plan validation (unknown step ids, duplicate ids, dependency cycles, and missing verification are all rejected with a message the model can act on), and terminal rendering that shows the wave structure and warns about two steps in one wave claiming the same file.
- **`src/autonomy/artifacts.ts`** — secure Markdown plan persistence and bounded artifact lookup under `.elia`; arbitrary filesystem reads are rejected.
- **`src/autonomy/fleet.ts`** — dependency-wave planning and parallel dispatch. Reports `savedMs`: the workers' summed time minus the wall clock actually taken, which keeps the parallelism honest — a "parallel" run that saved nothing means the decomposition was wrong.
- **`src/autonomy/blackboard.ts`** + **`src/tools/blackboard.ts`** — the shared whiteboard. Sub-agents are normally hermetic, so two of them investigating the same repo rediscover the same facts twice; `board_post`/`board_read` turns a parallel fleet into one that cooperates.
- **`src/autonomy/context.ts`** — `AsyncLocalStorage` carrying the current worker's identity, so blackboard posts and action receipts are attributed without threading context through every tool signature.
- **`src/autonomy/governor.ts`** + **`src/autonomy/audit.ts`** — the deterministic per-tool action governor, serialized approval queue, redacted action ledger, and human-readable run receipt.
- **`src/autonomy/verify.ts`** — fail-fast verification runner and the critic's `submit_verdict` tool. The verdict is structured because it drives control flow; "did the model mean yes" is not something to infer from prose.
- **`src/autonomy/journal.ts`** + **`src/autonomy/rewind.ts`** — the append-only run log and phase checkpoints that make forking possible.
- **`src/autonomy/lessons.ts`** — durable, deduplicated, cross-run lessons in `.elia/lessons.md`.
- **`src/speculation/`** — predictive prefetch. `prefetch.ts` follows the edges agents actually read along (grep hits → open them; a module → open its imports) and `cache.ts` holds the results. On top of that, a read-only `tool_use` block is run the moment the model finishes *streaming* it (`streamTurn`'s `onToolBlock`, wired through both provider adapters) — so by the time the turn ends and the real dispatch runs, the disk round-trip is already done. Any mutating tool call invalidates the cache, and a batch mixing reads and writes bypasses it entirely, so the model can never be handed a pre-write snapshot; the worst case of a mid-stream guess is one wasted read. Speculative results show a `⚡` in the tool log.
- **`src/evolve/`** — `suite.ts` (the fitness function), `benchTask.ts` (one task, one child process, cwd already set), `fitness.ts` (scoring and the promotion rules), `sandbox.ts` (isolated copies, the immutable-file guard, transactional promote/rollback), `candidateTools.ts` (sandbox-confined mutation tools), `ledger.ts` (the generation record), `engine.ts` (the loop).
- **`src/bench/latency/`** — the model-free latency benchmark. `scriptedProvider.ts` (a deterministic provider with simulated pacing), `scenarios.ts` (the corpus + its structural invariants), `harness.ts` (runs each scenario through the real loop, medians the runs, measures cold start), `report.ts` (render + baseline comparison), `baseline.json` (committed numbers). `bun test` gates on the structural metrics; `elia bench-latency` is the local tool for wall-clock work.
- **`src/skills/`** — `detector.ts` (free repetition counting), `synthesize.ts` (write + gate a new tool), `loader.ts` (hot-load and quarantine).
- **`src/providers/`** — a small provider abstraction with two adapters: `anthropic.ts` (native Messages API; `buildAnthropicRequest` lays out the four cache breakpoints — stable system + tools on the 1-hour TTL, dynamic system suffix + history tail on the 5-minute default) and `openaiCompatible.ts` (Groq, OpenAI, OpenRouter, Google Gemini, NVIDIA NIM, Mercury, and anything else via `baseURL`). `registry.ts` resolves env vars into a concrete provider; `tryResolveProvider` returns an error instead of exiting so the optional fast tier can degrade silently. `prewarm.ts` opens a pooled connection to every configured model host (deep tier, a distinct fast tier, role overrides) at startup and after a `/model` or `/thinking` switch — one unauthenticated `HEAD`, result ignored, deduped per origin — so the first request on each skips DNS, the TLS handshake, and HTTP/2 setup on the path you're waiting on.
- **`src/tools/`** — `read_file`, `write_file`, `edit_file`, `list_files`, `grep`, `run_command`, `browser`, `board_post`, `board_read`, `task`, `preview`, plus any synthesized skills.
- **`src/shell.ts`** — one shell implementation shared by the `run_command` tool, verification, and the evolution gate, so all three behave identically.
- **`src/memory.ts`** — loads `ELIA.md` (project, in the cwd) and `~/.elia/ELIA.md` (user, global) into the system prompt at startup.
- **`src/session.ts`** — sessions auto-saved to `.elia/sessions/<id>.json` for `--continue`/`--resume`.
- **`src/ui/`** — `stream.ts` (unbuffered streaming and tool notices), `character.ts` + `animator.ts` (the ASCII character and in-place animator), `streamCursor.ts` (mid-stream blink), `fleetBoard.ts` (the live parallel-worker board), `report.ts` (phase headings and summaries).
- **`src/usage.ts`** — token/time/cost accounting and formatting.
- **`src/preview/`** — localhost-only static server over `workspace/` with WebSocket live-reload, and cross-platform Chrome launching.

Every animated or in-place UI element disables itself when stdout isn't a real terminal, so piped and scripted usage is never polluted with escape codes — the fleet board degrades to one plain line per state change.

## Testing

```bash
bun test
bun run typecheck
```

The suite covers the tools, session persistence, memory loading, usage accounting, wave planning, proposal validation, the speculative cache, path/import prediction, the promotion rules, habit detection, the blackboard, lessons, provider response parsing, action contracts, scheduler persistence/lease recovery, and environment readiness — all without an API key.

What can't be covered that way is the model loop itself. `elia bench` is the real test for that: it runs actual agent loops against checkable tasks, and it's also what `elia evolve` uses to decide whether a change to elia was an improvement.

## Status

In: parallel role-typed sub-agents, the autonomous work cycle with an approval gate, dependency-wave execution, verification-gated best-of-N execution in isolated worktrees, the shared blackboard, adversarial review, bounded self-repair, cross-run lessons, run forking, predictive prefetch, the two-tier model cascade, benchmark-gated self-evolution, skill synthesis, a central per-tool autonomy governor, a real MCP client, real-time LSP diagnostics on every edit, a full VS Code extension plus an HTTP/WebSocket transport for its bridge protocol, a real terminal UI, governed delegation to the real Codex CLI, delegated read-only browser observation, redacted action ledgers, run receipts, a durable goal graph, resumable approvals, stable action idempotency, failure classification, readiness tiers, action pre/postcondition contracts, recurring schedules, single-flight daemon execution, and evidence-gated completion.


Still on the roadmap: provenance-aware memory with expiry/conflict handling, user-defined evolution fitness profiles, event-triggered workflows, and provider-backed idempotency adapters for APIs that accept native idempotency keys. `elia evolve` does not commit to git — it copies files in and backs up what it replaced, leaving the commit to you.

### On speed

Roughly in order of impact:

1. **Prompt caching** (Anthropic): the system prompt, tool definitions, and the tail of history are cache breakpoints, so the unchanged prefix of a growing tool-calling loop is reused rather than reprocessed. Two refinements keep the cache actually holding: the stable prefix (system prompt + tools, fixed for the whole session) is pinned to the **1-hour** cache TTL so a slow `bun test` or a long pause between messages can't evict it, and the per-turn query-ranked project memory is sent as a **separate system block** so it never invalidates that stable prefix when it changes from one user message to the next. Run with `--profile-turns` (or `ELIA_PROFILE=1`) to print a per-call table of the cache-read/write split and time-to-first-token and see how well the cache is holding.
2. **Parallel sub-agents in dependency waves** — the widest safe wave at each point, rather than everything at once (which corrupts files two workers both edit) or everything in order (which wastes the fleet).
3. **The fast tier** — recon and summarising go to a cheap quick model; only decisions pay for the strong one.
4. **Parallel tool execution** — up to 8 read-only tool calls in flight per turn, 4 when any of them mutates.
5. **Predictive prefetch and mid-stream dispatch** — a read-only tool call is run *while the model is still generating*: predicted reads the moment a grep or import points at them, and any read-only `tool_use` block the instant it finishes streaming. The tool phase often costs ~0ms instead of a disk round-trip per file.
6. **Connection prewarm** — every configured model host gets a pooled connection opened at startup, so the first request skips DNS + TLS + HTTP/2 setup.
7. **Non-blocking startup and compaction** — MCP servers connect in the background instead of gating the prompt; a slow one (a cold `npx` server) is left connecting past a ~2.5s soft deadline (`ELIA_MCP_CONNECT_DEADLINE_MS`) rather than blocking a one-shot run for its full connect timeout; the history-shrinking archive (itself a model call) overlaps the turn that triggers it instead of stalling that turn's first token.
8. **Round-trip discipline** — `parallel_tool_calls` is requested explicitly, and the loop watches for a model reading files one per turn (or re-reading a file it already has) and injects one plain reminder to batch. Fewer model round-trips is the single biggest lever on wall-clock, especially with a fast-token / weaker-agent model.

`elia bench-latency` measures items 4–7 directly, with a scripted model so the numbers are all elia, and gates CI on the ones that are deterministic.

`max_tokens` for Anthropic is 32,000 (Sonnet 5 supports up to 128k). Billing is by tokens actually generated, not the ceiling, so this only removes the risk of truncated output on large refactors, with no cost downside.

## References

[gemini-spark]: https://gemini.google/overview/agent/spark/ "Gemini Spark overview"
[gemini-spark-support]: https://support.google.com/gemini/answer/17094507?hl=en&co=GENIE.Platform%3DAndroid "Gemini Spark availability and help"
[gemini-api]: https://ai.google.dev/gemini-api/docs "Gemini API documentation"
[gemini-interactions]: https://ai.google.dev/api/interactions-api "Gemini Interactions API reference"

The Gemini Spark discussion above is based on Google’s [Spark overview][gemini-spark], [support documentation][gemini-spark-support], [Gemini API documentation][gemini-api], and [Interactions API reference][gemini-interactions].
