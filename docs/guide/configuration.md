# Configuration

[← Back to the README](../../README.md)

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

The model picker also shows **ChatGPT subscription (Codex)**. You can select it directly from **Settings** → **Provider connections** with the arrow keys, then press Enter to start the official Codex CLI's ChatGPT sign-in flow. A successful sign-in switches Elia to its subscription-backed `codex` provider immediately and remembers that selection. This is deliberately separate from the `openai` API-key provider: Elia does not expose or save your subscription credentials. A ChatGPT subscription is not copied into `OPENAI_API_KEY` or used for ordinary OpenAI API calls. The subscription provider keeps one authenticated Codex app-server process alive and reuses it instead of paying process startup and initialization latency on every request. The moment you select the subscription (or at startup when it is already active) Elia warms it in the background — the login check, the app-server connection, and the workspace thread itself — so the first turn goes straight to generating instead of paying cold start. The login check is asynchronous, so it never stalls typing. Each Elia chat has its own Codex conversation thread, pinned to the stable session prompt so it survives every user turn — the per-turn context (wall-clock date, query-ranked project memory) rides in the turn input rather than forcing a thread rebuild. Choosing the subscription as your model is confirmed once per session, not re-approved on every message. In the terminal the whole hand-off shows as a single **ChatGPT subscription** action with a running timer, not Codex's internal command/plan/diff stream — that granular activity still goes to the JSON event stream and the structured run receipt for audit, just not to scrollback (and even there, command output is coalesced into one tail digest per command and the cumulative workspace diff is throttled). Warnings (including usage-limit notices) and model reroutes do surface. If the run fails because your ChatGPT plan's own usage cap was hit, Elia says so plainly — with the reset window when Codex reports one — and points you to `/model`, rather than surfacing it as an Elia error. Codex runs in a network-disabled `workspace-write` sandbox, so it can inspect, edit, and test the active project; the initial prompt tells it its working directory, platform, and that it has no network. Elia records the hand-off as a critical action and requires one explicit approval per session before the first turn (and `elia auto` still refuses it outright); the adapter never grants a noninteractive child automatic approval for network or other consequential external actions.

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
| Inception (Mercury) | `mercury` | `INCEPTION_API_KEY` | `mercury-2.5` |
| Ollama (local models) | `ollama` | none needed (`OLLAMA_API_KEY` only if your server asks for one) | none — elia asks which of your models to run |
| Any other OpenAI-compatible endpoint | `custom` | `ELIA_API_KEY` | none — set `ELIA_MODEL` |

Any provider's model can be overridden with `ELIA_MODEL`. `openrouter` uses OpenRouter's OpenAI-compatible endpoint and its `openrouter/auto` router by default; set `ELIA_MODEL` to pin a specific OpenRouter model. `mistral` uses Mistral's OpenAI-compatible endpoint and `mistral-large-latest` by default; set `ELIA_MODEL` to choose another Mistral model. `google` uses Google's OpenAI-compatible Gemini endpoint and `gemini-3.7-flash` by default; set `ELIA_MODEL` to choose another compatible Gemini model. `nvidia` uses NVIDIA's hosted NIM OpenAI-compatible endpoint and `nvidia/llama-3.3-nemotron-super-49b-v1.5` by default; set `ELIA_MODEL` to choose another available NIM model. `custom` (and any provider, if you need to point at a proxy or self-hosted gateway) also honors `ELIA_BASE_URL`; configure it with `elia config set --provider custom --base-url <url> --model <model-id>`.

## Local models with Ollama

elia talks to [Ollama](https://ollama.com) through its native API. No API key or `.env` edit is needed.

```bash
ollama pull qwen3                                   # any model that supports tools
elia                                                # finds Ollama and asks which model to run
elia config set --provider ollama --model qwen3:8b  # or set it without the prompt
```

- **Detection.** When elia starts in a terminal, it checks for Ollama. With no provider configured, `ollama` is listed first and elia asks which of your pulled models to run. If you already use a hosted provider, elia offers your local models once, and `/model ollama` switches any time. If Ollama is your provider but isn't running, or the model you chose is no longer pulled, elia says so at startup and asks again. `ELIA_OLLAMA_DETECT=off` turns detection off.
- **Tool calling.** elia works by calling tools (reading, editing, running commands). The model picker marks each model with what Ollama reports it can do. Models without **tools** are listed last and flagged, because they can talk but can't act.
- **Context window.** elia sends about 17k tokens of instructions and tool definitions before your first message. Ollama's default window is 4k on machines with under 24 GB of VRAM, and its OpenAI-compatible `/v1` endpoint can't change it per request, so pointing the `custom` provider at Ollama loses most of the prompt without an error. The `ollama` provider sets `num_ctx` on every request instead: the model's own maximum, capped at 32,768. It also tells elia's compaction that window, so the conversation is summarized before Ollama would cut it. Set `ELIA_OLLAMA_NUM_CTX` to change the window. A larger window uses more memory. Models whose maximum is under 24k are flagged as too small for elia.
- **Where it runs.** elia reads `OLLAMA_HOST` the way Ollama does (default `127.0.0.1:11434`). Plain HTTP is allowed only on this machine. A remote Ollama must be served over HTTPS (for example behind a reverse proxy). `OLLAMA_API_KEY` is sent as a bearer token if set. For an Ollama on another machine without TLS, use an SSH tunnel to a local port.
- **Speed.** A local model loads from disk on its first request, which can take a minute for a large one. elia allows for that: `/model` waits up to five minutes for the first answer, and a response may stay silent for up to ten minutes (`ELIA_STREAM_IDLE_MS` overrides it). Ollama is never used as an automatic fallback, because it has no default model to fall back to.

## Automatic provider fallback

The selected provider and model remain primary. Use `/model auto` or set `ELIA_ROUTING_MODE=auto` to try another configured provider when the selected route fails before output because of a missing model, outage, network error, rate limit, or retryable server response. Fallback is immediate when another ready provider exists and never retries after partial output.

## Manual model discovery and raw model performance

`/model` first shows every known provider and its readiness. Selecting a provider queries that provider’s models endpoint **on demand**, then opens a second picker containing the available model IDs. Direct selection remains available with `/model <provider> <model-id>` or `/model <model-id>` for the current provider. This keeps startup fast and lets users choose newly released provider models without waiting for a code release. If a provider does not expose a models endpoint, its configured default and direct model-ID syntax still work.

Elia does not replace the underlying model with a smaller “agent personality,” hidden chain-of-thought imitation, or prompt-heavy wrapper. The autonomy layer contributes tools, planning, safety gates, routing, verification, and recovery; the selected model receives the normal request through the existing provider adapter. The user can therefore select the model manually while keeping its native reasoning and generation capability intact.

## The fast tier (optional, recommended)

Elia routes work across two model tiers. The **deep** tier plans, builds, and reviews. The **fast** tier does the high-volume legwork — read-only scouts, summarising, end-of-run note taking — where a cheap model is indistinguishable but several times quicker. Set `ELIA_TOOL_CONCURRENCY` to tune tool batches; read-only reconnaissance is bounded at 8 concurrent calls, while any batch containing mutations or external side effects remains capped at 4. Speed controls never remove deep-tier implementation or verification work.

```bash
ELIA_FAST_PROVIDER=groq
ELIA_FAST_MODEL=openai/gpt-oss-20b
```

Investigation is where an agent spends most of its wall clock, and almost none of it needs the strong model. With a fast tier configured, a five-scout recon sweep costs a fraction of what it would otherwise, while every actual decision still goes through the deep model. Leave it unset and both tiers are the same model — behaviour is identical, you just don't get the speed-up.

## Per-role providers (optional, for true multi-model fleets)

Any role can be pinned to its own dedicated provider, on top of (or instead of) the tier system — e.g. run scouts on Groq for raw inference speed while critics stay on Claude for judgment:

```bash
ELIA_SCOUT_PROVIDER=groq
ELIA_SCOUT_MODEL=openai/gpt-oss-20b
```

The pattern is `ELIA_<ROLE>_PROVIDER` / `ELIA_<ROLE>_MODEL` / `ELIA_<ROLE>_BASE_URL` / `ELIA_<ROLE>_API_KEY` for any of `SCOUT`, `BUILDER`, `FRONTEND`, `BACKEND`, `CRITIC`, `SECURITY`, `BUGHUNTER`, `TESTER`, `SCRIBE`. Unset roles fall back to their tier exactly as before.

This is what makes a fleet a genuine multi-model system rather than one model wearing different hats: a wave of five scouts and a critic isn't five-plus-one calls to the same provider's rate limit, it can be two calls to two providers running fully in parallel. Fleet concurrency scales with how many distinct providers a batch actually uses (`fleetConcurrency` in `src/autonomy/fleet.ts`), so spreading roles across providers also widens how much runs at once — a single-provider fleet still caps at 4 concurrent workers, but a two-provider fleet can run 8, up to a hard ceiling of 16.

Use `/team` during an interactive session to see the routes Elia actually resolved. Independent workers share a dependency wave only when their work is separable; colliding or dependent writers remain serialized, and multi-persona parallel investigation waves are read-only before deep-tier synthesis.
