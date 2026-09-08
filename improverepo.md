# Elia Performance & Reliability Plan (v3 — grounded & actionable)

> **Revision history.**
> *v1* — an ungrounded 18‑item, 17–24 week roadmap. Rebuilt subsystems that
> already exist, quoted impact numbers with no way to measure them, and several
> items contradicted deliberate design decisions.
> *v2* — reality‑checked against `src/`; cut to 6 items with day‑level estimates.
> *v3* — every item now carries exact `file:line` anchors, an API sketch,
> acceptance criteria wired to the real latency harness fields, a rollback, and a
> one‑command validation. Claims verified against the code are marked ✔.

---

## 0. Status — all 8 items shipped (branch `production`)

| # | Item | Commit | Notes on what actually shipped |
|---|---|---|---|
| 3.0 | Settle uncommitted micro‑opts | `improverepo 3.0` | Reverted the cache‑key builder (proven collision); kept the brain parallel load, dropped its mtime TTL; kept the grep regex cache + EOF‑context regression test. |
| 3.6 | Per‑tool profiler timing | `improverepo 3.6` | `recordToolCall` / `toolProfileReport` / `renderToolProfile` in `profile.ts`, fed from the loop's `onTool`. Verified end‑to‑end via the harness. |
| 3.1 | Bounded cache registry | `improverepo 3.1` | `src/cacheRegistry.ts` (`boundedMap`, `registerCache`, `clearAllCaches`); speculation cache capped at 512 with `size`/`evictions` stats; grep + brain registered; `restoreCheckpoint` clears all. Bound unit‑tested (600 → 512, 88 evictions) rather than a pathological scenario. |
| 3.3 | CPU‑derived tool concurrency | `improverepo 3.3` | `DEFAULT_PARALLEL_TOOLS = clamp(cores‑1, 4, 8)`; `MAX_PARALLEL_WRITE_TOOLS` stays a literal 4. |
| 3.4 | Windowed reads for >5 MB files | `improverepo 3.4` | Streamed line window, ≤512 KB / 2000 lines; bare read still refused. `src/tools/readFile.test.ts`. |
| 3.5 | Widen prefetch heuristics | `improverepo 3.5` | Test⇄source pairing (JS/TS + Python). Verified `PATH_PATTERN` already catches framed stack traces — the real gap was that **errored** `run_command` output was never observed; now it is (path extraction only). |
| 3.2 | Cross‑turn read memoization | `improverepo 3.2` | `src/speculation/deterministicCache.ts`, `read_file` only, `mtime:size` stamp + per‑path flush on edits + wholesale clear on opaque mutation. `ELIA_NO_READ_MEMO=1` kill‑switch. Stale‑read matrix + full‑loop integration test. |
| 3.7 | Auto‑lesson on repeated repair failure | `improverepo 3.7` | `repeatedFailureLesson()` turns `assessProgress().repeated` into one `[auto]`‑tagged durable lesson, recorded before the model pass at both unresolved exits. |

Whole suite green throughout (1341 tests); `bench-latency --strict` reports **no
regressions** at every step. The latency `baseline.json` was left untouched — the
structural invariants (the real gate) never moved and the wall‑clock numbers are
machine‑specific.

**Decisions taken on the §8 open questions:** (1) grep/`list_files` memoization
was **cut** — no cheap correct stamp; `read_file` only. (2) Evicting an in‑flight
speculation is left as‑is (safe, wastes the work). (3) Signature normalization
reuses the existing `errorSignature()` (paths/numbers/hashes already stripped).

**Not done / deferred, unchanged from below:** everything in §7 Non‑goals, plus
3.2 for `list_files`/`grep`, a `list_files` sibling stamp, and a subagent worker
pool.

---

## 1. Reality check — what Elia already has

New work builds on this or it does not land.

| Capability | Where | Verified detail |
|---|---|---|
| Speculative read execution | `src/speculation/cache.ts`, `prefetch.ts` | ✔ Prefetches grep hits + relative imports while the model streams. Caps: 10/round, 80/loop, 256 KB/file (`prefetch.ts:32‑35`). Mutating batch ⇒ `cache.invalidate()` (`agentLoop.ts:460`). `take()` deletes the entry (single‑use). |
| Mid‑stream tool dispatch | `agentLoop.ts:399` (`cache?.take`), `:648‑654` (`cache.speculate` during codex delegation) | ✔ Real call at `:399` consumes a speculated result or falls through to `tool.execute`. |
| Per‑turn profiling | `src/profile.ts` — `ELIA_PROFILE=1` / `--profile-turns` (`index.ts:301`) | ✔ Records wall, TTFT, exact cache‑read/write/fresh split, prefix‑cache misses per **model** call. No per‑**tool** timing yet. Cheap early return when off (`profile.ts:64`). |
| Latency regression harness | `src/bench/latency/` — `elia bench-latency` (`index.ts:647`) | ✔ 4 deterministic scripted‑provider scenarios, `baseline.json`, `--strict` gate, `--live`, `--realistic` pacing. Structural invariants (`roundTrips` / `toolCalls` / `cachedToolCalls`) are gated hard; wall‑clock is advisory. **This is the measurement tool for every item below.** |
| Scored task benchmark | `src/bench/` — `elia bench` | ✔ Pass‑rate scorecard; drives `elia evolve` promotion. |
| Provider retry / backoff | `agentLoop.ts:519` (`for attempt`), `:566‑567` (`Bun.sleep(250 * 2**(attempt-1))`) | ✔ SDK `maxRetries: 0` (`providers/anthropic.ts:28`, `openaiCompatible.ts:20`) is deliberate — the loop owns retry so streamed output isn't duplicated. |
| Adaptive tool concurrency | `agentLoop.ts:27‑28` (`MAX_PARALLEL_TOOLS=4`, `MAX_SAFE_PARALLEL_TOOLS=8`), `:726‑728` | ✔ Read‑only batch ⇒ up to 8; any write ⇒ 4. `configured` value clamped to 8. |
| Fleet concurrency | `autonomy/fleet.ts:139‑147` (`runWithConcurrencyLimit`) | ✔ Per‑provider sizing. |
| Action governor / budgets | `autonomy/governor.ts:336` | ✔ Action‑count budget, policy gate, `blockedByBudget` accounting. |
| Brain store caching | `src/brain/store.ts` | ✔ Fingerprint cache + (uncommitted) mtime TTL map + parallel `Promise.all` session load. |
| Bounded file / search I/O | `tools/readFile.ts:6` (5 MB hard throw), `grep.ts` (5 MB/file, `MAX_MATCHES`) | ✔ Limits, not streaming — intentional (multi‑MB text is useless in a context window). |
| Re‑read nudge | `agentLoop.ts:468` (`redundantReads.observe`) | ✔ Already tells the model to stop re‑reading files. Memoization (3.2) covers the case where it re‑reads anyway or the repair loop does. |
| Failure memory | `autonomy/lessons.ts`, `rationale.ts`, `calibration.ts` | ✔ Retrieval + confidence weighting exist. Gap: no *automatic* capture on repeated repair failure. |

---

## 2. Disposition of the v1 roadmap

| v1 item | Verdict | Reason (verified) |
|---|---|---|
| 1.1 Unified memory pool / pressure eviction | **Keep — scoped to a bounded‑cache registry** | Real: `speculation/cache.ts` `entries` map, `brain/store.ts` `mtimeCache`, `grep.ts` `regexCache` all grow unbounded (regex cache has a 100 cap; the other two don't). Worth one shared LRU + one `clearAll`. A "100 MB global budget with graceful degradation" is not. |
| 1.2 Streaming file operations | **Redefine** | `read_file` refuses >5 MB *by design* (`readFile.ts:32`). Streaming 5 MB into the model is wrong. Real gap: no way to *window* into an over‑limit file. → 3.4. |
| 1.3 Connection pooling + backoff | **Already done** | Bun `fetch` keep‑alives by default; loop backoff at `agentLoop.ts:566`. No work. |
| 2.1 Dynamic concurrency (CPU/mem aware) | **Keep — small** | `MAX_PARALLEL_TOOLS` is a literal `4` (`agentLoop.ts:27`). A `os.availableParallelism()`‑derived default is cheap. Load‑adaptive scaling isn't worth it for one user. → 3.3. |
| 2.2 Parallel typecheck / lint / test | **Drop** | `verify.ts:15‑23` is sequential fail‑fast *on purpose* ("a typecheck failure makes the test output noise rather than information"). **There is also no lint script** — `package.json` has none, no eslint/biome config exists. |
| 2.3 Worker pool for subagents | **Defer** | Not a measured bottleneck. Revisit only if `bench-latency --live` shows fleet spin‑up dominating. |
| 3.1 L1/L2/L3 cache hierarchy | **Partial** | An L2 (in‑process, cross‑turn) memoization of deterministic reads is worth it → 3.2. "L3 network cache coordination for distributed setups" — Elia isn't distributed. Out. |
| 3.2 ML‑based prefetching | **Drop — widen heuristics instead** | `prefetch.ts:7‑16` explicitly rejects model‑driven prediction ("an extra LLM round‑trip would cost more latency than the reads it saves"). A learned model needs training + telemetry infra for a heuristic that already hits 6/6 and 2/2 in the harness scenarios. → 3.5 widens the *rules*. |
| 3.3 Result memoization for deterministic reads | **Keep** | Genuine in repair/debug loops re‑reading unchanged files across turns. → 3.2. |
| 4.1 Genetic‑algorithm prompt evolution | **Drop** | `elia evolve` already does benchmark‑gated promotion. GA search over prompts is a research project with unbounded risk. |
| 4.2 Enhanced learning from failures | **Mostly built** | One real gap: auto‑capture a lesson when a repair loop fails twice on the same gate. → 3.7. |
| 4.3 Performance profiling system | **Keep — extend `profile.ts`, don't build `src/performance/`** | Add per‑tool timing to the existing profiler. → 3.6. |
| 5.1 Advanced checkpoints | **Drop for now** | `checkpoint.ts` is git‑based; no measurement says it's slow. |
| 5.2 Robust error recovery (multi‑strategy) | **Defer** | `stuck.ts` + `replan.ts` exist and were hardened recently. Needs a specific reproduced failure mode first. |
| 5.3 Per‑action CPU/mem/disk limits | **Drop** | Action‑count budget exists; OS‑level per‑action sandboxing is heavy and low‑upside for a local tool. |
| 6.1 Comprehensive telemetry | **Drop** | `usage.ts` + `profile.ts` cover a local CLI. |
| 6.2 Distributed tracing / OpenTelemetry | **Drop** | Nothing distributed to trace. |
| 6.3 Signed / tamper‑evident audit logs | **Drop** | `audit.ts` exists; signing local logs on a single‑user machine is theatre. |

Net: **6 kept**, 3 already done, 9 dropped/deferred.

---

## 3. The plan

Ordered by (payoff ÷ risk). Every item: land a commit that also updates
`src/bench/latency/baseline.json`, and add a scenario if it claims a speedup.
Nothing merges that regresses `bench-latency --strict` or drops `bench` pass‑rate.

Legend: **A/C** = acceptance criteria · **V** = one‑command validation · **R** = rollback.

---

### 3.0 — Cleanup: settle the uncommitted micro‑optimizations · 0.5 d

Three uncommitted perf edits are in the tree (v1's "recently implemented" list).
Land them deliberately.

**`src/brain/store.ts`** — mtime TTL cache + `Promise.all` session load. **Keep.**
`resetBrainCache()` clears both (`store.ts:188`). The parallel load is the real
win; the 1 s mtime TTL is marginal and adds a staleness window. *Recommended:*
drop `MTIME_CACHE_TTL_MS` to `0` (or delete the map) and keep only the parallel
load — or keep the TTL and add a test that a ledger written inside the window is
still seen on the next `loadBrainItems` (fingerprint is recomputed each call).

**`src/tools/grep.ts`** — regex LRU (100) + tighter match loop. **Keep.** The
`MAX_MATCHES` check moved *before* emission (`grep.ts:210`). Add one test: "regex
match on the last line of a file, `context > 0`" — confirm the trailing context
group still emits and the `--` separator logic is unaffected.

**`src/speculation/cache.ts`** — hand‑rolled key builder replacing
`JSON.stringify` (`cache.ts:47‑63`). **Revert.** Verified collision: with the new
builder,

```
key('grep', { pattern: 'x', path: 'y' })      → "grep?path=y&pattern=x"
key('grep', { path: 'y&pattern=x' })          → "grep?path=y&pattern=x"   // same!
```

because keys/values aren't escaped before the `&`/`=` join. `null` and
`undefined` also now collide. `JSON.stringify` had neither problem. The
speculation cache returning the wrong file's contents to the model is a
correctness bug that dwarfs the ~microseconds saved, and this was never a
measured hotspot. Revert to the original three lines; if key‑gen ever shows up in
a profile, revisit with a *escaped* encoder.

- **A/C:** working tree clean; `bun test src/` green; `elia bench-latency` shows no
  structural change (this is hygiene, not a speedup).
- **V:** `bun test src/speculation/ src/brain/ src/tools/ && bun run typecheck`
- **R:** `git revert` the single commit.

---

### 3.6 — Per‑tool timing in the profiler · 2 d  *(done early on purpose)*

**Why first:** it produces the real per‑tool numbers that justify or kill 3.2 and
3.5. Measurement before optimization.

**Files:** `src/profile.ts`, `src/agentLoop.ts:162‑165` (the internal `onTool`).

**Sketch:**
```ts
// profile.ts
export interface ToolCallSample {
  name: string; actor: string; wallMs: number; bytesOut: number
  cached: boolean; isError: boolean
}
export function recordToolCall(s: ToolCallSample): void { if (!profilingEnabled()) return; toolSamples.push(s) }
// renderProfileReport(): append a per-tool table — count, p50/p90 wall, total ms, cache-hit %, error %
```
```ts
// agentLoop.ts, inside the existing onTool wrapper (:162)
const onTool = (event: ToolEvent): void => {
  transcript?.recordTool(event, actor)
  recordToolCall({ name: event.name, actor, wallMs: event.durationMs,
                   bytesOut: event.result.length, cached: event.cached, isError: event.isError })
  toolListener?.(event)
}
```
`event.durationMs`, `event.cached`, `event.isError` already exist on `ToolEvent`
(`agentLoop.ts:50‑60`).

- **A/C:** `ELIA_PROFILE=1 elia "…"` prints a per‑tool table under the existing
  model‑call table; `profile.ts` off ⇒ still a one‑line early return;
  `profile.test.ts` covers the new aggregation (p50/p90, cache‑hit %).
- **V:** `bun test src/profile.test.ts && ELIA_PROFILE=1 bun run bin/elia.ts agent "read src/index.ts and summarise it"`
- **R:** revert; feature is inert when `ELIA_PROFILE` unset.

---

### 3.1 — Bounded cache registry · 2 d

**Files:** new `src/cacheRegistry.ts`; wire `speculation/cache.ts:44`,
`brain/store.ts:86`, `tools/grep.ts:regexCache`.

**Sketch:**
```ts
// cacheRegistry.ts
export function boundedMap<K, V>(maxEntries: number): Map<K, V>  // insertion-order LRU on set()
export function registerCache(name: string, clear: () => void): void
export function clearAllCaches(): void   // used by tests + /rewind + repo checkpoint restore
```
Replace the three ad‑hoc maps with `boundedMap`. `speculation/cache.ts` `entries`
gets a cap (e.g. 512) — on eviction, `void entry.catch(() => {})` is already
attached (`cache.ts:82`) so dropping a pending promise is safe. Extend
`CacheStats` with `size` and `evictions`. No global byte budget, no pressure
monitor.

- **A/C:** new latency scenario `cache-bound` — 600 distinct speculated reads in
  one loop; assert `cacheStats.size <= cap` and `evictions > 0`, and that a
  *hot* re‑read within the window is still a `cachedToolCalls` hit; peak RSS in
  the harness not worse than baseline.
- **V:** `elia bench-latency --only cache-bound` + `bun test src/speculation/ src/brain/`
- **R:** revert; maps go back to unbounded (current behaviour, safe under today's caps).

---

### 3.3 — CPU‑derived default tool concurrency · 1 d

**Files:** `src/agentLoop.ts:27`, `:726‑728`.

**Change:** `MAX_PARALLEL_TOOLS` default becomes
`Math.max(2, Math.min(8, (os.availableParallelism?.() ?? 4) - 1))`.
Explicit config still wins (`:726` already `Math.min(configured, MAX_SAFE_PARALLEL_TOOLS)`).
`MAX_SAFE_PARALLEL_TOOLS` stays `8`. The "any write ⇒ 4" rule (`:728`) is
**unchanged** — keep it a literal `4`, not the derived value, so write batches
stay conservative.

- **A/C:** `parallel-reads` scenario (6 reads, `expect.cachedToolCalls: 6`) still
  passes structurally; on an ≥8‑core CI runner, `wallMsMedian` for a *non‑cached*
  6‑read batch improves vs the fixed‑4 baseline; on a 4‑core box, no change.
- **V:** `elia bench-latency --only parallel-reads --realistic`
- **R:** one‑line revert to `= 4`.

---

### 3.4 — Windowed read for over‑limit files · 1 d

**Files:** `src/tools/readFile.ts:32`.

**Change:** if `file.size > MAX_READ_BYTES` **and** the call passes `offset`+`limit`,
serve that window (bounded to `min(limit, 2000)` lines and 256 KB of text) with a
header line stating total bytes/lines. A bare read of an over‑limit file still
throws, now with a message that names the offset/limit escape hatch. Update the
tool `description` so the model knows.

- **A/C:** unit tests — bare read of a 6 MB file throws with the new guidance;
  `offset`/`limit` read of the same file returns exactly that slice with the
  size header; window is clamped. New scenario `big-file-window` reading a slice
  of a generated 8 MB file (`expect.toolCalls: 1`).
- **V:** `bun test src/tools/readFile` *(add `readFile.test.ts`)*
- **R:** revert; back to unconditional throw.

---

### 3.5 — Widen prefetch heuristics · 2 d

**Files:** `src/speculation/prefetch.ts` (`observe` at `:80`, `extractPaths` `:105`).

**Two grounded edges, no ML:**
1. **Test ⇄ source pairing** — a `read_file` of `foo.ts` also schedules
   `foo.test.ts` / `foo.spec.ts` (and the reverse), respecting existing
   `isSpeculativelyReadable` + caps.
2. **Framed stack‑trace paths** — `PATH_PATTERN` (`:22`) catches bare paths but
   not `at fn (src/x.ts:42:9)` / `src/x.ts:42:9` frames common in vitest/pytest
   failure output. Add a `FRAME_PATTERN`, strip `:line:col`, and push those with
   priority (they're what the model inspects next after a failing test).

All existing caps unchanged; a wrong guess still costs one <256 KB read.

- **A/C:** new prefetch unit tests with real vitest + pytest failure‑output
  fixtures; scenario `debug-failing-test` (grep/read a test, "run" it via scripted
  failure, open the framed source) shows `cachedToolCalls / toolCalls` up vs
  baseline; `grep-chain` still 2/2.
- **V:** `bun test src/speculation/prefetch.test.ts && elia bench-latency --only debug-failing-test`
- **R:** revert the two edges; core heuristics untouched.

---

### 3.2 — Cross‑turn memoization of deterministic reads (L2) · 3 d

**Files:** new `src/speculation/deterministicCache.ts`; wire
`agentLoop.ts:399` (consume), `:407‑409` (populate after a real
`read_file`/`list_files`/`grep`), `:460` (targeted flush on mutation);
`runAgentLoop` opts (`agentLoop.ts:~106`) + `bench/latency/harness.ts:109‑133`
(thread it through the scenario runner).

**Difference from the speculation cache:** the speculation cache is single‑use
(`take()` deletes) and wholesale‑flushed on any mutation (`:460`). This one
**survives across turns**, is keyed by content identity, and is flushed
**per‑path** on writes to that path.

**Sketch:**
```ts
interface DetKey { name: 'read_file'|'list_files'|'grep'; input: Record<string,unknown>; stamp: string }
// stamp = `${mtimeMs}:${size}` of the target file (read_file/list_files dir),
// or of every file the grep touched — if any stamp changes, entry is stale.
get(name, input): string | undefined          // returns cached result iff stamps still match
put(name, input, result, stampNow): void
invalidatePath(path): void                     // called for each edit_file/write_file target
```
At `:399`: `const memo = batchMutates ? undefined : detCache.get(block.name, block.input)`
tried *after* the speculation `cache.take` miss. At `:460`: instead of only
`cache?.invalidate()`, also `for (const p of mutatedPaths) detCache.invalidatePath(p)`.
Env opt‑out `ELIA_NO_READ_MEMO=1`.

- **A/C:** scenario `repair-loop` — read A, read B, scripted verification failure,
  re‑read A + B, edit A, re‑read B. Assert: the re‑reads of unchanged files land
  as `cachedToolCalls`; after the edit, re‑read of **A** is a real call
  (stamp changed) while **B** is still cached; `wallMsMedian` down.
  **Stale‑read matrix** (unit): file changed on disk by a shell command between
  reads ⇒ next read is a real call, not the stale entry.
- **V:** `elia bench-latency --only repair-loop && bun test src/speculation/deterministicCache.test.ts`
- **R:** revert; `ELIA_NO_READ_MEMO=1` disables it in the field meanwhile.
- **Risk:** Medium — a stale read handed to the model is a correctness bug.
  Mitigations: `mtime+size` stamp (not mtime alone), per‑path flush on the write
  path, the stale‑read test matrix, and the env kill‑switch.

---

### 3.7 — Auto‑capture a lesson on repeated repair failure · 2 d

**Files:** `src/autonomy/lessons.ts`, the repair path around
`src/autonomy/replan.ts` / the autonomous loop's verification‑retry.

**Change:** when a repair attempt fails verification **twice on the same gate**
with a similar error signature (normalize: gate command + top error line +
failure class), write a structured lesson automatically — `{ gate, errorClass,
triedSummary, signature }` — deduped against existing lessons by `signature`,
capped at N auto‑lessons per run. Today this depends on the model choosing to
remember.

- **A/C:** a `bench` autonomous scenario that currently loops on one failure ends
  with ≥1 auto‑lesson; a second run on the same task retrieves it and skips the
  dead approach (fewer round trips, visible in the scorecard's step count).
  Auto‑lessons never exceed the per‑run cap; identical signatures dedupe.
- **V:** `bun test src/autonomy/lessons.test.ts` + targeted `elia bench --only <scenario>`
- **R:** revert; manual lesson capture unaffected.
- **Risk:** Medium — noisy auto‑lessons pollute retrieval. Mitigations: the
  two‑failure threshold, signature dedupe, per‑run cap, and tagging them
  `source: auto` so retrieval can down‑weight if needed.

---

## 4. Sequencing & effort

| # | Item | Days | Gate to proceed |
|---|---|---|---|
| 1 | 3.0 Cleanup (revert cache key, land grep/brain) | 0.5 | tree clean, `bench-latency` flat |
| 2 | 3.6 Per‑tool profiler timing | 2 | table renders, `profile.test.ts` green |
| 3 | 3.1 Bounded cache registry | 2 | caps enforced, RSS not worse |
| 4 | 3.3 CPU concurrency default | 1 | multicore scenario faster, 4‑core flat |
| 5 | 3.4 Windowed reads | 1 | `readFile.test.ts` green |
| 6 | 3.5 Prefetch heuristics | 2 | cache‑hit ratio up in `debug-failing-test` |
| 7 | 3.2 Cross‑turn read memoization | 3 | stale‑read matrix green |
| 8 | 3.7 Auto‑lessons on repeat failure | 2 | repeated‑failure scenario improves |

**Total ≈ 13.5 engineering days** (~3 weeks with review), vs v1's 17–24 weeks.

---

## 5. Measurement discipline

- Each item's commit updates `src/bench/latency/baseline.json` and adds its
  scenario in the same change.
- CI runs `elia bench-latency --strict`; a structural regression fails the build.
- Commit messages cite `ELIA_PROFILE` / `bench-latency --live` output — **not**
  estimates. If it can't be measured, it isn't claimed.
- `elia bench` pass‑rate must not drop.
- Honest expectation: model time dominates a turn, so tool‑phase wins are
  single‑digit‑% end‑to‑end. They compound over long autonomous runs — that's the
  case for doing them, stated plainly rather than inflated to "40–60%".

---

## 6. Definition of done (per item)

1. `file:line` insertion points from §3 implemented, no TODOs.
2. Unit tests for the new logic + the failure/edge cases named in **A/C**.
3. New latency scenario added; `baseline.json` regenerated in the same commit.
4. `bun run typecheck` clean; `bun test src/` green; `elia bench-latency --strict` green.
5. Commit body: what moved, the before/after number, how it was measured.
6. Feature has an env kill‑switch or is a pure default change (revertable in one line).

---

## 7. Non‑goals (explicit)

Distributed anything, OpenTelemetry, signed audit logs, GA/ML over prompts or
prefetch, per‑action OS resource sandboxing, subagent worker‑process pools,
parallelised verification, connection‑pool rewrites, a `src/performance/` or
`src/telemetry/` module. In v1; out until a measurement says otherwise.

---

## 8. Open questions

- **3.2 grep stamping cost:** stamping every file a grep touched could be
  expensive on a huge result. Options: cap memoization to greps under N hits, or
  stamp only the directory tree's aggregate mtime. Decide with 3.6's numbers.
- **3.1 eviction of pending speculations:** evicting an in‑flight speculated read
  wastes the work but is safe. Acceptable, or should eviction skip unsettled
  promises? Lean: skip unsettled, evict settled first.
- **3.7 signature normalization:** how much to normalize the error line (paths?
  line numbers? hashes?) before comparing. Start strict (exact top line minus
  absolute paths), loosen if dedupe misses obvious repeats.

---

## 9. Honest positioning

Elia's real edge over Devin‑class agents already ships: speculative execution,
the multi‑tier model cascade, goal‑graph persistence, `elia evolve`, the
governance/contract layer, continuum memory. This plan adds no new
differentiator — it removes waste and closes small, measured gaps in what exists.
That is the correct scope. Inventing "superiority features" on a roadmap nobody
can measure is how v1 happened.

---

## 10. Remaining optimization opportunities (post-v3)

> **Superseded in part by §11.** §10 was a broad, unanchored sketch. §11 is the
> grounded pass — every item there carries `file:line`, a verified symptom, A/C,
> V, R, matching v3 discipline. Where they overlap (§10.1 SQLite ⇄ §11.1,
> §10.4 brain ⇄ §11.2) §11 is authoritative. §10 is kept for the ideas §11
> hasn't reached yet (cache warming, ledger compaction, HTTP client).

With all v3 items shipped, the following optimization opportunities have been
identified through codebase analysis. These are **not** committed as a formal v4
plan — they are documented here for future consideration, pending measurement
and prioritization.

### 10.1 Workspace performance (NEW - High Priority)

The workspace collaboration system (M1-M6 commits) represents a major new
surface area that needs performance attention:

- **SQLite query optimization**: Add composite indexes for common query patterns
  (objective_id, task_id, actor_id), implement query plan analysis, add query
  performance monitoring
- **Projection materialization**: Materialize frequently-accessed projections
  (tasks, agents, objectives) with incremental updates
- **WebSocket optimization**: Connection pooling, backpressure handling, batch
  event delivery, connection health monitoring

**Files**: `src/workspace/store.ts`, `src/workspace/schema.ts`,
`src/workspace/events.ts`, `src/workspace/server.ts`

### 10.2 Advanced caching strategies

Building on the solid caching foundation:

- **Cache warming strategies**: Pre-warm caches for known hot paths from profiling
  data, background cache warming for frequently-accessed files
- **Intelligent cache invalidation**: Fine-grained invalidation based on actual
  changes, dependency tracking between cache entries
- **Cache hit prediction**: ML-enhanced prediction for better cache utilization
  (requires measurement infrastructure)

**Files**: `src/cacheRegistry.ts`, `src/speculation/cache.ts`,
`src/speculation/deterministicCache.ts`, `src/speculation/prefetch.ts`

### 10.3 Concurrency & parallelism

- **Subagent worker pool**: Reuse subagent processes to reduce spawn overhead
  (deferred from v1, now worth revisiting if `bench-latency --live` shows fleet
  spin-up dominating)
- **Parallel verification**: Parallel execution for independent verification steps
  while maintaining fail-fast semantics for critical failures
- **Load-adaptive scaling**: Dynamically adjust concurrency limits based on system
  metrics (CPU, memory, I/O)

**Files**: `src/subagent.ts`, `src/autonomy/fleet.ts`, `src/autonomy/verify.ts`,
`src/agentLoop.ts`

### 10.4 Database & storage optimization

- **Brain store optimization**: Incremental brain loading (only changed sessions),
  optimized fingerprint computation, parallel session loading, search index
  optimization
- **Ledger compaction**: Background compaction of old ledger entries,
  configurable compaction policies, compaction during idle periods

**Files**: `src/brain/store.ts`, `src/brain/search.ts`, `src/ledger.ts`,
`src/compaction.ts`

### 10.5 Network & I/O optimization

- **HTTP client optimization**: Connection pooling and reuse, request batching,
  adaptive timeout based on response patterns, DNS caching optimization
- **File I/O optimization**: Batch file operations, async file operation
  optimization, file handle pooling, reduced system call overhead

**Files**: `src/tools/webFetch.ts`, `src/tools/webSearch.ts`,
`src/tools/readFile.ts`, `src/tools/editFile.ts`

### 10.6 Measurement discipline for future work

Any future optimization work should follow the v3 measurement discipline:

- Each item must add measurement scenario to latency harness where applicable
- Include before/after metrics in commit messages
- Pass existing `bench-latency --strict` checks
- Include performance regression tests
- Document measurement methodology

**Key principle**: If it can't be measured, it isn't claimed.

---

## 11. v4 candidate slate — grounded (post-v3 codebase sweep, 2026-09-09)

Same rigour as §3: every item has verified `file:line` anchors, a symptom read
straight from the code, acceptance criteria, a one-command validation (**V**),
and a rollback (**R**). Ordered by (payoff ÷ risk). Nothing here is a rewrite of
a working subsystem; each closes a specific, named gap.

Legend: **A/C** = acceptance criteria · **V** = validation · **R** = rollback.

### 11.0 — Status

| # | Item | State |
|---|---|---|
| 11.1 | Workspace hot-path query indexes | ✅ **shipped this pass** — `schema.ts` v2→v3 |
| 11.2 | Incremental (per-session) brain load | pending |
| 11.3 | WebSocket fan-out backpressure guard | pending |
| 11.4 | Batch `reconcileLeases` recovery | pending |
| 11.5 | Streaming audit-chain verification | pending (low priority) |
| 11.6 | Prefetch: stop blocking the loop on `statSync` | pending (measure via 3.6 first) |

---

### 11.1 — Workspace hot-path query indexes · 0.5 d · ✅ SHIPPED

**Files:** `src/workspace/schema.ts` (`SCHEMA_VERSION` 2 → 3),
`src/workspace/store.test.ts`.

**Symptom (verified):**
- `agent_messages` had **no index touching `seq`**, yet every `store.messages()`
  call ends `ORDER BY seq DESC LIMIT n` (`store.ts:272`) — a full table scan +
  filesort on every client poll / catch-up.
- `store.tasks({ objectiveId, status })` (`store.ts:227‑241`) — the board view and
  the orchestrator's readiness query — filters `objective_id` **and** `status`
  together, but only single-column `idx_tasks_objective` / `idx_tasks_status`
  existed.
- `workspace_events` needed **nothing**: `seq` is `INTEGER PRIMARY KEY
  AUTOINCREMENT` = the rowid, so `idx_events_objective` already carries the
  `seq > ?` range and returns rows in `seq` order (verified via
  `EXPLAIN QUERY PLAN`: `SEARCH … USING INDEX idx_events_objective
  (objective_id=? AND rowid>?)`, no B-tree sort). Adding a composite there was
  pure redundancy and was dropped.

**Change shipped:** three idempotent `CREATE INDEX IF NOT EXISTS` —
`idx_messages_objective_seq (objective_id, seq)`, `idx_messages_seq (seq)`,
`idx_tasks_objective_status (objective_id, status)` — plus the
`SCHEMA_VERSION` bump the file's own header mandates. Indexes live in the main
`migrate()` exec block, so existing DBs pick them up on next open.

- **A/C:** new `store.test.ts` case asserts `EXPLAIN QUERY PLAN` for the three
  hot queries is index-backed — names the expected index, no `SCAN`, no
  `USE TEMP B-TREE`. Whole workspace suite green (62 tests).
- **V:** `bun test src/workspace/store.test.ts && bun run typecheck`
- **R:** one revert; `CREATE INDEX IF NOT EXISTS` + a version bump are additive
  and safe to drop.

---

### 11.2 — Incremental, per-session brain load · 2 d

**Files:** `src/brain/store.ts:84` (module `cache`), `:94‑104`
(`defaultFingerprint`), `:106‑133` (`loadBrainItems`).

**Symptom (verified):** `defaultFingerprint` folds **every** session ledger's
mtime into one string. The *current* session's ledger is rewritten every turn
(`agent.ts` appends an episode), so on essentially every dev turn the single
whole-brain `cache` misses and `loadBrainItems` re-runs `loadLedger` for **all**
historical sessions — steady-state cost is O(total sessions ever) when it should
be O(1 changed ledger). The parallel `Promise.all` (shipped in 3.0) softens the
constant but not the scaling.

**Change:** replace the one-shot `cache` with a per-session parse memo —
`Map<sessionId, { stamp: 'mtimeMs:size'; items: BrainItem[] }>`. On load, stat
each ledger, reuse the memoized slice where `stamp` matches, re-parse only the
misses, concat. Lessons/rationale/notes keep their existing single mtime check.
Register the memo with `cacheRegistry` (bounded) and clear it in
`resetBrainCache()`.

- **A/C:** unit test — 20 historical ledger fixtures + 1 current; append one
  episode to the current ledger; assert exactly one `loadLedger` call on the
  second `loadBrainItems` (spy), output identical to a cold load. Stale check:
  a ledger rewritten with same length but different content (size moves) ⇒
  re-parsed.
- **V:** `bun test src/brain/store.test.ts`
- **R:** revert to the single-fingerprint cache (current behaviour).
- **Risk:** Low‑Medium — same staleness class as 3.2; `mtimeMs:size` stamp, not
  mtime alone; `resetBrainCache()` on checkpoint restore already wired.

---

### 11.3 — WebSocket fan-out backpressure guard · 1.5 d

**Files:** `src/workspace/server.ts:66‑75` (the `store.subscribe` fan-out).

**Symptom (verified):** the fan-out does `ws.send(frame)` for every connection
and **ignores the result** and `ws.getBufferedAmount()`. The event spine is
chatty (presence, `AgentHeartbeat`, `TaskProgress`), so one stalled client's
outbound buffer grows without bound — a server-side memory leak driven by a
remote peer.

**Change:** after `ws.send`, if the return is `-1` (Bun backpressure signal) or
`ws.getBufferedAmount()` exceeds a ceiling (e.g. 4 MB), stop sending live frames
to that socket and mark it `desynced`; on its next inbound message (or a short
timer) send one `{ type: 'resync', latestSeq }` frame and let the client refetch
via the existing `events({ sinceSeq })` path. Count `desyncs` for the profiler.

- **A/C:** `server.test.ts` — a client that never drains receives a bounded
  number of frames then a `resync`; server RSS stays flat while 10k events are
  appended; a healthy client on the same server misses nothing.
- **V:** `bun test src/workspace/server.test.ts`
- **R:** revert; fan-out goes back to unconditional `send` (today's behaviour).
- **Risk:** Low — the resync path is the same one used on every fresh connect.

---

### 11.4 — Batch `reconcileLeases` recovery into one transaction · 1 d

**Files:** `src/workspace/store.ts:325‑367`, called at `server.ts:78` (startup)
and every `HEARTBEAT_INTERVAL_MS` (`server.ts:79‑85`).

**Symptom (verified):** each recovered task / agent / reservation is a separate
`this.append()` — its own SQLite transaction **and** a full listener fan-out.
A server restarting after a crash with many in-flight tasks does N synchronous
commits before `Bun.serve` starts accepting connections, and each fires the
(at startup, empty but soon-populated) subscriber list.

**Change:** add a private `appendMany(inputs)` that runs the whole batch inside
one `db.transaction`, still writing one event row + one audit row per input, and
fans listeners out once after commit. `reconcileLeases` collects its recovery
events and flushes them through `appendMany`.

- **A/C:** unit test — seed 200 expired leases, one `reconcileLeases` call
  produces 200 events in one transaction (assert via a single
  `wal_checkpoint`-visible commit or a txn spy), history and audit chain intact
  (`auditChainIntact()` still true), recovered statuses correct.
- **V:** `bun test src/workspace/store.test.ts`
- **R:** revert; `reconcileLeases` goes back to per-event `append`.
- **Risk:** Low — same rows written, just grouped; rollback semantics strictly
  safer (all-or-nothing recovery).

---

### 11.5 — Streaming audit-chain verification · 0.5 d · low priority

**Files:** `src/workspace/store.ts:136‑148` (`auditChainIntact`).

**Symptom (verified):** `SELECT * FROM audit_log ORDER BY seq ASC` materialises
the **entire** audit history in memory and rehashes every row on each call.
O(all history) time and memory. Not a hot path (verification / debug only), so
this is filed low.

**Change:** iterate with a prepared statement cursor instead of `.all()`;
optionally accept a `fromSeq` + trusted prior `entry_hash` to verify only the
tail. No schema change.

- **A/C:** existing audit-chain test still passes; a 50k-row fixture verifies
  without a memory spike; tamper in the middle still detected.
- **V:** `bun test src/workspace/store.test.ts`
- **R:** revert to `.all()`.

---

### 11.6 — Prefetch: don't block the loop thread on `statSync` · 1 d · measure first

**Files:** `src/speculation/prefetch.ts:180‑189` (`isSpeculativelyReadable`),
`:108‑117` (`extractPaths`), `:80‑104` (`observe`).

**Symptom (verified):** `observe()` runs **synchronously** after every tool
round, and `extractPaths` calls `isSpeculativelyReadable` → `statSync` for every
path-shaped token in the output *before* the slice to
`MAX_PREDICTIONS_PER_ROUND`. A wide grep result = dozens of blocking `statSync`
calls on the critical path between the model's tool batch and the next request.

**Change:** cap the number of candidates stat-checked per round (slice the regex
matches first, then stat), **or** drop the pre-stat entirely and let
`cache.speculate` attempt the read — a missing/oversized file fails cheap in the
already-async speculation body. Keep the ignore-dir check (string-only, no I/O).

- **A/C:** `prefetch.test.ts` — a 500-hit synthetic grep result triggers ≤
  `MAX_PREDICTIONS_PER_ROUND` stats (or zero); `grep-chain` scenario still 2/2
  cached; no new real reads for non-existent paths land in the transcript.
- **V:** `bun test src/speculation/prefetch.test.ts && elia bench-latency --only grep-chain`
- **R:** revert; pre-stat filter restored.
- **Risk:** Low — caps and the ignore filter are unchanged; worst case is a
  cheap failed speculative read (already handled, `cache.ts:61`).

---

### 11.7 — Sequencing

| # | Item | Days | Gate |
|---|---|---|---|
| 1 | 11.1 Workspace indexes | 0.5 | ✅ done — EXPLAIN test green |
| 2 | 11.2 Incremental brain load | 2 | one `loadLedger` on steady-state turn |
| 3 | 11.4 Batch lease recovery | 1 | 200-lease recovery = 1 txn, chain intact |
| 4 | 11.3 WS backpressure guard | 1.5 | server RSS flat under a stalled client |
| 5 | 11.6 Prefetch stat cap | 1 | measured on 3.6 numbers first |
| 6 | 11.5 Streaming audit verify | 0.5 | 50k-row verify, no spike |

**Total ≈ 6.5 engineering days.** All six are gap-closers on the workspace /
brain / speculation surfaces — no new module, no new differentiator, consistent
with §9.

---

## 12. Out-of-plan work landed on `production`

Feature work, not perf/reliability — recorded here only so the branch history is
legible alongside this plan.

| Date | Commit | What |
|---|---|---|
| 2026-09-09 | `45ac154` | **Image input in the terminal.** New `image` `ContentBlock`; `src/attachments.ts` (magic-byte sniff, path extraction, 5 MB cap); Anthropic base64 source + OpenAI `image_url` data URL + Codex text-marker fallback; `/attach <path>` and inline paste/drag detection in both REPLs; compaction counts an image at ~1.5k tokens. Tests: `src/attachments.test.ts` + provider/compaction cases. |
