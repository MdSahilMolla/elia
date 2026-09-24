/**
 * `elia --help`, and the per-topic help behind `--help <topic>`.
 *
 * Lifted out of index.ts whole: it is 200-odd lines of prose that changes
 * whenever a flag does, and it shares nothing with the dispatcher but the
 * argument vector. Keeping it here means a wording fix never touches the file
 * that decides what runs.
 */

export function printHelp(): void {
  console.log(`elia — a general-purpose autonomous agent for your terminal

Usage:
  elia                        Start an interactive session
  elia "<prompt>"             Run a single prompt and exit
  elia --continue, -c         Resume the most recent session in this directory
  elia --resume [id]          Reopen a past conversation — with no id, pick one from the list
  elia sessions [--all]       List the conversations saved here: id, when, and what each started with
  elia --no-escalate          Never auto-route a big "build me an X" request through the autonomous pipeline
  elia --self                 Started inside elia's own repository, change elia's source without asking
                              (by default elia asks first there, for anything outside workspace/ and .elia/)

Dev mode (default): elia is the general-purpose development mode for building,
debugging, testing, refactoring, and operating software. A request that reads as
a whole new project ("build an end-to-end X") is automatically planned and run
through the autonomous pipeline — plan, parallel workers, review, verify, repair
— instead of a single plain turn. Toggle with /auto on|off or --no-escalate.

Execution policy (manual by default): before running a command, elia checks whether it looks
risky (deletes, sends, spending, publishing, system changes, ...) — only
risky commands get an "About to: ... run it?" prompt, safe ones just run.
Once a command starts, safe and reversible work finishes end to end without
interruptions; irreversible tool actions are separately governed. Pass --yolo/-y
(or pick "Risk checks" in "/settings" during a session) to skip the pre-flight
risk prompt while keeping that action governor active.

Autonomous work:
  elia auto "<goal>"                Plan the work, show you the plan, then execute it with a
                                     fleet of sub-agents, verify it, repair what failed, and
                                     record what it learned
  elia auto "<goal>" --yolo         Same, without waiting for you to approve the plan
  elia auto "<goal>" --autonomous   Self-supervised alias for --yolo; executes, verifies, repairs, and polishes
  elia auto "<goal>" --unattended   Run safe, bounded work without routine prompts; critical actions still block
  elia auto "<goal>" --no-polish     Skip the bounded final quality pass
  elia auto "<goal>" --fast          Bounded fast path: no polish, one reviewer, one repair, no lesson pass
  elia auto "<goal>" --thorough      Extra bounded review and repair depth for high-risk changes
  elia auto "<goal>" --max-run-ms N  Abort the run after N milliseconds (also ELIA_MAX_RUN_MS)
  elia auto "<goal>" --max-actions N  Bound governed tool requests for this run
  elia auto "<goal>" --unattended --authorize <intent>[,<intent>...]
                                     Pre-authorize specific critical intents (e.g.
                                     deployment.production, github.pr_merge) for this run only, on
                                     this branch, for a few hours — the one way past the "browser/
                                     comms/deploy/PR-merge/codex_delegate always refuses unattended"
                                     wall, without weakening it for anything not named
  elia auto "<goal>" --variants N   Run N independent implementation attempts in parallel,
                                     each in its own isolated git worktree, and keep only
                                     the one that verification — not an LLM's opinion — likes
                                     best. Costs roughly Nx the execute phase; default is 1
                                     (today's single-attempt behavior, unchanged)

Multi-agent:
  elia agent "<request>"      Route the request to one or more specialist personas — Business,
                              Data, Research, Cybersecurity, Automation, Communications, AI/ML,
                              Sports, Fitness, Marketing, Finance, or Tech — and answer in their voice. Multi-domain
                              requests get labeled "## X take" sections plus a combined recommendation.
  elia agent "<request>" --dry-run  Show routing/persona plan without executing tools or side effects

Office workflows:
  Agent/autonomous requests can use spreadsheet to inspect, analyze, audit, or safely write
  Excel workbooks; presentation creates an editable management .pptx plus analysis sidecar.

Self-improvement:
  elia bench                  Score the current elia against its synthetic benchmark suite
  elia bench --history        Score it on tasks taken from this repository's own git history
  elia bench --all            Score it on both suites (results are kept as they land, and a task
                              whose code and model are unchanged since last week is reused, so an
                              interrupted run picks up where it stopped; --fresh re-runs them all)
  elia bench --harvest        Add newly proven git-history tasks to the tracked set (no model calls;
                              --replace rebuilds it from this scan alone)
  elia bench --split held-out Score only the half whose failures the evolution loop never
                              shows its proposer (--split shown for the other half)
  elia bench --canaries       Run the canaries, tasks only a faked result can pass, and report
                              how often the current elia cheated on them
  elia bench swe --file <tasks.json> [--sample N] [--out results.json]
                              Run a SWE-bench-Verified-shaped task file (see src/bench/swe/types.ts) —
                              real checkout, real agent run, real test execution, scored resolved/
                              unresolved. elia does not fetch or bundle the real dataset itself; point
                              --file at a real export. Each instance is a real, billed agent run, so
                              --sample (default 3) caps how many run, not the whole file.
  elia bench-latency          Measure elia's own loop/startup/speculation overhead (deterministic,
                              no API key); --update-baseline to record, --strict to fail on wall drift
  elia evolve                 Improve elia's own source: hypothesise one change, build it
                              in a sandbox, and promote it only if the benchmark agrees
  elia evolve -n 3            Run three generations, each building on the last
  elia evolve --dry-run       Evaluate candidates but never modify the live source
  elia evolve --builtin       Score only on the built-in suite (minutes, not hours; no full sweep needed)
                              ELIA_EVOLVE_PROVIDER / ELIA_EVOLVE_MODEL run the proposer and builder
                              on a stronger model; candidates are still measured on the configured one
  elia compounding            Where each stage of the self-improvement loop stands
  elia compounding frontier   The verification frontier, certified library, growth, isolation,
                              and the resource governor's plan
  elia compounding round [--spend]
                              Run the governor's top activity (no model calls without --spend)
  elia compounding simulate   Reproduce the paper's simulations (zero spend)
  elia compounding predict    The paper's falsifiable predictions P1–P8 and elia's evidence on each

Learned tools:
  elia skills                 List the tools elia has written for itself
  elia skills bundles         List declarative groups of loaded skills
  elia skills candidates      Show repeated work that could become a new tool
  elia skills synth           Write a tool for the strongest candidate
  elia skills trust           Trust this project's .elia/skills so they load on startup
  elia skills untrust         Revoke a prior trust decision for this project
  elia skills status          Show whether this project's local skills are trusted

Time travel:
  elia runs                   List autonomous runs
  elia runs <id>              Show one run's timeline and its forkable decision points
  elia fork <id> --at <n> --with "<change>"
                              Replay that run up to checkpoint <n> and re-plan from there
  elia resume <id>            Continue a durable goal from its persisted graph and approvals

Background autonomy:
  elia schedule add --every 1h [--mode battmann] [--max-actions N] "<goal>"  Persist a recurring goal for the local daemon
  elia schedule list                       Show scheduled goals and last outcomes
  elia schedule pause|resume|remove <id>  Control a scheduled goal
  elia schedule run <id>                   Run one scheduled goal immediately
  elia daemon --once                       Run due schedules once and exit
  elia daemon --poll-ms 30000             Keep checking due schedules in the foreground

Battmann intelligence (no model involved unless noted):
  elia battmann seed india-semiconductors  Subscribe real data feeds and open certified questions
  elia battmann brief india-semiconductors Seed if needed, then have the Battmann agent write the brief
  elia battmann pull <feed> <args…>        Fetch fx, worldbank, imf, comtrade or gdelt data by code
  elia battmann refresh                    Refresh feeds, resolve due questions, rebuild the dashboard
  elia battmann watch --every 6h           Repeat refresh while this process runs
  elia battmann record                     Certified track record: Battmann vs a statistical baseline
  elia doctor                              Check native-stack health: eliad daemon, C++ validator, Java bridge

Editor / external integration:
  elia bridge                              Start the local JSONL-over-stdio bridge (used by the Elia VS Code extension)
  elia bridge --http [--port 4319] [--host 127.0.0.1]  Same bridge protocol over WebSocket instead of stdio,
                                            for any external client — SDKs, other editors. Binds to
                                            localhost only unless --host is set explicitly.

  elia workspace serve                     Start the multi-user, multi-agent collaborative workspace server
  elia workspace init --name <name>        Bootstrap a workspace and print its owner token
  elia workspace status | feed [--follow]  Live counts, presence, and the shared activity stream
  elia workspace --help                    All workspace commands (members, agents, messages, decisions)

Provider setup:
  First interactive run                    Ask for provider, hidden API key, and model
                                           (a running Ollama is found and offered — no key needed)
  elia config                               Show provider readiness without printing keys
  elia config set --provider nvidia        Store a provider API key in ~/.elia/config.env
  elia config set --provider ollama --model <name>
                                           Run one of your local Ollama models (no key)
  elia config set --provider custom --base-url <url>
                                           Configure any OpenAI-compatible endpoint
  elia config remove --provider <name>     Remove that provider's saved API key
  elia codex-login                         Sign in to the installed Codex CLI with ChatGPT
  Use --api-key-env <NAME> or pipe a key with --api-key-stdin; never pass keys as arguments.
  In a session, /settings → Provider API keys adds, updates, selects, or removes profiles.

Supervisor controls:
  elia control status                       Show durable runs and pending operator controls
  elia control pause <run-id>               Request a safe pause of an active autonomous run
  elia control stop <run-id>                Request a safe stop of an active autonomous run
  elia resume <run-id>                      Resume only after reviewing the stopped run receipt
  --supervised                             Require an interactive approval boundary for auto work

Inside an interactive session:
  /                            Type "/" to see available commands — up/down to highlight,
                              tab to accept, enter to run, left/right to edit as usual
  rewind                      List rewind points for this session
  rewind <n>                  Restore conversation + files to just before turn <n>
  /capabilities               List specialist capabilities, risk classes, and output contracts
  /eliabook                   Open Save this session / Saved Elia Books
  /eliabook save [book-id]    Save the complete current session as a reusable Book
  /eliabook saved             Browse saved session playbooks
  /eliabook create <run-id>   Create a Book from a complete autonomous-run recording
  /eliabook run <book-id>     Run its active verified procedure in this session
  /eliabook improve <book-id> <run-id>  Promote a measurably better verified run
  /mode                       Pick a core mode with arrow keys: dev, cyber, battmann
  /mode <name>                Switch directly, e.g. /mode cyber, /mode dev ("tech" is an alias for dev)
  /betamode                   Pick an experimental mode or persona: sports, fitness, marketing,
                              finance, business, data, research, cybersecurity, automation,
                              communications, ai, production
  /betamode <name>            Switch directly, e.g. /betamode sports
  /settings                   Risk checks (auto/manual), model, reasoning effort, skills,
                              and compact / clear the conversation
  /compact [focus]            Summarise the conversation so far into one recallable episode and
                              continue from the summary; optional focus, e.g. /compact the auth bug
  /clear                      Start a fresh conversation; the previous one is saved and can be
                              reopened with elia --resume <id>
  /resume [id]                Switch to another conversation from this project without restarting;
                              the one you leave is saved first, so /resume <its id> goes back
  /sessions                   Every conversation here, live or saved — enter resumes the selected one
  /model                      Pick a provider/model or enable auto fallback
  /model auto                 Keep the selected model primary; fail over to another ready provider
  /model <provider>           Switch provider (e.g. /model groq), keeping its default model
  /model <model-id>           Switch just the model id, keeping the current provider
  /thinking                   Pick a reasoning effort with up/down or left/right, enter to switch
  /thinking off|on            Turn reasoning off, or back on at its last budget
  /thinking low|medium|high   Switch reasoning effort to a preset token budget
  /thinking <n>               Switch reasoning to an exact token budget (Anthropic only)
  /usage                      Live token consumption, context-window fill, and the limits in
                              effect (context, reasoning, autonomous-run, provider/plan)

  Other:
  elia --dev                  Start explicitly in dev mode (the default)
  elia --cyber                Start (or run a one-shot prompt) in cyber mode
  elia --battmann             Start (or run a one-shot prompt) in Battmann mode — strategic
                              intelligence across trade, geopolitics, financial markets,
                              supply chain, policy, and commodities
  elia --beta <mode>          Start in an experimental mode: sports, fitness
                              (the old --sports / --fitness flags still work, deprecated)
  elia --json                 Emit stable JSONL lifecycle events for automation
  elia --plain                Disable color, animation, and in-place terminal redraws
  elia --quiet                Print the final answer and essential failures only; keep TTY editing
  elia --verbose              Include detailed progress output
  ELIA_MAX_RUN_MS             Default wall-clock budget for autonomous runs; --max-run-ms overrides it
  --max-actions <n>            Bound governed tool requests for one autonomous run
  ELIA_TOOL_CONCURRENCY       Read-only tool batches can use up to 8; mutating batches stay capped at 4
  ELIA_OTEL_ENDPOINT           OTLP/HTTP+JSON collector base URL — mirrors autonomous-run journal events
                              to it as OTel logs (POST <endpoint>/v1/logs), purely additive; unset (the
                              default) sends nothing
  elia --help                 Show this help
  elia --version              Print the version

  UI output: --json/--jsonl emits machine-readable JSONL events; --plain disables color and redraws;
  --quiet minimizes progress; --verbose includes additional progress detail. Errors go to stderr
  in human modes. Sessions auto-save to .elia/sessions/. Configure a provider with elia config set
  or via .env — see .env.example.

  Diagnostics: --profile-turns (or ELIA_PROFILE=1) records every model call's
  cache-read/write split and time-to-first-token and prints a table at the end —
  use it to see how well the prompt cache is holding across a session.

Set ELIA_FAST_PROVIDER/ELIA_FAST_MODEL to give elia a cheap fast tier for recon work; it
routes investigation there and keeps the strong model for planning, building, and review.`)
}
