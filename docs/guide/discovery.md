# Amplification without distillation

[← Back to the README](../../README.md) · [Recursive intelligence compounding](compounding.md)

The working paper *Amplification Without Distillation* argues that a frozen language model can be amplified far past its standalone ability with no weight updates, and that the limit is **verification**, not the model. That is elia's bet: compounding in the harness, on whatever model it runs, with no fine-tuning. elia builds the paper's reference architecture (which the paper calls a Verified Discovery Engine) into its own modules and measures itself against the theory.

```bash
elia compounding frontier        # frontier, certified library, growth, gate power, isolation, and the governor's plan
elia compounding round           # run the governor's top activity that makes no model calls
elia compounding round --spend   # allow activities that spend model credit (compress, evolve, the critic rung)
elia compounding simulate        # the paper's simulations, reproduced in TypeScript (zero spend)
elia compounding predict         # the paper's predictions P1–P8 and Conjecture 1, with elia's evidence on each
```

`frontier`, `simulate` and `predict` are read-only. `round` acts: it may prove new benchmark tasks, measure the verifier ladder, or audit the lessons. Without `--spend` it calls no model.

The same rounds run by themselves. When the REPL sits idle, elia's practice run is one round of the governor (only when `ELIA_AUTO_IMPROVE=on`; it is off by default). Whatever the governor ranks first and can run, runs: grow the benchmark, build a tool for a repeated habit, audit the library, or run an evolve generation. Practice used to run an evolve generation every time, which spent credit on a comparison the governor already said could not certify a gain.

## What each part of the paper became

| Paper | In elia | What it does |
|---|---|---|
| §3–§8 results | `compounding/theory.ts` | Every formula as a tested function: resampling precision and the frontier, correlated verifier stacks, argmax Goodhart, stepping stones, the error threshold with repair and proofreading, growth regimes, acceptance bars |
| Phase 0: instrumentation | `compounding/frontier.ts` | `p` per task family from `outcomes.jsonl` (each repair is another sample); `α`/`β` from the planted-defect ladder; an on-distribution `α` from completion calibration. A family is placed inside or outside the frontier only when the confidence intervals agree |
| §5 the library | `autonomy/certifiedLibrary.ts` | Artifacts with provenance and a certificate. Each check is tagged with the checker's failure mode, because two checks of one kind count once. Admission at `k` independent passes; quarantine; purges that follow provenance to descendants; a threshold monitor (slip rate `ε`, reuse advantage `σ`, `L*`, rule R2) |
| §5 applied to lessons | `autonomy/lessonCertificates.ts` | Every lesson write path is admitted by one hygiene check (it used to run on one path of four), plus execution evidence where a check really ran. Quarantined lessons are never injected. Certified lessons rank higher in retrieval (Theorem 1's `σ > 1`). A randomized trial that proves a lesson helps certifies it; one that proves it hurts purges it |
| §4 stepping stones | `evolve/archive.ts` | Rejected `evolve` candidates that moved the shown tasks are kept, one elite per niche (MAP-Elites). The proposer can `buildOn` one; only files whose base is unchanged are laid in |
| §6.1 growth | `compounding/growth.ts` | Library elasticity `γ` from the lesson holdout coin, a randomized ablation of library size rather than the paper's confounded over-time regression |
| §6.3 compression | `skills/closure.ts` | Ranks repeated habits by round-trips a tool would save. Refuses to encode shells, interpreters, anything containing `run_command`, script runners (`npm run`, `uv run`, `npx`), package installs, destructive or outward-facing subcommands, and recent dead ends. It also refuses plain editing (`read_file → edit_file → edit_file`): each write depends on what was just read, so a tool would save nothing. Read-only lookups stay encodable because one call can return all of it |
| §7 tool closure | `skills/toolLog.ts`, `skills/synthesize.ts` | Every tool build, success or failure, is logged with its cost and size and certified in the library. `bootstrappingFit` tests Conjecture 1 on the log |
| §7.4 verification first | `reason/probe.ts` | When a searched task has no project tests, a sub-agent writes a probe first. The probe is admitted only if it runs cleanly **and fails on the unchanged tree**. It runs from outside every candidate's worktree, so no attempt can edit its own check |
| §8.1–8.2 valid acceptance | `evolve/acceptance.ts` | The sealed gate: per-task paired differences, an order-invariant anytime-valid e-value, and a lifetime false-acceptance budget (`δ·6/(π²k²)` for the k-th comparison). Recorded on every `evolve` generation; `ELIA_EVOLVE_GATE=sealed` or `both` lets it decide |
| §8.3 isolation | `evolve/isolation.ts` | I1: the sealed gate, the certified library and its auditor, the resource governor, the maths they share, and `src/evolve/history/**` are immutable to candidates. The benchmark runs the candidate's own copy of the task loader, so a candidate that could edit `history/` could hand itself the commit subject the prompt withholds. I2: the proposer reads only its sandbox and the evidence it was shown, and held-out task ids are redacted from the ledger it reads. I3: each generation records a digest of its diff. I4: scores come from code in immutable files |
| §5.3 repair, for tools | `skills/audit.ts` | Re-runs every synthesized skill's test; a tool that stopped passing is purged |
| §10 the resource governor | `compounding/resourceGovernor.ts` | `a* = argmax E[ΔΦ]/cost` over verify, audit, compress, meta, harvest and solve. Starts from rules R1–R4; recorded `ΔΦ` per cost takes over through a bandit. R1 judges the last 60 file-changing turns that touched something a check could read, so prose-only turns don't count and a fix to the gate shows up |
| Algorithm 1 | `compounding/round.ts`, `compounding/runners.ts` | One round: gather the state, rank, run the top activity, re-measure `Φ` from fresh sources, log it. Every activity except solving has a runner. **verify** measures the planted-defect ladder, with the critic rung when it may spend, and skips while the last measurement is under a week old. **harvest** proves new benchmark tasks from elia's history with no model calls. **audit** runs daily, or at once when R2 says the library is at risk. **compress** builds a tool. **meta** runs one evolve generation. Solving is the person's own requests |
| Algorithm 1's outer schedule | `evolve/autoImprove.ts`, `cli/selfImprove.ts` | Idle practice is one governed round. An evolve generation is one of its choices, still promoted to its own branch |
| §8.1 comparison budget, R4 | `evolve/history/harvest.ts` (`growHarvest`) | New tasks go to `.evolution/harvested-tasks.json` in elia's state, never the tracked `tasks.json`, so a background run in a shared checkout changes nothing a person would commit. Commits already tried are never re-proved, and lasting refusals are remembered (timeouts are not). The loader merges the file in, and finds it from inside an evolve sandbox too, so a candidate is measured on the baseline's tasks. Practice focuses on tasks no full run has scored yet |
| §11 simulations | `compounding/sim.ts` | The appendix's four simulations, plus the control §11.4 lacked |
| §12 predictions | `compounding/predictions.ts` | P1–P8 and Conjecture 1, each with the instrument that can test it and what it has recorded |

## Where the paper and elia differ

- **Proofreading depends on correlation.** The paper's `L*` grows as `ln σ / ε^k` with `k` independent checks. Its own Proposition 2 and the correlated-error literature it cites say checks are not independent. `proofreadSlip` takes the correlation `ρ`. At `ρ = 0.5`, two checks lift `L*` from 69 to about 137, not to 6,900.
- **The gain in §11.4 comes from the holdout size, not the gate.** The paper compares naive gating at `n = 500` with the valid gate at `n = 5,000`. The missing control, naive gating at `n = 5,000`, does as well or better on true gain (`elia compounding simulate`, row A'). The valid bar's real job is refusing noise, and it cannot stop tampering. Only isolation can.
- **R1 judges recent, checkable work.** The paper's R1 is about families where a checker can be written. Prose has no fast verifier (§13), so docs-only turns don't trigger it. An all-time share would keep blaming the gate for turns it has since learned to check, so R1 reads the last 60 checkable turns. The all-time number is still printed beside it.
- **`γ` is measured by randomization, not by time.** Regressing success on library size over time mixes in every other change over that time. elia's lesson holdout already randomizes how many lessons each run sees, so it measures `γ` causally.

## What it says about elia today

From elia's own records, as `elia compounding frontier` reported them on 2026-09-23:

- **Recent checkable work is mostly verified.** Of all file-changing turns ever, 34% [26–42%] ran no check. Of the last 60 that touched something a check could read, 17% [9–28%] did, which is under R1's 25% trigger. Most of the all-time gap is static pages from before the render check and docs-only turns.
- **The completion assessor is the weakest verifier measured.** Of 6 runs it called "verified, high confidence", 3 contradict their recorded facts.
- **Lessons don't measurably help.** `γ = 0.25 ± 0.64` over 261 randomized runs. That's indistinguishable from zero, which is rule R3's trigger to compress into tools rather than add text.
- **The benchmark can't certify a gain.** On 59 tasks at 93%, 5 of them added since the last full run, the sealed gate needs at least a 25-point gain and there are 7 points of headroom. Rule R4 says to grow the benchmark before spending on `evolve`, and a round now does that with no model calls.

## What is still open

These parts of the paper aren't built yet, or have never been run on a live model:

- **P1–P3 and P8 are untested.** They need a live model with credit. P2 also needs a labelled judge set: the critic corpus has two defects, too few to estimate `ρ`.
- **Tier 2 of the verifier lattice** (executable world models scored on held-out observations) and **tier 4** (empirical checks that resolve later) have no implementation in elia.
- **`λ` is unmeasured.** It needs a log of tasks sampled at the moving frontier over time.
- **Failure records at the turn level.** The library keeps dead ends for tool builds. A verification failure in an ordinary turn isn't yet a retrievable artifact.
- **Signed tool-call logs (I4).** I4 holds by construction, because nothing a candidate reports is read. No signatures are kept.
