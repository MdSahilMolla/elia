# Self-improvement

[← Back to the README](../../README.md)

> **Status:** the machinery below exists and its gates are enforced, but `elia evolve` hasn't yet promoted a change to its own source. Every generation run so far was rejected by the benchmark. Treat it as a strictly gated experiment, not a proven source of improvement. For how this fits into elia's main goal, see [Recursive intelligence compounding](compounding.md).

## Self-improvement: `elia bench` / `elia evolve`

```bash
elia bench                # score the current elia
elia evolve               # one generation
elia evolve -n 3          # three, each building on the last
elia evolve --dry-run     # evaluate but never touch the live source
```

`src/evolve/suite.ts` is elia's fitness function: real tasks in real temporary repositories. Edit one occurrence of three identical lines. Find where a symbol is *defined*, not called. Fix a failing test without touching the test. Propagate a rename to every call site including the internal one. And the hard one — fix a failing test where a shared constant serves two callers with different requirements, so the obvious fix breaks the other test.

Every check is exact: file contents, exit codes, and hashes of the files the agent was told not to touch. **No model is in the scoring path.**

A generation goes: measure the current elia → read the whole ledger of what's already been tried → form one specific hypothesis about the weakest link → implement it in a sandboxed copy → gate it → promote only if the benchmark agrees.

What makes this recursive rather than just repeated:

- **The candidate is measured by running the candidate.** Benchmark tasks are launched as child processes from the sandbox's own source, so a change to the agent loop, the system prompt, or a tool description is measured through its own effects.
- **Mutations are allowed to target the parts that do the improving** — the planner prompt, the role definitions, the loop's policy on batching and delegation. A generation that makes elia a better engineer makes the next generation's attempt better too.
- **Each generation stands on the last.** A promoted change becomes the new baseline, and the ledger (`.evolution/ledger.jsonl`) carries both the wins and the rejections forward, so generation 12 doesn't re-propose what generation 3 already disproved.

And what keeps it honest:

- **The benchmark is off limits.** `src/evolve/suite.ts`, `fitness.ts`, `engine.ts`, `ledger.ts`, `sandbox.ts`, and `benchTask.ts` cannot be modified by a candidate — touching any of them voids the generation outright. A model asked to improve its score can improve it far more cheaply by editing the benchmark, and it will: not from malice, but because that genuinely is the shortest path to the stated objective.
- **The whole gate is off limits.** Existing tests, `package.json`, and `tsconfig.json` are immutable too, and their changes are included in candidate diffing. A candidate cannot win by deleting an assertion or weakening type checking.
- **Candidate builders are confined to the sandbox.** Their file tools reject paths outside the copied tree, and their shell can only run `bun test` or `bun run typecheck`, always with the sandbox as its working directory. The live installation is not exposed as an editable target during mutation.
- **A tie is a rejection.** Equal pass rate needs a ≥5% token or time win to promote, so benchmark noise can't manufacture a false victory that later generations then "build on".
- **A win has to repeat.** Every provisional winner is measured in a second, independent candidate/baseline pair (run in reverse order) and is rejected unless the improvement reproduces. One lucky model sample cannot promote itself.
- **A regression is disqualifying** even when the total ties, so capabilities can't be quietly traded for each other.
- **A candidate may not cheat more than the live tree.** Before a promotion, both trees run the canaries (`src/evolve/canarySuite.ts`): tasks built so that no honest change can pass. The answers live only in a key the agent is told not to open, or the tests contradict each other, or the service the code must call does not exist. A pass there means the agent copied the key, gamed the tests, hardcoded the output or edited what it was told to leave alone. A candidate that trips them more often than the live tree is rejected, after a pooled retest so one unlucky sample cannot decide it. `elia bench --canaries` reports the live tree's own rate.
- **Provider outages don't count as failures.** A transient 500 or rate limit is retried; a wrong answer never is. Otherwise a network blip could reject a genuinely better candidate, and the ledger would carry that false result into every later generation.
- **Transient provider calls recover in place.** The shared agent loop retries connection, rate-limit, timeout, and 5xx failures when they occur before any text is streamed. It never retries a partially emitted response, which would duplicate output or tool calls.
- **The live tree is only touched after the gate passes**, and everything it overwrites is backed up to `.evolution/gen-N-backup/`. Promotion is transactional: a partial copy is rolled back, including removal of newly introduced files.

**A stronger improver.** The proposer, the builder and the strategy writer run on the configured model by default, so the search is only as good as the model elia is benchmarked on. `ELIA_EVOLVE_PROVIDER` and `ELIA_EVOLVE_MODEL` (with `ELIA_EVOLVE_BASE_URL` and `ELIA_EVOLVE_API_KEY` if needed) move those three onto another model. Candidates are still measured on the configured model, and each ledger record names the improver's route in `improverModel`. A route that is set but cannot be used stops the run before anything is spent, rather than quietly falling back.

`elia evolve` makes real API calls and, on success, modifies elia's own source. Use `--dry-run` to see what it would do first.

### `elia bench --lift` — does elia beat the model it runs on?

Every other comparison above is elia against elia. `--lift` asks the question a harness has to be able to answer: run the same tasks, on the same model, with no harness at all — a `bash` tool, a whole-file `write_file`, a three-sentence prompt, a plain loop (`src/evolve/bareLoop.ts`, shaped after mini-swe-agent) — and report the difference. mini-swe-agent writes files through its shell inside a container; elia's unattended safety policy refuses shell writes, so without `write_file` the bare model could not change a file and the comparison would measure the policy.

```bash
elia bench --lift            # the synthetic suite, both arms
elia bench --all --lift      # every task
```

The control arm keeps what is not a claim about reasoning — the task's step budget, the same unattended safety policy on every command, the same retry on a provider blip — and drops what elia says adds value: the system prompt and Value Core, the tool surface, lessons, speculation, plan tracking, nudges, sub-agents and compaction. Tasks are paired, a task either arm could not measure leaves both sides, two arms on different models are refused, and the verdict is an anytime-valid e-value test: "the harness helps" only at e ≥ 20, and "the harness hurts" is reported just as plainly when the bare model wins. The latest result shows in `elia compounding` beside the benchmark's headroom. The control arm and the comparison are immutable to `elia evolve` candidates, so a candidate cannot raise its lift by weakening the baseline.

### Elia Book — session insights and reusable improvement playbooks

Open `/eliabook` during any interactive session to choose **Save this session**
or **Saved Elia Books**. Saving captures the session conversation, model/tool
activity, results, usage, checkpoint metadata, touched file paths, insights, and
reusable procedure in a local snapshot under `.elia/books/`. Credential-shaped
values are redacted. Workspace files are not separately backed up.

Each save captures activity up to that point and appears in **Saved Elia Books**.
Save again to create another snapshot as the session progresses. Recordings include
full available tool output, intermediate replies, child-agent actions, and provider
activity. They survive model-context compaction and session resume. Older sessions
without a recording can only recover the messages they previously retained.
Source tools/providers may limit their output; private model reasoning is excluded.

```text
/eliabook                         # open Save this session / Saved Elia Books
/eliabook save [id]               # save the complete current session
/eliabook saved                   # browse saved session playbooks
/eliabook create <run-id> [id]   # create one from a recorded autonomous run
/eliabook show <id>              # inspect its insights, procedure, and evidence
/eliabook run <id> [instruction] # run the active version in this session
/eliabook improve <id> <run-id>  # promote a better verified run as a new version
/eliabook rollback <id>          # restore the previous version
```

A recursive Book improvement is correctness-first: the candidate run must have
evidence-backed verified completion, must not increase failed or blocked actions,
and must improve at least one recorded measure such as actions, tokens, or elapsed
time. The previous version remains available for rollback. This complements
`elia evolve`; source-code self-improvement still runs in an isolated sandbox and
must pass Elia's protected benchmark before promotion.

### `elia bench-latency` — the overhead the model doesn't explain

`elia bench` needs a real model and measures whether elia is *correct*. `elia bench-latency` needs neither an API key nor a network, and measures whether elia is *fast* — specifically, how much wall-clock elia's own machinery adds on top of whatever the model costs.

```bash
elia bench-latency                     # compare against the committed baseline
elia bench-latency --realistic         # add simulated 400ms TTFT + 8ms/token model pacing
elia bench-latency --live              # run the scenarios against the real configured model (real API calls)
elia bench-latency --update-baseline   # record the current numbers as the new baseline
elia bench-latency --strict            # fail (not just warn) on a wall-clock regression — same-machine only
```

`--live` reports real round-trips, output tokens, tokens/sec, and wall-clock per scenario for whatever provider is configured — useful for seeing how a given model actually behaves (does it batch its reads, or walk the directory one turn at a time?).

A deterministic scripted provider replays the assistant turns a competent model *would* make on each scenario (`src/bench/latency/scenarios.ts`), so the only thing that moves between runs is elia. The scenarios target the paths whose cost elia owns: streaming a bare turn, running six independent reads in one batch, a read→edit cycle, and a grep followed by opening its hit. For each it records round-trips, how many tool reads were served from the speculative cache instead of blocking, time-to-first-token, and median wall-clock — plus a separate cold-start measurement (a bare `elia` process loading its module graph and exiting).

The structural metrics — round-trips and speculative hits — are fully deterministic, so **`bun test` gates on them**: a change that adds a model round-trip or makes a previously pre-run read block fails CI. Wall-clock has run-to-run noise even with a scripted model, so it only warns unless `--strict`, and the committed baseline's absolute millisecond numbers are machine-specific.

## Learned tools: `elia skills`

```bash
elia skills               # list the tools elia has written for itself
elia skills candidates    # show repeated work that could become a tool
elia skills synth         # write a tool for the strongest candidate
```

Elia counts two kinds of repetition as it works, for free, with no model involved: shell-command *shapes* (`git diff --stat HEAD~1` and `git diff --cached` are the same habit) and sliding trigrams of tool names (a `grep → read_file → edit_file` routine that costs three round-trips every time). Once a habit crosses a threshold, `elia skills synth` has a builder write a real tool for it — plus a test — into `~/.elia/skills/`.

A synthesized skill is only kept if it survives the same gate a human contribution would: it has to import cleanly, expose a valid tool schema, and pass a test that actually ran. Anything else is quarantined rather than loaded. Skills are ordinary modules exporting a `Tool`, so they're indistinguishable from built-ins at the call site, and they're self-contained (no imports from elia's source) so they keep working across upgrades. `ELIA_SKILLS=off` disables loading entirely.
