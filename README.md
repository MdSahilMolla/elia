# elia

A fast, autonomous coding agent for the terminal, built on Bun. It streams model output live, calls tools (file read/write/edit, glob, grep, shell) automatically in a loop, and works with multiple LLM providers.

## Requirements

- [Bun](https://bun.sh) >= 1.3

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
| Inception (Mercury) | `mercury` | `INCEPTION_API_KEY` | `mercury-2` |
| Any other OpenAI-compatible endpoint | `custom` | `ELIA_API_KEY` | none — set `ELIA_MODEL` |

Any provider's model can be overridden with `ELIA_MODEL`. `custom` (and any provider, if you need to point at a proxy or self-hosted gateway) also honors `ELIA_BASE_URL`.

## Usage

```bash
bun run dev                    # interactive session
bun run dev "list the files in this directory"   # one-shot prompt
bun run dev --continue         # resume the most recent session in this directory
bun run dev --resume <id>      # resume a specific session
elia --help
elia --version
```

In an interactive session, type `exit` or press Ctrl+C to quit. Elia — a small ASCII Greek woman in a laurel wreath — appears at startup and animates in place (3 cycling poses, live elapsed-time counter) while the model is thinking. The moment real output starts streaming she's cleared and replaced by a blinking type-cursor that only appears during pauses *within* the stream (e.g. waiting on the next network chunk) — fast streaming never flickers.

After every response you'll see a dim usage line — `2.5s · 1,840 tokens · $0.0041` — and a `Session: N turns · ... · $... · ...` total when you exit. Sub-agent usage (`task` calls) counts toward the total even though sub-agents run silently. Cost is a best-effort estimate from a small hardcoded pricing table (`src/usage.ts`) verified against provider pricing pages as of 2026-08-18 — providers change pricing without notice, so treat it as orientation, not a bill. An unrecognized model shows "cost unknown" rather than a fabricated number.

Elia has a `workspace/` folder (created on first use, next to `.elia/` but visible — not a dotfile) for standalone output: prototypes, generated pages, anything that isn't an edit to your existing project. Ask it to show you something and it calls `preview`, which opens a real Chrome window (falls back to your OS default browser if Chrome isn't found, and says so) — files under `workspace/` are served locally with push-based live-reload over a WebSocket, so the window updates itself as elia keeps editing, no manual refresh. An already-running URL (e.g. a dev server elia started itself) opens directly instead, without live-reload.

## How it works

- **`src/agentLoop.ts`** — the shared core loop: send messages to the active provider, stream text to the terminal, execute any tool calls the model requests (in parallel, up to 4 at a time), feed results back, and repeat until the model stops calling tools. Used by both the top-level agent and sub-agents.
- **`src/agent.ts`** — the top-level agent: runs `agentLoop` with the full tool set (including `task`), live streaming to the terminal, and the thinking animation.
- **`src/subagent.ts`** and **`src/tools/task.ts`** — the `task` tool lets the model delegate an independent, self-contained piece of work to an autonomous sub-agent with its own isolated context. Sub-agents run silently (no live terminal output) and can't spawn further sub-agents. Calling `task` multiple times in one turn runs those sub-agents in parallel.
- **`src/providers/`** — a small provider abstraction (`types.ts`) with two adapters: `anthropic.ts` (native Anthropic Messages API, with prompt-caching breakpoints on the system prompt, tools, and tail of the conversation for speed) and `openaiCompatible.ts` (one adapter covering Groq, OpenAI, Mercury, and any other OpenAI-compatible endpoint via `baseURL`). `registry.ts` resolves `ELIA_PROVIDER`/env vars into a concrete provider instance.
- **`src/tools/`** — `read_file`, `write_file`, `edit_file` (exact string replace), `list_files` (glob), `grep`, `run_command` (shell, 60s timeout), and `task` (sub-agent). Each tool is a plain object with a JSON schema and an `execute()` function.
- **`src/memory.ts`** — loads `ELIA.md` (project, in the cwd) and `~/.elia/ELIA.md` (user, global) into the system prompt at startup, so persistent instructions don't need to be repeated every session.
- **`src/session.ts`** — every session is auto-saved to `.elia/sessions/<id>.json`; `elia --continue`/`-c` resumes the most recent one in the current directory, `elia --resume <id>` resumes a specific one.
- **`src/ui/stream.ts`** — writes streamed text and tool-call/result notices directly to the terminal as they happen, no buffering.
- **`src/ui/character.ts` + `src/ui/animator.ts`** — Elia's ASCII art frames and a small in-place terminal animator (raw ANSI cursor control, no dependencies).
- **`src/ui/streamCursor.ts`** — the blinking cursor shown during mid-stream pauses.
- **`src/usage.ts`** — token/time/cost accounting: per-turn and cumulative-session accumulation, the pricing table, and formatting.
- **`src/preview/server.ts`** — localhost-only static server (`127.0.0.1`, ephemeral port) over `workspace/`, singleton per process. Injects a small live-reload script into served HTML and pushes a reload message over WebSocket whenever a watched file changes. Guards against path traversal.
- **`src/preview/launchChrome.ts`** — finds a real Chrome install across Windows/macOS/Linux and launches it detached; falls back to the OS default-browser opener (and says so) if Chrome isn't found.
- **`src/tools/preview.ts`** — the `preview` tool: `path` (served + live-reloaded from `workspace/`) or `url` (opened directly, e.g. a dev server elia started itself). Top-level only, same as `task`.

Both animation pieces automatically disable themselves when stdout isn't a real terminal (piped/redirected output), so scripted usage is never polluted with escape codes.

## Testing

```bash
bun test        # unit tests for the tools
bun run typecheck
```

The test suite covers the tools, session persistence, and memory-file loading directly and doesn't require any API key. Exercising the actual model loop (streaming, parallel tool calls, sub-agents end-to-end) requires a real provider key and is a manual step — run `bun run dev` and try a prompt.

## Status

This is an early, minimal build. Sub-agents (parallel `task` calls), prompt caching, session persistence/resume, and token/time/cost tracking are in. Deliberately out of scope so far: a permission/confirmation system for risky actions, MCP support, and git-aware diff review. The code is structured so these can be layered on without a rewrite.

### On speed

Two things already do the heavy lifting: Anthropic prompt caching (system prompt, tool definitions, and the tail of conversation history are marked as cache breakpoints, so an unchanged prefix of the growing tool-calling loop is reused instead of reprocessed — the single biggest lever for both latency and cost) and parallel tool execution (up to 4 tool calls in flight at once via `agentLoop.ts`'s concurrency limiter). `max_tokens` for Anthropic was also raised from 8192 to 32,000 (Sonnet 5 supports up to 128k) — billing is by tokens actually generated, not the ceiling, so this only removes a risk of truncated output on larger tasks with no cost downside.
