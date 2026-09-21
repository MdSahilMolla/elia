# The Verified Discovery Engine

[← Back to the README](../../README.md) · [Recursive intelligence compounding](compounding.md)

The working paper *Amplification Without Distillation* argues that a frozen language model can be amplified far past its standalone ability with no weight updates, and that the limit is **verification**, not the model. That is elia's bet: compounding in the harness, on whatever model it runs, with no fine-tuning. `src/vde/` builds the paper's reference architecture into elia and measures elia against its theory.

```bash
elia vde                  # frontier, certified library, growth, gate power, isolation, and the governor's plan
elia vde round            # run the governor's top free activity (the audit)
elia vde round --spend    # allow activities that spend model credit (compress, evolve)
elia vde simulate         # the paper's simulations, reproduced in TypeScript (zero spend)
elia vde predict          # the paper's predictions P1–P8 and Conjecture 1, with elia's evidence on each
```

Everything except `round --spend` is read-only and spends nothing.

## What each part of the paper became

| Paper | In elia | What it does |
|---|---|---|
| §3–§8 results | `vde/theory.ts` | Every formula as a tested function: resampling precision and the frontier, correlated verifier stacks, argmax Goodhart, stepping stones, the error threshold with repair and proofreading, growth regimes, acceptance bars |
| Phase 0: instrumentation | `vde/frontier.ts` | `p` per task family from `outcomes.jsonl` (each repair is another sample); `α`/`β` from the planted-defect ladder; an on-distribution `α` from completion calibration. A family is placed inside or outside the frontier only when the confidence intervals agree |
| §5 the library | `vde/library.ts` | Artifacts with provenance and a certificate. Each check is tagged with the checker's failure mode, because two checks of one kind count once. Admission at `k` independent passes; quarantine; purges that follow provenance to descendants; a threshold monitor (slip rate `ε`, reuse advantage `σ`, `L*`, rule R2) |
| §5 applied to lessons | `vde/lessonCertificates.ts` | Every lesson write path is admitted by one hygiene check (it used to run on one path of four), plus execution evidence where a check really ran. Quarantined lessons are never injected. Certified lessons rank higher in retrieval (Theorem 1's `σ > 1`). A randomized trial that proves a lesson helps certifies it; one that proves it hurts purges it |
| §4 stepping stones | `vde/archive.ts` | Rejected `evolve` candidates that moved the shown tasks are kept, one elite per niche (MAP-Elites). The proposer can `buildOn` one; only files whose base is unchanged are laid in |
| §6.1 growth | `vde/growth.ts` | Library elasticity `γ` from the lesson holdout coin, a randomized ablation of library size rather than the paper's confounded over-time regression |
| §6.3 compression | `vde/closure.ts` | Ranks repeated habits by round-trips a tool would save. Refuses to encode shells, interpreters, anything containing `run_command`, destructive or outward-facing subcommands, and recent dead ends |
| §7 tool closure | `vde/toolLog.ts`, `skills/synthesize.ts` | Every tool build, success or failure, is logged with its cost and size and certified in the library. `bootstrappingFit` tests Conjecture 1 on the log |
| §7.4 verification first | `vde/probe.ts` | When a searched task has no project tests, a sub-agent writes a probe first. The probe is admitted only if it runs cleanly **and fails on the unchanged tree**. It runs from outside every candidate's worktree, so no attempt can edit its own check |
| §8.1–8.2 valid acceptance | `vde/acceptance.ts` | The sealed gate: per-task paired differences, an order-invariant anytime-valid e-value, and a lifetime false-acceptance budget (`δ·6/(π²k²)` for the k-th comparison). Recorded on every `evolve` generation; `ELIA_EVOLVE_GATE=sealed` or `both` lets it decide |
| §8.3 isolation | `vde/isolation.ts` | I1: `src/vde/**` is immutable to candidates. I2: the proposer reads only its sandbox and the evidence it was shown, and held-out task ids are redacted from the ledger it reads. I3: each generation records a digest of its diff. I4: scores come from code in immutable files |
| §5.3 repair, for tools | `vde/audit.ts` | Re-runs every synthesized skill's test; a tool that stopped passing is purged |
| §10 the resource governor | `vde/governor.ts` | `a* = argmax E[ΔΦ]/cost` over verify, audit, compress, meta, harvest and solve. Starts from rules R1–R4; recorded `ΔΦ` per cost takes over through a bandit |
| Algorithm 1 | `vde/round.ts` | One round: gather the state, rank, run the top activity, re-measure `Φ`, log it |
| §11 simulations | `vde/sim.ts` | The appendix's four simulations, plus the control §11.4 lacked |
| §12 predictions | `vde/predictions.ts` | P1–P8 and Conjecture 1, each with the instrument that can test it and what it has recorded |

## Where the paper and elia differ

- **Proofreading depends on correlation.** The paper's `L*` grows as `ln σ / ε^k` with `k` independent checks. Its own Proposition 2 and the correlated-error literature it cites say checks are not independent. `proofreadSlip` takes the correlation `ρ`. At `ρ = 0.5`, two checks lift `L*` from 69 to about 137, not to 6,900.
- **The gain in §11.4 comes from the holdout size, not the gate.** The paper compares naive gating at `n = 500` with the valid gate at `n = 5,000`. The missing control, naive gating at `n = 5,000`, does as well or better on true gain (`elia vde simulate`, row A'). The valid bar's real job is refusing noise, and it cannot stop tampering. Only isolation can.
- **`γ` is measured by randomization, not by time.** Regressing success on library size over time mixes in every other change over that time. elia's lesson holdout already randomizes how many lessons each run sees, so it measures `γ` causally.

## What it says about elia today

From elia's own records, as `elia vde` reported them on 2026-09-22:

- **A third of the work has no verifier.** 34% [26–42%] of file-changing turns ran no check. For those turns `α` is effectively 1, so they sit outside every frontier. Rule R1 puts verifier work first.
- **The completion assessor is the weakest verifier measured.** Of 6 runs it called "verified, high confidence", 3 contradict their recorded facts.
- **Lessons don't measurably help.** `γ = 0.25 ± 0.64` over 261 randomized runs. That's indistinguishable from zero, which is rule R3's trigger to compress into tools rather than add text.
- **The benchmark can't certify a gain.** On 54 tasks at 93%, the sealed gate needs at least a 17-point gain and there are 7 points of headroom. Rule R4 says to grow the benchmark before spending on `evolve`.
