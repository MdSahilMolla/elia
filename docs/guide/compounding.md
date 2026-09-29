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
elia compounding frontier        # the verification frontier and the resource governor's plan (see discovery.md)
elia compounding round           # run the governor's top activity; --spend lets it call a model
elia bench --all                 # score on synthetic + git-history tasks
elia bench --all --lessons       # the same, with the lesson store on, to measure whether memory helps
elia bench --canaries            # how often elia fakes a result on tasks only cheating can pass
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
- **Cheating is measured, not assumed away.** Studies of self-improving loops in 2026 found proxy-only gains in roughly half to three quarters of optimisations, growing with every step. So before a promotion both trees run the canaries: tasks only a faked result can pass. A candidate that cheats more than the live tree is rejected, however well it scored. `elia bench --canaries` reports the rate on its own.

Details of the evolve gate are in [Self-improvement](self-improvement.md).

## What a verdict costs

The machinery above was complete for weeks and the loop still turned twice. The reason was never a missing part — it was the price of an answer. Scoring one candidate meant running all 54 benchmark tasks against a paid model, and since nearly every candidate is rejected, almost all of that spend bought a single bit: *no*. A search that costs a day's credit per step cannot compound, however good its gates are.

**The sieve** (`src/evolve/sieve.ts`) buys the verdict instead of the scoreboard. It reads the decision rule rather than the totals, and exploits three things that rule already implies:

1. **A regression is the whole answer.** `compareScorecards` rejects the moment any task regresses, whatever the other fifty-three say — so a run that has seen one has already produced its final verdict, and every task after it is paid for and thrown away. The sieve stops there. This is not an approximation: it returns the identical `better` the full sweep would have, from the same comparison on the same arithmetic.
2. **Order is free to choose.** Only a task that passes today can regress, and a task that loads more of the changed code is likelier to be the one that breaks. Running those first is what turns a rejection from a 54-task question into a two-task one.
3. **Most tasks cannot be affected at all.** A Bun preload plugin records which of elia's modules each task actually loads — free, riding along on runs that were happening anyway. A task that never loads a changed file is provably unmoved, so its baseline row carries straight over: result, tokens and time alike. A diff that reaches no task at all is rejected as *inert*, for nothing.

Carrying the cost, not just the result, is what keeps this honest. Dropping unreachable tasks from the totals would hand every candidate a fake efficiency win — four fewer tasks in the denominator reads as "80% fewer tokens". For the same reason a partial race is never timed by how long the race took; its wall clock is the baseline's, scaled by the ratio of summed task durations, and the tasks it never ran are recorded as *unmeasured* so the card fails closed rather than passing for a result.

**The baseline cache** (`src/evolve/baselineCache.ts`, on by default, `ELIA_BASELINE_CACHE=off` to disable) closes the other half. `elia evolve` opens by measuring the live tree — a full sweep, paid before a hypothesis exists — and with no promotions between runs it is scoring identical code every time. Each task's outcome is keyed on the hashed contents of the modules that task loads, plus the model, so an untouched tree costs nothing to re-baseline and any edit inside a task's footprint misses. `elia bench` and the idle practice run share this baseline, and all three keep each task's result as soon as it lands. So a sweep bigger than one quota window (the first full sweep on a free tier got halfway and kept nothing) resumes where it stopped rather than starting over. `elia bench --fresh` re-runs every task.

Neither shortcut can promote anything. A provisional winner still has to reproduce on two full sweeps, pass the verifier-gap check and the value probes, and clear the immutable-file guard. What they change is how many hypotheses the same budget can afford to test.

Turn it all off with `ELIA_SIEVE=off`, which is also the control arm for measuring what it is worth.

### The same verdicts, sooner

The sieve and the cache cut *how much* a verdict costs. The rest of a
generation's wall clock came from phases that were independent but run one after
the other. Two of them now run concurrently, and neither changed what is
measured or how the answer is decided:

- **The guards.** The generator–verifier gap (`elia gap --critic`) and the value
  probes are each measured on both trees; the two trees run in parallel. Both
  checks still have to pass, and a tree that cannot be measured still rejects.
- **The gate.** `bun run typecheck` and `bun test` are independent and now run in
  parallel inside the sandbox, with the same timeout and the same
  typecheck-first verdict order. A test file that fails is still re-run on its
  own before it rejects, so a timeout caused only by the shared CPU does not
  turn a candidate away.

The benchmark sweeps are deliberately left alone. `ELIA_BENCH_CONCURRENCY`
(default `2`) is how many agent loops run against the provider at once, and the
confirmation pair's two sweeps still run one after the other so that number
means what it says — a provider with a per-minute input-token cap needs `1`
(the history tasks send hundreds of thousands of tokens each), and two sweeps at
once would split its quota and leave tasks unmeasured. On a provider with room
to spare, raise `ELIA_BENCH_CONCURRENCY`; every sweep speeds up together.

`ELIA_HARVEST_SCAN` and `ELIA_HARVEST_LIMIT` bound the commits scanned and the
tasks proved in one `harvest` round, since proving a commit is two test runs in
a fresh checkout and the first pass over a deep history is the loop's most
expensive no-model step.

None of this touches the arithmetic: `compareScorecards`, the sealed gate and the
immutable-file guard are unchanged, and a tie is still a rejection.

### The number that shows it compounding

`elia compounding` now reports **evidence velocity**: task runs and tokens per verdict, and whether that price is falling. It is the one figure here that can show a loop compounding without a weight changing anywhere — cheaper verdicts mean more generations per budget, more generations mean more promotions, and a promotion that lands in the search itself makes the next verdict cheaper again.

Stage 6 deliberately does *not* move on it. The first drop came from switching the sieve on, which is one change by one hand, not the loop compounding on itself. The number is reported; the stage stays earned by promotions.

### What it also made visible

Recording what the benchmark loads answered a question nobody had asked. Half of elia's source — 218 of 436 modules, most of `src/ui`, `src/autonomy` and `src/workspace` — is never loaded by a benchmark task at all. A hypothesis confined to those cannot move a score no matter how good it is, and the loop used to spend a full sweep finding that out. The proposer is now told up front which areas the benchmark can see.

The same recording showed the limit of the idea: every benchmark child loads the same 218-module core, because `src/tools/registry.ts` imports every tool statically. So reachability prunes *candidates*, not tasks — the per-task saving comes from the stop rules, not from carrying. Making the tool registry lazy would give the map real per-task discrimination, and is the obvious next thing to try.

## Only a verdict counts as a verdict

Of the first ten generations on this machine, one reached a real verdict against its idea (gen 13: no improvement, 79% slower). Three crashed on the provider. Two were refused as "an incomplete benchmark": the same two history tasks failed on the provider both times (a stall or refusal the retries did not clear), and they were two of the four tasks with any headroom. Four carry a hand-written note saying the rejection was noise or a rule since fixed. All nine were still listed to the next proposer as "tried and rejected — do NOT propose these again", and counted against the search strategy that proposed them. The loop was steering away from ideas that had never been tested.

`judgementOf` (`src/evolve/ledger.ts`) now sorts every record into promoted, rejected, or not judged. A record is not judged if it errored, if its comparison could not be completed, or if a note corrects it. The proposer sees not-judged ideas in their own section, "retrying one is allowed". They no longer count toward the strategy trial or the stalled/accelerating trend.

### Heavy tasks back off when the provider does

The tasks that went unmeasured are the heavy ones. History tasks get 80 steps, an 800-second limit and hundreds of thousands of input tokens each. Two at a time share one rate-capped provider (Mercury's free tier caps input tokens per minute), and the loop runs them two at a time: the sweep, the evolve race's waves, and the regression retest (which runs the candidate and the live tree at once). `fitness.ts` now puts every heavy attempt through one lane per process. The lane starts as wide as the benchmark, so a provider that never objects loses no speed. The first time the provider rate-limits or stalls a heavy task (both are retried, never scored), the lane narrows to one for the rest of the process, and the retry runs alone. The line `the provider pushed back on … heavy tasks run one at a time from here` says when it happened.

### The improver's memory of its own ideas (hyperdimensional)

The proposer is shown the whole ledger and still resubmits: gen 16 was gen 15 word for word, and gen 9 was gen 7 reworded. `src/evolve/ideas.ts` checks each `submit_hypothesis` call before anything is built or measured. Each verdict costs about 8M tokens here.

- **Encoding.** A hypothesis is encoded as a hypervector, a bundle of character trigrams (`src/hdc/hypervector.ts`: 10,048-bit binary spatter codes with bind, bundle, permute, sets, records and cleanup). Its files are encoded as a set.
- **The rule.** A title at least 40% alike to a *judged* idea is sent back once, with that generation's verdict. A second submission goes through, recorded as `echoes` on the ledger row. A repeat of a *not-judged* idea is allowed: gen 16 was right to retry 15.
- **Calibration.** Measured on the real ledger: the two real repeats score 1.00 and 0.51, and the closest pair of different ideas scores 0.28. Two repeats is little to calibrate on.
- **Honest comparison.** Plain word overlap separates the same pairs too, just with a narrower margin (0.41 against 0.24). HDC is not doing anything magic here. What it adds is one representation for text, sets and structured records, which later memories can reuse.

## The world model: pay only for a change that can win

The world model has two halves that share one discipline: commit to a prediction before the result, score it after. The **runtime** half runs in every agent loop and models the project elia is working in (`src/world/runtime.ts`, described in [How it works](architecture.md)). The **twin** half models elia's own source, and is what this section is about.

A verdict costs about a full sweep, and nearly every candidate loses. Two generations (15 and 16) each spent 13M and 10M tokens on a builder-prompt edit in `src/autonomy/roles.ts`, which loads in every task and runs in none. A search that pays that to learn "no" does not compound, so the loop now reads a change before it pays for it.

**The twin** (`src/world/`) is an executable model of elia's own harness that prices a diff without calling a model. Its core is exact. A task's tokens are steps times what every call sends first plus what the conversation has built up, and on the 19 built-in tasks the fixed part alone (113 steps × 3 attempts × about 17k tokens) is 94% of the 6.3M tokens they cost. So for an edit to the system prompt or a tool definition, `Δtokens = Σ steps × attempts × Δprompt`, which is arithmetic on text. The probe (`src/world/probe.ts`) reads the prompt size by running the *candidate's own code*, the same way the tool-surface check does. An edit to logic has no formula (a changed loop can take more steps or fewer), so it is priced as a gamble, wide, and left to the benchmark. `src/world/text.ts` tells a wording edit from a logic edit by blanking comments and string text and comparing what is left; anything it cannot read confidently counts as logic.

Before any benchmark task runs, the twin stops a change in three cases, and says why:

- **No task can see it.** Every changed file is a test, a document, or code a task loads but never runs (`src/autonomy/loop.ts`, `roles.ts`, `subagent.ts`). The record reads "could not be measured", so it is not evidence against the idea.
- **A saving too small to clear the gate.** The gate needs 5% beyond about ±8% run-to-run noise. The twin says how many more tokens per call to cut. Trimming one tool description by 862 characters is 217 tokens a call, 1.2% of the suite; the gate needs about 1,160.
- **Text added to every call, nothing failing to fix.** The proposer names the failing tasks it means to fix in `targetTasks`; a change that only adds text and names none is stopped.

The builder can ask the same model while it works (`world_predict`, free, about a second), so it shortens until the answer is "worth measuring" instead of finding out after a measurement.

**It is scored, so it can be trusted or not.** Every prediction is a belief (a mean and an sd over the log token ratio), committed to a hash-chained receipt ledger (`.elia/world/receipts.jsonl`) *before* measurement and closed with the measured value after. From that ledger the twin reads back its own coefficient and how wide to make its intervals, once it has three scored predictions. A rewritten prediction breaks the chain, and `elia compounding world` says so. It also shows what the twin stopped and roughly what that did not cost. `elia compounding world predict` prices your own uncommitted edits against a base revision (`--base`), which is useful for prompt work whether or not evolve is running.

**Backtest, not a live run.** On generation 13 (a prompt trim), the twin predicts −1.4% tokens from the 265 tokens per call the edit removed; the race measured +0.6%, inside the ±8% noise. It would have stopped that candidate for free. There has been no live `elia evolve` run with the twin in the loop: the provider's free tier ran out before one could start, so the calibration ledger is empty and the coefficient is uncorrected.

### What stands behind a promotion

A change is read the way a reviewer would read it, on the diff, before a model is paid (`src/evolve/quality.ts`). It may not switch a check off (`@ts-ignore`, `oxlint-disable`, a new `any`), leave a debugger in, carry a credential, or grow past 8 files and about 400 lines. A change to logic has to ship a **new** test file beside the code, named after it (`foo.ts` gets `foo.<change>.test.ts`). Existing tests stay immutable, and a new one may not skip, isolate or mock-replace anything. That test must also fail on the live tree (`failToPass.ts`), because a test that passes without the change proves nothing. It must not add lint errors to the files it touches. A promotion writes what stood behind it into the ledger (`proof`: the review, the fail-to-pass result, and what contained the gate).

### Never the expensive part

`src/evolve/budget.ts` puts a ceiling on it: 80M tokens a day (`ELIA_EVOLVE_DAILY_TOKENS`) read back from the ledger so it holds across restarts, and 3.5 sweeps per generation. A generation is refused *before* it starts if it could not be afforded to the end, because a winner that cannot be confirmed is the most expensive thing to lose. `ELIA_EVOLVE_BUDGET=off` removes it, and `ELIA_TWIN=off` skips the screen (the control arm for what it saves).

### Keeping what it proved

With `ELIA_COMPOUND_LAND=on`, a branch promotion is fast-forwarded into the checkout (`src/evolve/landing.ts`), so the next generation builds on it instead of on source that lacks it. It lands only if the gate ran inside elia-box with no run cut short (`ELIA_EVOLVE_BOX=on`), the checkout is exactly where the candidate was cut from, nothing local touches its files, and the tree still type-checks afterwards. If it does not, it is reverted with a new commit, never a reset. It never pushes. It is off by default because writing to a checkout on nobody's say-so is a decision.

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
