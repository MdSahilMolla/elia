# Elia + Mercury 2.5 on ARC-AGI-3

This runner evaluates Elia's actual `runAgentLoop` with its Mercury provider
adapter and a single serialized `arc_action` tool. The official ARC toolkit
executes and scores the public environments locally. This is a public
development-set evaluation of this specific Elia harness, not an official
hidden-set leaderboard result or a test of all Elia coding/fleet features.

## Windows setup

```powershell
uv venv .elia/bench/arc3/.venv --python 3.12
uv pip install --python .elia/bench/arc3/.venv/Scripts/python.exe arc-agi==0.9.9 arcengine==0.9.3
.elia/bench/arc3/.venv/Scripts/python.exe scripts/arc3_bridge.py --root .elia/bench/arc3 --prepare
```

Preparation downloads public environments through the official toolkit using
anonymous discovery when `ARC_API_KEY` is absent. It does not publish a scorecard.
Environment files, recordings, the Python environment, and receipts stay under
the ignored `.elia/bench/arc3/` directory. Never expose environment source or
metadata containing solutions/human baselines to the model.

Use an existing `INCEPTION_API_KEY` in the environment or Elia's user configuration.
The runner pins `mercury-2.5` for its process without rewriting saved settings.
No provider fallback, web access, shell access, executable project skills, or
cross-game memory is offered to the evaluated agent.

## Run

Validate the transport and scorer without paid model calls:

```powershell
bun run scripts/bench-arc3.ts --smoke-only --actions 1 --calls 1
```

Run a bounded three-game pilot:

```powershell
bun run scripts/bench-arc3.ts --games ar25,bp35,cd82 --actions 80 --calls 100 --minutes-per-game 10 --budget-usd 1
```

Omit `--games` to evaluate every installed public environment in alphabetical
order. Set a deliberate cost, action, call, and wall-clock budget. Budget stops,
provider errors, and unplayed environments must be reported, not silently
dropped from comparisons. An 80-action pilot is not an unlimited solve attempt.

## Evidence and interpretation

Each run directory contains `manifest.json`, `events.jsonl`, and `results.json`.
The official toolkit also writes replay recordings. Receipts contain the prompt,
model, environment versions, seed, action/call limits, raw observations, visible
agent text, token usage, terminal state, and unmodified official score values.
Private model reasoning and API keys are not recorded by the runner.

The observation adapter uses lossless hexadecimal pixels, compressing only runs
of identical rows. Mercury is text-only; no other vision model interprets frames.
Game transitions are serialized even if Elia requests parallel tool calls. The
normal governor runs in supervised mode with a scoped callback approving only
the benchmark's local `arc_action` tool; repository policy still applies.

Cost tracking conservatively charges cached input as uncached at the official
undiscounted rates ($0.20/M input, $0.75/M output). Before each request it reserves
260k input plus 32k output tokens; failed requests retain this reserve. This is a
conservative estimate, not a provider billing receipt. Promotional prices can
be lower. The adapter's provider-default reasoning behavior is retained.

Judge completion and action efficiency using the official local scorecard,
not agent prose. Compare separately against a same-model baseline before
attributing performance to Elia. Public tasks may have appeared in training;
fresh/hidden tasks and repeated trials are needed for stronger claims.

Official references:

- https://docs.arcprize.org/toolkit/overview
- https://docs.arcprize.org/local-vs-online
- https://docs.arcprize.org/methodology
- https://docs.inceptionlabs.ai/get-started/models
