# Recursive intelligence compounding

[← Back to the README](../../README.md)

elia's central goal is **recursive intelligence compounding**: each piece of verified work should make elia better, and each improvement should make the *next* improvement easier to find.

This happens in the harness: the loop, the roles, the prompts, the tools, the memory and the search strategy. It doesn't happen in model weights. There's no fine-tuning and no GPU. elia gets better around whatever model it runs on, including a fast hosted one like `mercury-2.5`.

## The six stages

Each stage feeds the next. `elia compounding` reads elia's own ledgers and reports where each stage stands. It computes every line from files elia already writes, and a stage with no evidence says so.

| # | Stage | What it means |
|---|---|---|
| 1 | **Record experience** | Every interactive turn and autonomous run is recorded as a trajectory |
| 2 | **Check that experience** | A run only counts if a real check passed: a test, a build, an exit code. A model's opinion doesn't count |
| 3 | **Turn checked work into a change** | `elia evolve` proposes one change to elia's own source, builds it in a sandbox, and promotes it only if the benchmark improves. `elia distill` turns clusters of verified traces into candidate role instructions |
| 4 | **Benchmark with room to improve** | A benchmark that can still move: synthetic tasks plus tasks harvested from this repository's own git history. No model is in the scoring path |
| 5 | **Know which lessons help** | Lessons are benchmarked with and without, and individual lessons get randomized holdout trials, so memory is kept for measured value rather than by assumption |
| 6 | **Gains improve the improver** | The proposer and builder inside `elia evolve` are themselves elia agents. So a promoted change to the loop, roles, tools or prompts also changes the improver. The improver's search strategy is itself trialled and replaced when it stalls |

```bash
elia compounding                 # where each stage stands, with evidence and the next step
elia bench --all                 # score on synthetic + git-history tasks
elia bench --all --lessons       # the same, with the lesson store on, to measure whether memory helps
elia bench --harvest             # rebuild the history task set from git (no model calls)
elia evolve -n 3                 # three generations, each building on the last
elia distill --dry-run           # which recorded runs qualify as verified traces, and why the rest don't
elia distill export              # export the verified traces
elia gap --critic                # measure the generator–verifier gap, including the critic
elia values                      # probe behaviour against the Value Core
```

## What keeps it honest

A loop that improves itself will happily improve its *score* instead of itself, so the guards are enforced in code:

- **The verifier leads.** Any promotion first checks that the verifier (the critic and the checks) didn't get worse. A stronger generator behind a weaker verifier is how a self-improving system starts compounding its own mistakes. That's why a change that blinds the critic is rejected, even when its task score looks better.
- **The benchmark and the gate are off limits.** Candidates can't edit the fitness function, the sandbox, existing tests, `package.json` or `tsconfig.json`.
- **The Value Core can't be rewritten by the loop.** elia's purpose and hard limits live in one version-controlled document. `elia evolve` and distillation can't touch it; a change needs a human commit.
- **Wins must repeat, and ties are rejections.** A provisional winner is re-measured in an independent pair and must beat the baseline both times. A regression on any task disqualifies it.

Details of the evolve gate are in [Self-improvement](self-improvement.md).

## Where it stands today

Run `elia compounding` for the live picture. As of 2026-09-16, on `mercury-2.5`:

| Stage | State | Evidence |
|---|---|---|
| 1. Record experience | working | 214 interactive turns, 18 autonomous runs recorded |
| 2. Check that experience | partial | 63 of 232 (27%) passed a check that wasn't a model's opinion |
| 3. Turn checked work into a change | partial | 2 evolve generations, 0 promoted |
| 4. Benchmark with room to improve | working | 93% on 54 measured tasks, so 7 points of headroom |
| 5. Know which lessons help | no evidence yet | the lesson store hasn't been benchmarked with and without |
| 6. Gains improve the improver | no evidence yet | no promotion yet, so nothing to compound on |

The machinery is complete and gated. What's missing is turns: the loop hasn't yet promoted a change. The next milestone is the first promoted generation, followed by evidence that it made the next one easier.
