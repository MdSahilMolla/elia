# Using the terminal

[← Back to the README](../../README.md)

## Usage

```bash
elia                    # interactive session
elia "list the files in this directory"   # one-shot prompt
elia --continue         # resume the most recent session in this directory
elia --resume <id>      # resume a specific session

elia auto "<goal>"                # plan, delegate to a fleet, verify, repair, and learn — end to end
elia auto "<goal>" --fast         # bounded fast path for simple work: one reviewer, one repair, no polish/lessons
elia auto "<goal>" --thorough     # deeper bounded review and repair for high-risk changes
elia auto "<goal>" --max-run-ms 900000  # hard wall-clock budget for this run
elia auto "<goal>" --yolo         # same, without pausing for plan approval
elia bench                        # score the current elia against its own benchmark suite
elia evolve                       # elia proposes and tries one improvement to its own source
elia evolve -n 3 --dry-run        # three generations, evaluated but never promoted to live source
elia skills                       # list tools elia has written for itself
elia skills path                  # print skill folders and the manual skill contract

elia skills candidates            # show repeated work that could become a new tool
elia skills synth                 # write a tool for the strongest candidate
elia config                       # show provider readiness without printing keys
elia config set --provider nvidia # securely save a provider key and model

elia runs                         # list past autonomous runs
elia runs <id>                    # show one run's timeline, graph state, and forkable points
elia fork <id> --at <n> --with "<change>"   # re-plan an earlier run from a checkpoint
elia resume <id>                    # continue a durable goal and reconcile pending approvals and stale leases
elia agent "<request>" --dry-run       # show specialist routing without executing tools

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

In manual mode, Elia performs its preliminary risk check and asks before risky user-requested work. Your message is echoed to the transcript the instant you press Enter — the risk check runs after, shown as a brief "checking…" state — and a plain question skips the check entirely (a local pre-filter, no model round-trip), so only messages that could actually carry a destructive instruction pay for it. Auto mode skips that preliminary check, but governed irreversible actions still require explicit approval unless unattended execution was explicitly requested with the appropriate autonomous flag. This distinction is shown in the startup status line and is not merely cosmetic.

After every response you'll see a dim usage line — `2.5s · 1,840 tokens · $0.0041` — and a `Session: N turns · ... · $... · ...` total when you exit. Sub-agent usage (`task` calls) counts toward the total even though sub-agents run silently. Cost is a best-effort estimate from a small hardcoded pricing table (`src/usage.ts`) verified against provider pricing pages as of 2026-08-18 — providers change pricing without notice, so treat it as orientation, not a bill. An unrecognized model shows "cost unknown" rather than a fabricated number. Autonomous runs also write `.elia/runs/<run-id>/receipt.md`, `receipt.json`, and a redacted `actions.ndjson` ledger that records the actor, role, tool, risk decision, outcome, and replay pointers without storing credential-like inputs.

Elia has a `workspace/` folder (created on first use, next to `.elia/` but visible — not a dotfile) for standalone output: prototypes, generated pages, anything that isn't an edit to your existing project. Ask it to show you something and it calls `preview`, which opens a real Chrome window (falls back to your OS default browser if Chrome isn't found, and says so) — files under `workspace/` are served locally with push-based live-reload over a WebSocket, so the window updates itself as elia keeps editing, no manual refresh. An already-running URL (e.g. a dev server elia started itself) opens directly instead, without live-reload.

## Terminal UI

On a real TTY, `elia` / `elia` uses the Ink terminal workspace; plain or piped output keeps the streaming fallback. Assistant replies render headings, lists, checklists, blockquotes, fenced code, tables, rules, and safe visible links without exposing terminal control sequences. The live Workspace panel shows structured plans, parallel subagents with their provider/model and dependency wave, other chats, and recent artifacts.

`edit_file` and `write_file` results render as a colored unified diff (folded to the changed hunks; `/expand` reprints any tool result the scrollback truncated). Visualizations render their terminal chart without requiring expansion. A line starting with `!` runs the rest as a shell command and carries its output into the next turn as context. `/team` shows the active deep/fast tiers and configured role routes; `/cost` shows usage; `/export [path]` writes the conversation to Markdown.

**Images.** Paste or drag an image file (`.png`, `.jpg`, `.gif`, `.webp`) straight onto the prompt line — Elia reads it, strips the path from your text, and sends the picture along with the message. `/attach <path>` queues one explicitly for your next message (`/attach` lists what's queued, `/attach clear` empties it). Images go to any vision-capable API model; the ChatGPT-subscription (Codex) provider has no image channel, so an attachment there becomes a text marker naming the file.

## LSP diagnostics on every edit

`write_file` and `edit_file` check the changed file against a real language server, not just a text diff. If a server is available for the file's language, elia opens/updates the document and appends any errors or warnings the server reports directly to the tool result — catching a broken reference or a type error the instant it's introduced, well before the next `tsc`/`pytest`/`go build`. One server process per language is started lazily and reused for the rest of the session.

Elia doesn't install these — bring your own, same as any editor:

| Language | Server it looks for |
| --- | --- |
| TypeScript / JavaScript | `typescript-language-server` |
| Python | `pyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |

A missing binary just means diagnostics are silently unavailable for that language — the tool's normal result is unchanged, nothing blocks or errors. Set `ELIA_LSP=off` to disable this entirely.
