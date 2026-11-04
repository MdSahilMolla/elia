/**
 * `elia --help`, and the per-command help behind `elia <command> --help`.
 *
 * Lifted out of index.ts whole: it is 200-odd lines of prose that changes
 * whenever a flag does, and it shares nothing with the dispatcher but the
 * argument vector. Keeping it here means a wording fix never touches the file
 * that decides what runs.
 */

/** `elia --help`, or just the lines about one command for `elia <command> --help`. */
export function printHelp(topic?: string): void {
  const section = topic ? helpFor(topic) : undefined
  console.log(section ?? HELP)
}

/**
 * The usage lines for one command, cut from the full help so the two can never
 * disagree: every `elia <command> …` line and the description lines under it.
 * `elia workspace --help`, `elia auto --help` and the rest used to print the
 * whole 200-line help, because `--help` was answered before the command was
 * even looked at.
 */
export function helpFor(topic: string): string | undefined {
  const lines = HELP.split('\n')
  const kept: string[] = []
  const command = new RegExp(`^(\\s*)elia ${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
  for (let i = 0; i < lines.length; i += 1) {
    const match = command.exec(lines[i]!)
    if (!match) continue
    const indent = match[1]!.length
    kept.push(lines[i]!)
    // The description wraps onto deeper-indented lines that are not commands.
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && /^\s*/.exec(lines[i + 1]!)![0].length > indent + 4 && !/^\s*elia\s/.test(lines[i + 1]!)) {
      kept.push(lines[i + 1]!)
      i += 1
    }
  }
  if (kept.length === 0) return undefined
  const margin = Math.min(...kept.map((line) => /^\s*/.exec(line)![0].length))
  return [`Usage: elia ${topic}`, '', ...kept.map((line) => `  ${line.slice(margin)}`), '', 'Everything elia can do: elia --help'].join('\n')
}

const HELP = `elia — a general-purpose autonomous agent for your terminal

Usage:
  elia                        Start a session. In a clean git repository elia starts working on its
                              own (the autopilot) — talk to it while it works, Esc stops it. It waits
                              for you instead outside a repo, with uncommitted changes, or with --chat
  elia --chat                 Open a session that waits for you (also ELIA_AUTOPILOT=off)
  elia "<task>"               Do one task and exit (a big build runs the full pipeline by itself)
  elia --continue, -c         Resume the most recent session in this directory
  elia --resume [id]          Reopen a past conversation — with no id, pick one from the list
  elia --no-record            Do not record this session (also ELIA_RECORD=off). By default every session is
                              recorded to .elia/recordings/ as it happens, redacted, and added to an Elia Book
  elia sessions [--all]       List the conversations saved here: id, when, and what each started with
  elia --self                 Started inside elia's own repository, change elia's source without asking
                              (by default elia asks first there, for anything outside workspace/ and .elia/)

elia is autonomous — there is no mode to pick. It reads, edits, runs the
project's checks, commits on the working branch and sets up the environment
without asking; a request that reads as a whole new project ("build an
end-to-end X") runs through the full pipeline by itself: plan, parallel
workers, review, verify, repair. The one gate, enforced in code, is for actions
that cannot be undone or that reach outside this machine — pushing, deploying,
sending messages, spending money, deleting data, a remote or production
database. In a session elia asks once (and you can answer "always"); an
unattended run never waits — it skips the action and lists it for you.

Dev mode (default) covers building, debugging, testing, refactoring and
operating software; /mode switches to a specialist mode.

Autonomous runs from the command line — autopilot picks the goals, auto takes yours:
  elia autopilot                     Survey the repo, run its own checks, work out what it is for,
                                     where it stands and where it is heading, then plan and do the
                                     next most valuable goals unattended — on a branch of its own.
                                     A goal that turns any passing check red is rolled back (and
                                     kept as a git ref). Nothing is pushed, deployed or sent.
  elia autopilot --plan-only         Survey, measure, understand and plan; change nothing
  elia autopilot --max-goals N       Goals to run this session (default 5); also --goal-minutes M,
                                     --hours H, --profile fast|balanced|thorough
  elia autopilot --resume            Continue the last pilot in this repository
  elia autopilot status | report     Where the last pilot stands / its full report
                                     (.elia/autopilot/REPORT.md). Inside a session: /autopilot
  elia autopilot watch add "github ci"  React to events too: github ci|issues|prs, file <path>, url <https>, every 6h
  elia autopilot --watch             Keep going: every event becomes a goal; waits when there is nothing to do
  elia autopilot --scopes a,b        Limit what its goal runs may do (e.g. workspace-read,workspace-write,process)
  elia autopilot install [--env-file F]  Run --watch in the background from log-in on (uninstall | service for status);
                                     a watching pilot spends at most ELIA_AUTOPILOT_DAILY_USD a day (default $2)

  elia auto "<goal>"                 Your goal, through the full pipeline: plan it, execute it with a
                                     fleet of sub-agents, verify, repair, and record what it learned
  elia auto "<goal>" --no-polish     Skip the bounded final quality pass
  elia auto "<goal>" --fast          Bounded fast path: no polish, one reviewer, one repair, no lesson pass
  elia auto "<goal>" --thorough      Extra bounded review and repair depth for high-risk changes
  elia auto "<goal>" --max-run-ms N  Abort the run after N milliseconds (also ELIA_MAX_RUN_MS)
  elia auto "<goal>" --max-actions N Bound governed tool requests for this run
  elia auto "<goal>" --authorize <intent>[,<intent>...]
                                     Pre-authorize specific critical intents (e.g.
                                     deployment.production, github.pr_merge) for this run only, on
                                     this branch, for a few hours — the one way past the "browser/
                                     comms/deploy/PR-merge/codex_delegate always refuses unattended"
                                     wall, without weakening it for anything not named
  elia auto "<goal>" --variants N    Run N independent implementation attempts in parallel,
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
  elia bench --lift           Also score the same tasks on the same model with no harness (a shell
                              and a file writer), and report whether elia beats it — with the evidence
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
  elia bench --answers        Score question answering, with the independent answer check on and off
  elia bench --lessons        Give every task this project's lessons, as a real turn would — compare
                              against a run without it to learn whether the lesson store helps
  elia bench-latency          Measure elia's own loop/startup/speculation overhead (deterministic,
                              no API key); --update-baseline to record, --strict to fail on wall drift,
                              --realistic for realistic turn shapes
  elia evolve                 Improve elia's own source: hypothesise one change, build it
                              in a sandbox, and promote it only if the benchmark agrees
  elia evolve -n 3            Run three generations, each building on the last
  elia evolve --dry-run       Evaluate candidates but never modify the live source
  elia evolve --branch        Commit a proven change to its own evolve/gen-N branch, not the working tree
  elia evolve --builtin       Score only on the built-in suite (minutes, not hours; no full sweep needed)
                              ELIA_EVOLVE_PROVIDER / ELIA_EVOLVE_MODEL run the proposer and builder
                              on a stronger model; candidates are still measured on the configured one
  elia evolve --explain       Show the field evidence the proposer is given (no model call, writes nothing)
  elia evolve --auto          One governed practice run, the same one elia starts when it is idle
  elia gap [history] [--check] Score the verification ladder on planted defects (free, no model);
                              --check fails when the gap regressed against the last recorded score
  elia values [show|probe]    Show the Value Core and the first principles, or probe that the role prompts honour the core
  elia distill [run|traces|export]
                              Turn verified runs into prompt fragments (dry run; --promote keeps the
                              ones that pass every gate); traces lists what qualifies
  elia world [predict|simulate] What elia has learned about how this project behaves and how well it
                                predicts; 'predict' prices your uncommitted edits without a model,
                                'simulate' checks the reasoning planner against the library it replaces
  elia jev [status|ping|bench]  How Jev, the optional independent judge, scores against elia's own
                              decisions (needs ELIA_JEV_API_KEY)
  elia compounding            Where each stage of the self-improvement loop stands
  elia compounding frontier   The verification frontier, certified library, growth, isolation,
                              and the resource governor's plan
  elia compounding round [--spend]
                              Run the governor's top activity (no model calls without --spend)
  elia compounding simulate   Reproduce the paper's simulations (zero spend)
  elia compounding predict    The paper's falsifiable predictions P1–P8 and elia's evidence on each

Project trust:
  elia trust                  Trust this project's own skills, MCP servers, standing approvals and schedules
  elia trust status           Show which of them are trusted right now
  elia trust revoke           Revoke that trust

Learned tools:
  elia skills                 List the tools elia has written for itself
  elia skills bundles         List declarative groups of loaded skills
  elia skills candidates      Show repeated work that could become a new tool
  elia skills synth           Write a tool for the strongest candidate
  elia skills trust           Trust this project's .elia/skills so they load on startup (hash-bound, kept in your user config)
  elia skills untrust         Revoke a prior trust decision for this project
  elia skills status          Show whether this project's local skills are trusted
  elia skills instructions    List SKILL.md instruction skills elia wrote for itself
  elia skills instructions history <slug>    Why each version of a self-authored skill happened
  elia skills instructions rollback <slug> <v>  Restore an archived version

Time travel:
  elia runs                   List autonomous runs
  elia runs <id>              Show one run's timeline and its forkable decision points
  elia fork <id> --at <n> --with "<change>"
                              Replay that run up to checkpoint <n> and re-plan from there
  elia resume <id>            Continue a durable goal from its persisted graph and approvals

Parallel sessions (a session belongs to the elia process that started it — inside a session,
/sessions new and ctrl+n keep one on the session bar):
  elia sessions new --name <name>   Create a session worktree (.elia/session-worktrees/<name>) to work in
  elia sessions list | status       Live bus sessions: name, id, status, last task, active agents
  elia sessions attach <id|name>    Make that session this terminal's active one (--session <name> also picks)
  elia sessions kill <id|name>      Kill a live session and remove its worktree (best-effort)
  elia sessions prune [--yes]       Remove session worktrees nothing uses — only clean ones, and a branch
                                    only when it is merged
  elia sessions sync <a> <b>        Diff two sessions' memory slices: a-only / b-only / conflicts
  elia sessions drop <name> [--payload <path>] [--from <session>]    Publish a context drop
  elia sessions subscribe <name> --from <session>                    Inject a session's drops as context

Background autonomy:
  elia schedule add --every 1h [--mode battmann|datascience|sysintel] [--max-actions N] "<goal>"  Persist a recurring goal for the local daemon
  elia schedule list                       Show scheduled goals and last outcomes
  elia schedule pause|resume|remove <id>  Control a scheduled goal
  elia schedule run <id>                   Run one scheduled goal immediately
  elia daemon --once                       Run due schedules once and exit
  elia daemon --poll-ms 30000             Keep checking due schedules in the foreground

Delayed outcome closure:
  elia outcomes add --after 5m --file path [--contains "text"]  Check a postcondition after the run settles
  elia outcomes list                                             Show pending and resolved outcome contracts
  elia outcomes show <id>                                        Show evidence and failure details
  elia outcomes check                                            Resolve due local deterministic checks

Data Science workspace (no model involved):
  elia ds capabilities                     Every ds_* action and how it touches the world
  elia ds datasets | runs | record <id>    Datasets, execution records, and one record in full
  elia ds verify                           Recheck recorded artifacts against their hashes
  elia ds python                           The Python interpreter and packages the engine can use
  elia datascience <command>               The same commands under their long name

System Intelligence record (no model involved):
  elia si [board]                          Every initiative, its lifecycle stage, owner hat, and open gates
  elia si show <SI-n>                      One initiative in full, its gates evaluated now
  elia si report priorities|week|quarter|flywheel|dependencies|risks|knowledge|digest
                                           The organization's rhythms, computed from the record
  elia si signoff <SI-n> <gate>            Sign off direction, release, production, or accept-risk yourself
  elia si review <SI-n> <kind> <verdict> --note ".."   Record your own review
  elia si journal | verify | org | structure | lifecycles | template <kind> | cadence
  elia sysintel <command>                  The same commands under their long name
  elia trials [analyze]                    What happened to each commit after it landed: is that signal usable, and how big a trial it needs
  elia trials basket                       The outcome basket and its digest (the outcomes, fixed before any analysis)

CyberBrain (read-only retrieval corpus):
  elia cyberbrain install <dir|zip|url>    Install the scraped CTF/VAPT corpus into ~/.elia/cyberbrain
                                           (a directory, a .zip, or an https URL to a zip)
  elia cyberbrain verify                   Re-run every validation gate and print the receipt
  elia cyberbrain status                   Whether a corpus is installed, where, its counts, and generated_at

Battmann intelligence (no model involved unless noted):
  elia battmann seed india-semiconductors  Subscribe real data feeds and open certified questions
  elia battmann brief india-semiconductors Seed if needed, then have the Battmann agent write the brief
  elia battmann pull <feed> <args…>        Fetch fx, worldbank, imf, comtrade or gdelt data by code
  elia battmann refresh                    Refresh feeds, resolve due questions, rebuild the dashboard
  elia battmann cycle <playbook>           Refresh, then re-run the brief when its forecasts have gone stale
  elia battmann autorun install <playbook> Run cycle daily (launchd on macOS, crontab on Linux, Task Scheduler
                                           on Windows); status and uninstall too
  elia battmann watch --every 6h           Repeat refresh while this process runs
  elia battmann record                     Certified track record: Battmann vs a statistical baseline
  elia battmann feeds | dashboard | void   Feed status, write the dashboard, void a question (a person only)
  elia battmann --help                     Every battmann command and feed

MCP server:
  elia --mcp [--transport stdio|http] [--port N] [--host H]
                              Start the Elia MCP server without opening an interactive session
  elia mcp                   Same, using the subcommand form
  elia-mcp                   Start the stdio MCP server directly

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
  elia config                              Show provider readiness without printing keys
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
  elia control status                      Show durable runs and pending operator controls
  elia control pause <run-id>              Request a safe pause of an active autonomous run
  elia control stop <run-id>               Request a safe stop of an active autonomous run
                                           (review the stopped run's receipt, then: elia resume <run-id>)
  elia control preauth list                Show live --authorize grants for this project + branch
  elia control preauth revoke <intent>     Revoke a live grant immediately, before it expires or is spent
  elia auto "<goal>" --authorize intent:1  Pre-authorize a run for exactly one use of <intent>
  elia doctor                              Check native-stack health, and elia's own: crashes, bugs, unclean exits
  elia doctor --repair [signature]         Fix a recorded bug in elia's source on its own branch (--brief prints the goal)

Inside an interactive session:
  /                           Type "/" to see available commands — up/down to highlight,
                              tab to accept, enter to run, left/right to edit as usual
  /help                       Every command, with one line each; ? shows the keyboard shortcuts
  !<command>                  Run a shell command yourself; its output lands in the transcript
  @<path>                     Attach a file to your message
  /plan <goal>                Research and propose a plan before touching anything (shift+tab
                              toggles plan mode); enter runs the plan, esc keeps planning
  /rewind                     List rewind points for this session
  /rewind <n>                 Restore conversation + files to just before turn <n>
  /autopilot [N]              Work out what this repo needs and do it, unattended, as a turn you can
                              talk to (also: plan, resume, status). A bare \`elia\` starts it for you
  /sessions new <name>        A parallel session in its own git worktree (ctrl+n); ctrl+tab switches
                              which session delegation targets
  (type while elia works)     Ask anything — it answers right away, with the whole session in view,
                              and passes any change of plan to the running work
  /task                       Browse this session's tasks and subagents
  /status | /cost | /usage    Session and plan · token and cost breakdown · live context and limits
  /export                     Save the conversation to Markdown
  /mcp                        MCP servers — add, test, reload, remove
  /capabilities               List specialist capabilities, risk classes, and output contracts
  /eliabook                   Open Save this session / Saved Elia Books
  /eliabook save [book-id]    Save the complete current session as a reusable Book
  /eliabook saved             Browse session playbooks — sessions are added automatically as they end
  /eliabook create <run-id>   Create a Book from a complete autonomous-run recording
  /eliabook run <book-id>     Run its active verified procedure in this session
  /eliabook improve <book-id> <run-id>  Promote a measurably better verified run
  /mode                       Pick a core mode with arrow keys: dev, cyber, battmann, datascience, sysintel
  /mode <name>                Switch directly, e.g. /mode cyber, /mode dev ("tech" is an alias for dev)
  /betamode                   Pick an experimental mode or persona: sports, fitness, marketing,
                              finance, business, data, research, cybersecurity, automation,
                              communications, ai, production
  /betamode <name>            Switch directly, e.g. /betamode sports
  /settings                   Model, reasoning effort, skills,
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
  /usage                      Live token consumption, context-window fill, and the limits in
                              effect (context, reasoning, autonomous-run, provider/plan)

Other flags:
  elia --dev                  Start explicitly in dev mode (the default)
  elia --cyber                Start (or run a one-shot prompt) in cyber mode
  elia --battmann             Start (or run a one-shot prompt) in Battmann mode — strategic
                              intelligence across trade, geopolitics, financial markets,
                              supply chain, policy, and commodities
  elia --datascience          Start (or run a one-shot prompt) in Data Science mode — runs and
                              validates the analysis itself, with an execution record per step
                              (--ds is the short form)
  elia --sysintel             Start (or run a one-shot prompt) in System Intelligence mode — elia
                              works as a whole technical organization: every hat, lifecycle, review,
                              and sign-off, with gates only real evidence can pass (--si is the short form)
  elia --beta <mode>          Start in an experimental mode: sports, fitness
                              (the old --sports / --fitness flags still work, deprecated)
  elia --json                 Emit stable JSONL lifecycle events for automation
  elia --plain                Disable color, animation, and in-place terminal redraws
  elia --quiet                Print the final answer and essential failures only; keep TTY editing
  elia --verbose              Include detailed progress output
  ELIA_MAX_RUN_MS             Default wall-clock budget for autonomous runs; --max-run-ms overrides it
  ELIA_TOOL_CONCURRENCY       Read-only tool batches can use up to 8; mutating batches stay capped at 4
  ELIA_OTEL_ENDPOINT          OTLP/HTTP+JSON collector base URL — mirrors autonomous-run journal events
                              to it as OTel logs (POST <endpoint>/v1/logs), purely additive; unset (the
                              default) sends nothing
  elia --help                 Show this help; elia <command> --help shows just that command
  elia --version              Print the version

  UI output: --json/--jsonl emits machine-readable JSONL events; --plain disables color and redraws;
  --quiet minimizes progress; --verbose includes additional progress detail. Errors go to stderr
  in human modes. Sessions auto-save to .elia/sessions/. Configure a provider with elia config set
  or via .env — see .env.example.

  Diagnostics: --profile-turns (or ELIA_PROFILE=1) records every model call's
  cache-read/write split and time-to-first-token and prints a table at the end —
  use it to see how well the prompt cache is holding across a session.

Set ELIA_FAST_PROVIDER/ELIA_FAST_MODEL to give elia a cheap fast tier for recon work; it
routes investigation there and keeps the strong model for planning, building, and review.`
