# elia

A fast, general-purpose autonomous agent for the terminal, built on Bun. It streams model output live, calls tools (file read/write/edit, glob, grep, shell, browser) automatically in a loop, and works with multiple LLM providers. Every meaningful tool call passes through a deterministic autonomy governor, and autonomous runs produce a redacted action ledger plus a human-readable receipt.

Beyond the usual loop, elia does three things most terminal agents don't:

- **It works a task the way a person does** — orients, tells you what it intends to do, executes it with a fleet of specialised sub-agents running in parallel, checks its own work, repairs what broke, and writes down what it learned for next time.
- **It improves itself, measurably.** `elia evolve` has elia read its own source, form one hypothesis about its weakest link, implement it in a sandboxed copy, and benchmark that copy *using the copy's own code*. It only replaces itself if the score actually goes up.
- **It writes its own tools.** Elia counts what it keeps doing by hand and can turn a repeated routine into a real, tested tool that loads on every future run.

## Requirements

- [Bun](https://bun.sh) >= 1.3

### Dev mode

Elia’s default general-purpose coding mode is called **dev mode**. It covers building, debugging, refactoring, testing, software operations, browser work, and task delegation. Start it explicitly with `elia --dev`, or switch back to it interactively with `/dev`. The old `/normal` command remains accepted as a compatibility alias but is not shown in command completion.

Dev mode is separate from execution policy: manual policy asks before risky actions, while auto policy skips preliminary risk checks but keeps governed irreversible actions behind explicit approval unless unattended execution has been explicitly requested.

## Setup

```bash
bun install
cp .env.example .env
```

Edit `.env` to pick a provider and set its key. `ELIA_PROVIDER` defaults to `anthropic`.

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

Any provider's model can be overridden with `ELIA_MODEL`. `openrouter` uses OpenRouter's OpenAI-compatible endpoint and its `openrouter/auto` router by default; set `ELIA_MODEL` to pin a specific OpenRouter model. `mistral` uses Mistral's OpenAI-compatible endpoint and `mistral-large-latest` by default; set `ELIA_MODEL` to choose another Mistral model. `google` uses Google's OpenAI-compatible Gemini endpoint and `gemini-3.7-flash` by default; set `ELIA_MODEL` to choose another compatible Gemini model. `nvidia` uses NVIDIA's hosted NIM OpenAI-compatible endpoint and `nvidia/llama-3.3-nemotron-super-49b-v1.5` by default; set `ELIA_MODEL` to choose another available NIM model. `custom` (and any provider, if you need to point at a proxy or self-hosted gateway) also honors `ELIA_BASE_URL`.

### Automatic provider fallback

The selected provider and model remain primary. Use `/model auto` or set `ELIA_ROUTING_MODE=auto` to try another configured provider when the selected route fails before output because of a missing model, outage, network error, rate limit, or retryable server response. Fallback is immediate when another ready provider exists and never retries after partial output.

### Specialist modes and capability contracts

Elia routes requests across explicit specialist modes: **Marketing**, **Finance**, **Business Analyst**, **Data Analyst**, **Research**, **Cybersecurity**, **Automation**, **Communications**, **AI/ML**, **Production Engineering**, and **Tech**. Automatic routing is available through `elia agent "<request>"`; interactive sessions can pin a mode with `/marketing`, `/finance`, `/business`, `/data`, `/research`, `/cybersecurity`, `/automation`, `/communications`, `/ai`, `/production`, or `/tech`. Use `/capabilities` to inspect each mode’s risk class, preferred tools, and required output contract.

Each specialist must separate facts, assumptions, recommendations, and unknowns. Finance and cybersecurity work require explicit assumptions or authorized scope; data work requires quality checks and reproducibility; research requires sources and citations; communications and automation require exact approval immediately before consequential external actions.

The capability inventory, architecture boundaries, and current limitations are documented in [`docs/agent-capability-audit.md`](docs/agent-capability-audit.md). The repeatable evaluation matrix and quality thresholds are in [`docs/general-agent-evaluation.md`](docs/general-agent-evaluation.md). Use `/capabilities` inside a session to inspect the live registry of specialist domains, risk classes, preferred tools, and output contracts.

### Coding language and framework support

Elia’s Tech specialist is compatible with projects built in **Python**, **TypeScript/JavaScript**, **Bun**, and **React/TSX**, including common adjacent tooling such as Vite, Next.js, pytest, npm, pnpm, and project-specific scripts. Compatibility means Elia can inspect the project, edit source and configuration, run the declared commands, debug failures, and verify the result; it does not require the target project to use Elia’s own Bun stack.

| Stack | Project signals Elia detects | Typical verification |
|---|---|---|
| Python | `pyproject.toml`, `requirements.txt`, `setup.cfg`, virtual-environment metadata, `.py` files | pytest, project scripts, type/lint tools such as mypy or ruff when declared |
| TypeScript/JavaScript | `package.json`, `tsconfig.json`, `.ts`/`.tsx`/`.js` files | package-manager test, typecheck, lint, and build scripts |
| Bun | `bunfig.toml`, Bun lockfiles, Bun package scripts, `bun test`/`bun run` commands | Bun tests, scripts, typecheck, and build commands |
| React/TSX | React dependencies, `.jsx`/`.tsx`, Vite/Next configuration, component and route structure | project test, typecheck, lint, and production build scripts |

Elia uses the target project’s existing package manager and conventions rather than assuming one toolchain. Before coding in an unfamiliar repository, the Tech agent can use the deterministic `project_profile` tool to report detected stacks, package manager, manifest signals, and declared verification commands. It can work across these stacks in one delegated task, for example updating a Python API, a TypeScript service, and a React client in separate dependency-aware steps, then running the relevant verification for each.

### Skills: create, install, and select

Elia can synthesize a repeated routine into a tested skill with `elia skills candidates` followed by `elia skills synth`. Users can also create or add a skill manually by placing a self-contained `*.skill.ts` module in the project’s `.elia/skills/` directory or the user-wide `~/.elia/skills/` directory. Use `elia skills path` to print the exact folders and contract. Invalid skills are quarantined instead of crashing startup.

Inside an interactive session, type **`@skills`** and press Enter to browse loaded skills. The picker lets the user make all loaded skills available or select one synthesized skill for subsequent turns. Selection changes the tool set only; it does not rewrite the user’s text, alter the system prompt, or add hidden instructions to the model. `ELIA_SKILLS=off` disables skill loading.

### Self-supervised execution and polish

For a fully autonomous run, use `--autonomous` (an alias for `--yolo`):

```bash
bun run dev auto "improve the authentication flow and make the tests pass" --autonomous
```

Elia will orient itself, propose a plan internally, delegate independent work, execute the plan, run verification commands, repair failures, and perform a bounded final quality pass before reporting completion. The polish pass is conservative: it can improve concrete rough edges, tests, documentation, and error handling, but it may leave the tree unchanged when no safe improvement is justified. Use `--no-polish` only when a task explicitly requires the older execution path. External side effects such as purchases, publishing, deletion, sending messages, or subscription changes still require explicit confirmation.

### Production hardening and supervised operation

Autonomous runs are durable rather than process-local. Elia persists a versioned goal graph, append-only journal, action ledger, checkpoints, proposal contracts, verification evidence, and a redacted receipt under `.elia/runs/<run-id>/`. Node and action execution uses expiring leases with heartbeat renewal; when a process is interrupted, opening the run reconciles stale leases into retryable or human-review states instead of silently duplicating work. `elia resume <run-id>` reports any recovered stale nodes or actions before continuing.

Tool execution is bounded and cancellable end to end. Shell commands run in process groups, terminate descendants on timeout or operator cancellation, and cap captured output. Browser bridge, CDP, and provider requests have deadlines; provider retries are disabled at the transport boundary so the agent-level fallback policy remains visible and bounded. Set a default wall-clock budget with `ELIA_MAX_RUN_MS`, or override it per invocation with `elia auto "<goal>" --max-run-ms 900000`. Budget use, token usage, recovery counts, verification results, and action failure classes are included in the run receipt.

Every delegated plan and proposal may declare `acceptanceCriteria`, `verificationCommands`, `sideEffects`, and `recovery`. These fields are persisted and shown for approval. Verification commands are checked by the same autonomy governor as ordinary shell actions; credential reads and outbound data writes are critical and fail closed when unattended. Structured JSONL events, `--plain`, `--quiet`, `--verbose`, and `--json` modes make long-running and CI execution observable without changing the underlying model prompt or its raw generation behavior.

For specialist work, `elia agent "<request>" --dry-run` performs routing only and prints the selected persona chain and rationale without running specialist tools or side effects. Use this to inspect an execution plan before allowing a full specialist turn.

### Production SaaS delivery

The Production Engineering specialist is routed for release, deployment, migration, rollback, observability, SLO, incident, backup, and CI/CD requests. Its read-only `production_readiness` tool scans the actual repository for CI configuration, deployment manifests, verification scripts, environment/secret hygiene, database and migration evidence, observability, health checks, rollback, incident, and backup artifacts. It returns a scored evidence checklist and recommendations; a detected file is never treated as proof that a production system is safe or deployed.

Production work remains bounded and auditable. Elia can inspect a repository, prepare changes, run dry-run or staging checks, write release and incident plans, and verify observable postconditions. Deployment, production data mutation, destructive migrations, secret rotation, and irreversible infrastructure actions require explicit approval and project-specific credentials. No local repository audit can prove that an external environment is healthy.

### Data science and finance workflows

The `data_science` tool provides deterministic, reproducible workflows for CSV, TSV, JSON, and JSONL files: schema and type profiling, missingness and duplicate detection, explicit data-quality validation, grouped summaries, Pearson correlation, and bounded ordinary-least-squares linear regression. It reports bounded input size, excludes invalid values from aggregates rather than silently repairing them, and clearly states that association is not causation. Advanced statistical inference, causal analysis, experiment design, visualization, and domain-specific leakage review still require project-specific code and acceptance criteria.

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
ELIA_BROWSER_MCP_SERVER="My Browser" bun run dev "open the dashboard and summarize its current status"
# or
ELIA_BROWSER_BRIDGE_COMMAND="/path/to/your/browser-bridge" bun run dev "open the dashboard and summarize its current status"
# or
ELIA_BROWSER_CDP_URL=http://127.0.0.1:9222 bun run dev "inspect the active page"
```

If a connector uses different tool names, override them with variables such as `ELIA_BROWSER_NAVIGATE_TOOL` and `ELIA_BROWSER_SNAPSHOT_TOOL`.

A bridge receives one JSON request on stdin and should return one JSON or text response. Keep login credentials in the bridge or browser session, never in Elia prompts, source files, or command-line arguments. Elia must not bypass login challenges, CAPTCHAs, paywalls, or site safety controls. Actions that may send, buy, publish, delete, or change subscriptions pause and return an exact five-minute `confirmationToken`. The user must approve that exact action before the token is supplied; tokens are bound to the action details and cannot be reused for a changed target or message. `wait_for`, `expectText`, and `expectUrl` are intended for stateful sites where navigation or clicks complete asynchronously; they time out rather than claiming success.

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
bun run dev runs                         # list past autonomous runs
bun run dev runs <id>                    # show one run's timeline, graph state, and forkable points
bun run dev fork <id> --at <n> --with "<change>"   # re-plan an earlier run from a checkpoint
bun run dev resume <id>                    # continue a durable goal and reconcile pending approvals and stale leases
bun run dev agent "<request>" --dry-run       # show specialist routing without executing tools

elia --dev                    # explicit dev mode (the default)
elia --help
elia --version

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

## Learned tools: `elia skills`

```bash
elia skills               # list the tools elia has written for itself
elia skills candidates    # show repeated work that could become a tool
elia skills synth         # write a tool for the strongest candidate
```

Elia counts two kinds of repetition as it works, for free, with no model involved: shell-command *shapes* (`git diff --stat HEAD~1` and `git diff --cached` are the same habit) and sliding trigrams of tool names (a `grep → read_file → edit_file` routine that costs three round-trips every time). Once a habit crosses a threshold, `elia skills synth` has a builder write a real tool for it — plus a test — into `~/.elia/skills/`.

A synthesized skill is only kept if it survives the same gate a human contribution would: it has to import cleanly, expose a valid tool schema, and pass a test that actually ran. Anything else is quarantined rather than loaded. Skills are ordinary modules exporting a `Tool`, so they're indistinguishable from built-ins at the call site, and they're self-contained (no imports from elia's source) so they keep working across upgrades. `ELIA_SKILLS=off` disables loading entirely.

## How it works

- **`src/agentLoop.ts`** — the shared core loop: send messages to the active provider, stream text, execute tool calls (in parallel, up to 4 at a time), feed results back, repeat. Takes an optional provider (for tier routing), a step budget, a tool-event hook, and a speculative cache. Used by the top-level agent, sub-agents, the planner, and the evolution engine.
- **`src/agent.ts`** — the top-level agent: full tool set (including `task` and `preview`), live streaming, thinking animation, prefetch, and usage accounting.
- **`src/subagent.ts`** + **`src/autonomy/roles.ts`** + **`src/tools/task.ts`** — role-typed sub-agents. The role resolves to a model tier, a tool allowlist, a step budget, and a specialised prompt. Sub-agents can't spawn sub-agents (no role's allowlist contains `task`), which caps recursion at one level.
- **`src/autonomy/loop.ts`** — the orient → propose → execute → verify → reflect → learn cycle, with durable graph resumption across process boundaries.
- **`src/autonomy/goalGraph.ts`** — atomic goal-graph persistence, dependency-aware node states, stable action idempotency keys, failure classes, resumable approvals, and evidence-gated completion.
- **`src/autonomy/proposal.ts`** — the `submit_proposal` tool, plan validation (unknown step ids, duplicate ids, dependency cycles, and missing verification are all rejected with a message the model can act on), and terminal rendering that shows the wave structure and warns about two steps in one wave claiming the same file.
- **`src/autonomy/fleet.ts`** — dependency-wave planning and parallel dispatch. Reports `savedMs`: the workers' summed time minus the wall clock actually taken, which keeps the parallelism honest — a "parallel" run that saved nothing means the decomposition was wrong.
- **`src/autonomy/blackboard.ts`** + **`src/tools/blackboard.ts`** — the shared whiteboard. Sub-agents are normally hermetic, so two of them investigating the same repo rediscover the same facts twice; `board_post`/`board_read` turns a parallel fleet into one that cooperates.
- **`src/autonomy/context.ts`** — `AsyncLocalStorage` carrying the current worker's identity, so blackboard posts and action receipts are attributed without threading context through every tool signature.
- **`src/autonomy/governor.ts`** + **`src/autonomy/audit.ts`** — the deterministic per-tool action governor, serialized approval queue, redacted action ledger, and human-readable run receipt.
- **`src/autonomy/verify.ts`** — fail-fast verification runner and the critic's `submit_verdict` tool. The verdict is structured because it drives control flow; "did the model mean yes" is not something to infer from prose.
- **`src/autonomy/journal.ts`** + **`src/autonomy/rewind.ts`** — the append-only run log and phase checkpoints that make forking possible.
- **`src/autonomy/lessons.ts`** — durable, deduplicated, cross-run lessons in `.elia/lessons.md`.
- **`src/speculation/`** — predictive prefetch. `prefetch.ts` follows the edges agents actually read along (grep hits → open them; a module → open its imports) and `cache.ts` holds the results. Any mutating tool call invalidates the cache, and a batch mixing reads and writes bypasses it entirely, so the model can never be handed a pre-write snapshot. Prefetched results show a `⚡` in the tool log.
- **`src/evolve/`** — `suite.ts` (the fitness function), `benchTask.ts` (one task, one child process, cwd already set), `fitness.ts` (scoring and the promotion rules), `sandbox.ts` (isolated copies, the immutable-file guard, transactional promote/rollback), `candidateTools.ts` (sandbox-confined mutation tools), `ledger.ts` (the generation record), `engine.ts` (the loop).
- **`src/skills/`** — `detector.ts` (free repetition counting), `synthesize.ts` (write + gate a new tool), `loader.ts` (hot-load and quarantine).
- **`src/providers/`** — a small provider abstraction with two adapters: `anthropic.ts` (native Messages API with prompt-caching breakpoints on the system prompt, tools, and tail of history) and `openaiCompatible.ts` (Groq, OpenAI, OpenRouter, Google Gemini, NVIDIA NIM, Mercury, and anything else via `baseURL`). `registry.ts` resolves env vars into a concrete provider; `tryResolveProvider` returns an error instead of exiting so the optional fast tier can degrade silently.
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

The suite covers the tools, session persistence, memory loading, usage accounting, wave planning, proposal validation, the speculative cache, path/import prediction, the promotion rules, habit detection, the blackboard, lessons, and provider response parsing — all without an API key.

What can't be covered that way is the model loop itself. `elia bench` is the real test for that: it runs actual agent loops against checkable tasks, and it's also what `elia evolve` uses to decide whether a change to elia was an improvement.

## Status

In: parallel role-typed sub-agents, the autonomous work cycle with an approval gate, dependency-wave execution, verification-gated best-of-N execution in isolated worktrees, the shared blackboard, adversarial review, bounded self-repair, cross-run lessons, run forking, predictive prefetch, the two-tier model cascade, benchmark-gated self-evolution, skill synthesis, a central per-tool autonomy governor, delegated read-only browser observation, redacted action ledgers, run receipts, a durable goal graph, resumable approvals, stable action idempotency, failure classification, and evidence-gated completion.

Still on the roadmap: provenance-aware memory with expiry/conflict handling, a governed MCP connector registry, user-defined evolution fitness profiles, event-triggered workflows, and provider-backed idempotency adapters for APIs that accept native idempotency keys. `elia evolve` does not commit to git — it copies files in and backs up what it replaced, leaving the commit to you.

### On speed

Five things, roughly in order of impact:

1. **Prompt caching** (Anthropic): system prompt, tool definitions, and the tail of history are cache breakpoints, so the unchanged prefix of a growing tool-calling loop is reused rather than reprocessed.
2. **Parallel sub-agents in dependency waves** — the widest safe wave at each point, rather than everything at once (which corrupts files two workers both edit) or everything in order (which wastes the fleet).
3. **The fast tier** — recon and summarising go to a cheap quick model; only decisions pay for the strong one.
4. **Parallel tool execution** — up to 4 tool calls in flight per turn.
5. **Predictive prefetch** — the reads the model is about to make happen *while it's still generating*, so the tool phase often costs ~0ms instead of a disk round-trip per file.

`max_tokens` for Anthropic is 32,000 (Sonnet 5 supports up to 128k). Billing is by tokens actually generated, not the ceiling, so this only removes the risk of truncated output on large refactors, with no cost downside.
