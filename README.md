# elia

**elia is an autonomous agent that runs in your terminal, built to get better at its work by itself.** Give it a task in plain English, like "add rate limiting to the API client" or "find out why the tests fail and fix it". It reads your project, makes a plan, edits files, runs commands, checks its own work, and tells you what it did and what it proved.

Our focus is **recursive intelligence compounding**. Every verified task becomes material for elia to improve itself, and each improvement should make the next one easier to find. This happens in the harness around the model, not through fine-tuning, so it works with any model elia runs on.

It's built on [Bun](https://bun.sh), works with many LLM providers (Anthropic, OpenAI, Gemini, Groq, Mistral, NVIDIA NIM, OpenRouter, Inception Mercury, or any OpenAI-compatible endpoint), and is developed by **[Custumizer](https://linkedin.com/company/custumizer)**.

```bash
bunx elia-ai
```

## Recursive intelligence compounding

Most agents are exactly as good on their thousandth task as on their first. elia is built so that experience compounds:

```
  do the work ──► check it for real ──► turn checked work into a change ──► prove it on a benchmark
       ▲                                                                                   │
       └──────────── the improved agent does the work, and also runs the next improvement ─┘
```

1. **Record** every turn and autonomous run.
2. **Check** it against something that isn't a model's opinion: tests, builds, exit codes.
3. **Change** elia itself. `elia evolve` builds one hypothesis in a sandbox, and `elia distill` turns verified traces into role instructions.
4. **Prove** the change on a benchmark drawn partly from real git history, with no model in the scoring path.
5. **Measure memory.** Lessons are kept for measured benefit, tested with and without and in randomized holdouts.
6. **Compound.** The agent that proposes and builds improvements is elia itself. A promoted change to its loop, roles, tools or prompts improves the improver too, and its search strategy is replaced when it stalls.

The guards are enforced in code. The verifier must not get worse. The benchmark, the gate and elia's Value Core are off limits to the loop. Wins must repeat. Run `elia compounding` to see where each stage stands, computed from elia's own ledgers. **Today:** stages 1, 2 and 4 are working or partial; no generation has been promoted yet, so compounding itself is still unproven. See the [compounding guide](docs/guide/compounding.md).

## What elia does

- **It works a task like an engineer.** Before it changes anything, elia looks around the project and proposes a plan. The plan lists the steps and the exact commands that will prove the work is correct. Once you approve, a fleet of specialised sub-agents (scouts, builders, frontend and backend workers, testers) carries out the plan in parallel. Reviewers then check the result: a critic, a security reviewer and a bug hunter. If something fails, elia repairs it and records what it learned for the next run.
- **Every action goes through a gate.** A code-based *autonomy governor*, not a prompt, checks each tool call before it runs. Safe work goes ahead. Irreversible actions need your explicit approval: deleting, pushing, publishing, sending messages, deploying to production. That includes unattended runs. Each autonomous run leaves a redacted action ledger and a human-readable receipt. elia doesn't count a run as "done" just because the model said so; the run needs evidence first.
- **It remembers.** Lessons, past sessions and project notes carry across runs. elia notices routines it keeps repeating and can turn them into tested tools of its own.

It isn't only for code. Specialist modes cover research, data analysis, finance, spreadsheets and presentations, authorized security testing, and strategic intelligence (Battmann). Each mode has its own tools and safety rules.

## Install

You need [Bun](https://bun.sh) 1.3 or newer.

```bash
bunx elia-ai                     # run without installing
bun add --global elia-ai         # or install globally (npm install --global elia-ai also works)
elia --help
```

Interactive sessions check for a newer release at most once a day. Set `ELIA_NO_UPDATE_CHECK=1` to turn that off.

## Set up a provider

```bash
elia config set --provider anthropic   # prompts for the API key (input is hidden)
elia config                            # shows which providers are ready, never prints keys
```

If nothing is configured, the first interactive run walks you through setup. Keys are saved to `~/.elia/config.env` with owner-only permissions.

| Provider | `ELIA_PROVIDER` | API key env var | Default model |
|---|---|---|---|
| Anthropic | `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4.1` |
| Google Gemini | `google` | `GEMINI_API_KEY` | `gemini-3.7-flash` |
| Groq | `groq` | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| Mistral AI | `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| NVIDIA NIM | `nvidia` | `NVIDIA_API_KEY` | `nvidia/llama-3.3-nemotron-super-49b-v1.5` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `openrouter/auto` |
| Inception (Mercury) | `mercury` | `INCEPTION_API_KEY` | `mercury-2.5` |
| Any OpenAI-compatible endpoint | `custom` | `ELIA_API_KEY` | none, so set `ELIA_MODEL` |

You can also sign in with a ChatGPT subscription through the official Codex CLI. Other options are covered in the [configuration guide](docs/guide/configuration.md): overriding the model, a cheap "fast tier" for scouting, per-role providers, and automatic fallback.

## Use it

```bash
elia                                   # interactive session
elia "summarize this project"          # one-shot prompt
elia --continue                        # resume the last session in this folder
elia sessions                          # every conversation saved here, and what each one started with
elia --resume                          # pick one of them to reopen (or --resume <id> to go straight there)

elia auto "add rate limiting to the API client"      # plan → approve → build → verify → review → learn
elia auto "fix the race in the queue" --variants 3   # three independent attempts; the verified one wins
elia runs                                            # past autonomous runs
elia fork <run-id> --at 1 --with "use a token bucket instead"   # re-plan from a checkpoint
```

Inside a session, `/model` switches models, `/plan <goal>` starts a planned run, `/task` opens the task dashboard, `/mcp` manages MCP servers, and `!cmd` runs a shell command. Type `exit` or press Ctrl+C to quit. Use `--plain`, `--quiet` or `--json` for CI and scripts.

## Guides

| Guide | What's in it |
|---|---|
| **[Recursive intelligence compounding](docs/guide/compounding.md)** | The six stages, the commands, the guards, and where each stage stands today |
| [The Verified Discovery Engine](docs/guide/vde.md) | `elia vde`: the verification frontier, the certified library, the sealed gate, isolation and the resource governor |
| [Using the terminal](docs/guide/terminal.md) | All commands and flags, the terminal UI, images, LSP diagnostics, cost display |
| [Autonomous work](docs/guide/autonomy.md) | How `elia auto` works, roles, delegation, best-of-N, forking, durable runs, schedules and the daemon |
| [Configuration](docs/guide/configuration.md) | Providers, the Codex subscription, fallback, fast tier, per-role providers |
| [Modes and specialists](docs/guide/modes.md) | Dev mode and hooks, specialists, Battmann, Cybersecurity, Sports/Fitness, supported languages |
| [Integrations](docs/guide/integrations.md) | MCP servers and remote connectors, browser tasks, VS Code extension, deployment, Office files, data and finance, messaging, skills |
| [Security](docs/guide/security.md) | File and network boundaries, `.elia/policy.json` |
| [Self-improvement](docs/guide/self-improvement.md) | `elia bench`, `elia evolve`, Elia Books, `elia bench-latency`, learned tools |
| [Speed](docs/guide/performance.md) | Where elia's speed comes from and how it's measured |
| [How it works](docs/guide/architecture.md) | Source layout and testing |

## Status

**Working today:** the governed agent loop; parallel role-based sub-agents; the plan → execute → verify → review → repair cycle; durable, resumable runs with receipts; best-of-N execution in git worktrees; run forking; cross-session memory and lessons; MCP client and remote connectors; LSP diagnostics on every edit; the VS Code extension; and the specialist modes.

**Recursive compounding (our focus):** the machinery is complete and gated: recording, real checks, `elia evolve`, `elia distill`, git-history benchmarks, lesson trials and `elia compounding`. So far elia records its experience and checks it for real, and its benchmark still has room to improve (93% on `mercury-2.5`). No generation has been promoted yet, and lesson benefit hasn't been measured, so compounding itself is still unproven. The next milestone is the first promoted generation.

**Limits:** elia is a local application with application-level governance. It doesn't provide OS-level sandboxing, a secure keyring, or hosted 24/7 execution. See [SECURITY.md](SECURITY.md).

## Contributing

```bash
bun install
cp .env.example .env     # choose a provider and set its key
bun run dev              # same as `elia`, from source
bun test && bun run typecheck
```

The team's core repository (engineering standards, workflow and the R&D agenda) is private: [`custumizer-core`](https://github.com/MdSahilMolla/custumizer-core). To contribute or join, open an issue titled `Access request`, say who you are and what you'd like to work on, and a maintainer will follow up.

## License

[GNU Affero General Public License v3.0](LICENSE)
