# Elia — Bug-Hunt Report

> Generated: 2026-09-09 (UTC). Scope: full sweep (correctness, crashes, error handling, concurrency, security, tests). Verification: static reads + subagent sweeps; runtime `typecheck` / `bun test` NOT yet run for this report — see Verification section.
> Repo: `D:\elia`, branch `production` @ `b7b3595` at time of sweep.
> Addendum 2026-09-09: focused second sweep of the collaborative-workspace subsystem (`src/workspace/`, flagged thin-coverage in P2-6). New findings in the "W — workspace subsystem" section below; static reads only, not yet runtime-verified.

## How to use this file

- P0 = crash / hang / data-loss / injection / auth-bypass candidate. Verify first.
- P1 = correctness / silent-failure / wrong-result candidate.
- P2 = hardening / tech-debt / coverage gap.
- Each item is `file:line — symptom — evidence — fix sketch`. All line numbers were read directly; re-check before editing as tree moves.

---

## P0 — critical (verify before fixing anything else)

### P0-1 Shell command injection surface — `src/shell.ts:79`, `src/tools/runCommand.ts:148,154,167`
- Symptom: `runShell(command)` builds `[sh, -c, command]` / `[cmd, /d, /s, /c, command]`; `input.command` comes from the model verbatim. Governor + length/timeout checks exist but there is no shell-escaping layer. Prompt-injection → arbitrary `sh -c`.
- Evidence: `src/shell.ts:79`; callers `runCommand.ts:148,154,167`, `skills/synthesize.ts:58` (quoted `testFile` but not escaped — `"` + `;...` breaks out), `tools/communication.ts:295`, `tools/browser.ts:234` (`Bun.spawn` with constructed shell string).
- Counter-examples (safe argv): `tools/presentation.ts:201` (libreoffice), `tools/grep.ts:146` (rg), `autonomy/worktree.ts:47` (git).
- Fix sketch: prefer argv-spawn for internal callers; add a shell-arg escaper for model `command`; add a test with `"; touch pwned"` / `"$(...)"` payloads asserting no breakout. Do NOT weaken governor.

### P0-2 Repo lock is in-process only, no timeout — `src/repoLock.ts:17`
- Symptom: `withRepoLock` is a process-wide promise-chain FIFO. No cross-process mutual exclusion, no timeout, covers only `edit_file/write_file/visualize` (`MUTATING_TOOLS`).
- Evidence: `src/repoLock.ts:1-24` (24 lines total).
- Fix sketch: document single-process assumption OR add file-lock (e.g. lockfile with stale-lease reclaim) + timeout + metric for queue depth. Add stress test: parallel edits to same file.

### P0-3 Atomic-write coverage is uneven — `src/tools/atomicWrite.ts` vs `src/securePersistence.ts`
- Symptom: `atomicWrite.ts:23-47` does tmp + `renameWithRetry` (Windows EPERM/EACCES/EBUSY backoff `[10,25,50,100,200]ms`). `securePersistence.ts` uses `renameSync` with no retry, `pid+Date+random` tmp. Other writers use `Bun.write` / `fs.writeFile` (truncate-then-stream → torn file on kill/crash).
- Evidence: `atomicWrite.ts:58-71`; `securePersistence.ts` harden path; mixed `Bun.file/Bun.write` + `node:fs` across `allowStore, artifactReader, brain/*, ledger, journal`.
- Fix sketch: route all mutating writers through `atomicWrite`; add retry to `securePersistence`; test kill-mid-write (target is old-complete or new-complete, never partial).

### P0-4 MCP connect/shutdown errors swallowed + deadline leak — `src/mcp/registry.ts:122-131,147,158`
- Symptom: `await Promise.race([allConnected, deadline])` leaves `allConnected` running after soft deadline; `void allConnected.catch(()=>{})` and `closeAndWait().catch(()=>{})` hide failures.
- Fix sketch: track/abort pending connects on deadline, log with redaction, surface structured `timeout` vs `refused` classification. Test: slow connector → bounded return + no dangling promise.

### P0-5 Daemon cancel/shutdown failures invisible — `src/daemon/client.ts:247,332`
- Symptom: `rawCall('daemon.shutdown').catch(()=>{})`, `rawCall('shell.cancel').catch(()=>{})`.
- Fix sketch: log + propagate to receipt/journal as `human-review` state; test cancel-during-run asserts receipt records it.

---

## P1 — correctness / silent failure

### P1-1 `closestRegions` loop bound is dead code — `src/tools/editMatch.ts:56`
```ts
for (let i = 0; i + height <= fileLines.length + height - 1 && i < fileLines.length; i += 1) {
```
- Symptom: first clause simplifies to `i < fileLines.length`, i.e. identical to second clause. Likely intended `i + height <= fileLines.length` (window fits in file). Currently scans extra tail windows; low-severity wrong-hint risk, not a crash.
- Evidence: read `src/tools/editMatch.ts:48-74`.
- Fix sketch: change to `i + height <= fileLines.length`; add unit test: needle height 3 in 5-line file → windows at lines 1,2,3 only.

### P1-2 `percentile()` NaN / out-of-range — `src/profile.ts:142-147`
```ts
const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
return sorted[index]
```
- Symptom: `p > 100` clamps correctly by accident, but `p = NaN` → `Math.min(len-1, NaN)` = `NaN` → `sorted[NaN]` = `undefined` (typed `number | undefined` so no crash, but silent). `p < 0` → negative index → `undefined`.
- Fix sketch: validate `Number.isFinite(p) && p >= 0 && p <= 100`; return `undefined` or throw `RangeError`. Test `NaN, -1, 101, 100`.

### P1-3 `mean()` empty-array → `NaN` — `src/battmann/store.ts:674-675`
- Symptom: `sum / values.length` with no guard. Caller `pairedInterval:678-682` guards `< 2` today, but `mean` is reusable.
- Fix sketch: return `undefined` or throw on empty; add test.

### P1-4 `percentile()` OOB probability silent `null` — `src/tools/dataScience.ts:130-139`
- Symptom: guards empty input but not `probability ∉ [0,1]`; OOB returns `null` via `lowerValue === undefined` check with no error.
- Fix sketch: validate range explicitly; test `probability = -0.1, 1.5, NaN`.

### P1-5 Bare `JSON.parse(...) as T` on corrupt files — multiple sites
- Sites: `tools/presentation.ts:185,253,258`, `autonomy/goalGraph.ts:126,148`, `autonomy/allowStore.ts:70`, `autonomy/detectChecks.ts:60`, `autonomy/scheduler.ts:74`, `tools/deployment.ts:172,288`, `brain/consolidate.ts:64`.
- Symptom: throws generic `SyntaxError`, no schema validation; some callers catch, many propagate as crash.
- Fix sketch: `try/catch` with `path + reason` + zod/type-guard; corrupt-fixture tests per loader.

### P1-6 Fire-and-forget promise failures — `src/index.ts:437,1246-1262,1668-1670`, `src/providers/prewarm.ts:30-33`, `src/compaction.ts:140-142`, `src/workspace/cli.ts:395`, `src/workspace/agentRuntime.ts:145,155,169`
- Symptom: `void ... .catch(()=>{})` hides MCP load, prewarm, consolidate, dashboard-refresh, progress-heartbeat failures. Some are intentional (offline prewarm, EPIPE guard in `mcp/client.ts:22-25`, speculation drops in `speculation/cache.ts:61,98`) but most log nothing.
- Fix sketch: route through a `logSwallowed(scope, err)` debug hook; keep intentional ones with comment + test asserting no `unhandledRejection`.

### P1-7 `synthesize.ts` test-file quoting — `src/skills/synthesize.ts:58`
- Symptom: ``bun test "${testFile}"`` quoted but not escaped; filename with `"` breaks out.
- Fix sketch: argv-spawn `['bun','test', testFile]`; test with adversarial filename.

### P1-8 Preview server single-decode, no symlink check — `src/preview/server.ts:114-126`
- Symptom: `resolveWithinRoot()` does single `decodeURIComponent` + `startsWith(rootWithSep)`; stronger path (`react_server.ts:17-32` with `assertSafeFileAccess`, NUL/malformed-encoding rejection) not reused. Double-encoding / symlink escape not verified.
- Fix sketch: reuse `resolveWorkspacePath + assertSafeFileAccess`; add traversal tests (`%252e%252e`, symlink-to-outside fixture).

### P1-9 Secret-detector bypass — `src/autonomy/assumptions.ts:57`, `src/autonomy/hygiene.ts:90-98`
- Symptom: regex `secret|password|api[_-]?key|token|credential` bypassable (see `assumptions.test.ts:154` unicode-hyphen case).
- Fix sketch: normalize unicode confusables before match; add cases for homoglyphs, `SECRET_ASSIGNMENT` variants.

### P1-10 Env mutation restore path — `src/index.ts:970,1014,1188-1210`
- Symptom: `process.env[KEY] = apiKey` mutation with restore; exception between set/restore may leak key into wrong provider call.
- Fix sketch: `try/finally` restore + test asserting env equality after throw.

---

## P2 — hardening / debt / coverage

- **P2-1** `tools/presentation.ts:11-178` — whole vendor `require('../vendor/pptxgen.cjs.js') as any`, `PresentationSlide = any`, 7× `as any` option casts hide API drift. Wrap in typed adapter.
- **P2-2** `!` non-null pervasive (~100+): `agentLoop.ts:464 reservation!.action`, `bench/harness.ts:189 only!`, `brain/search.ts:50 kinds!`, `fleet.ts:184 graph!`, `tools/grep.ts:122,131`, `autonomy/progress.ts:120,128`, `battmann/store.ts:694`, `ui/stream.ts:312`. Most length-checked (safe but brittle). Enable/keep `noUncheckedIndexedAccess` and replace with explicit guards.
- **P2-3** `console.*` direct output: `index.ts:118,301`, `react_server.ts:76`, `providers/registry.ts:260` bypass UI stream logger. Route via `writeNotice`/stream.
- **P2-4** Cleanup swallows: `tools/atomicWrite.ts:44`, `autonomy/treeSnapshot.ts:120,136`, `autonomy/variants.ts:90` — `rm/unlink .catch(()=>{})` → stale tmp/snapshot risk. Log at debug.
- **P2-5** Codex interrupt / warmup silent: `providers/codexAppServer.ts:70,75,233`, `codexSubscription.ts:101,280-281` — may retry-loop. Surface interrupt-failure to run receipt.
- **P2-6** No sibling test for 85/258 impl files (~33%). Lowest confidence + highest churn: `autonomy/loop.ts, daemon.ts, journal.ts`, `tools/runCommand.ts, writeFile.ts, grep.ts`, `workspace/rpc*.ts, client.ts, connection.ts, agentRuntime.ts, events.ts, schema.ts`, `evolve/engine.ts, ledger.ts`, `index.ts, agent.ts, subagent.ts`. Note: no-sibling ≠ zero coverage (`loop.ts` via `agentLoop.test.ts`), but direct tests are thin. New untracked `static-site/`, `crates/elia-native/` have no visible tests.
- **P2-7** `TODO` hygiene: only real hits are `evolve/hardSuite.ts:275` (decoy string in eval harness — keep), `tools/engagement.ts:88,94` (`_TODO_` scaffold placeholders — ensure never shipped as final report).

### Explicit non-bugs (checked, leave alone)
- `hardSuite.ts:275 TODO` inside decoy literal — intentional.
- `WorkspacePanel.tsx:7,60 TODO_MARK` — domain term, not marker.
- `prewarm.ts:30-33 HEAD .catch` — documented offline-tolerant.
- `mcp/client.ts:22-25 swallow()` — intentional EPIPE guard with comment.

---

## W — workspace subsystem (collaborative workspace, added 2026-09-09)

> One subsystem, one root cause: `src/workspace/events.ts:1-9` and `store.ts:8-13` promise the projection tables are a **pure forward fold** of `workspace_events` and "can be rebuilt by replaying every event through `applyProjection`". Three write paths break that (W-5, W-6), and two state transitions never re-derive task readiness (W-1, W-2). W-1/W-3/W-4 are reachable in ordinary operation.
> Line numbers as found on `production` @ `b7b3595`; the *Resolved* notes below give the post-fix state.
>
> **STATUS 2026-09-09: W-1 … W-6 all fixed and shipped to `production`.** Changes in `events.ts`, `orchestrator.ts`, `reservations.ts`; new regression tests in `store.test.ts` (W-1, W-2), `orchestrator.test.ts` (W-3, W-4), `reservations.test.ts` (W-5). `bun run typecheck` clean; `bun test src/workspace/` 67/67 green; full `bun test src/` 1455 pass (3 pre-existing UI-caret failures, unrelated, since fixed on `production` by an unrelated commit).

### W-1 (P1) `TaskUnblocked` strands a runnable task in `pending` forever — `src/workspace/events.ts:327-331`
```ts
case 'TaskUnblocked': {
  const task = toTask(requireTaskRow(db, String(event.taskId)))
  const depsDone = task.dependsOn.length === 0            // ← "has no deps", not "deps are done"
  setTaskStatus(db, String(event.taskId), depsDone ? 'ready' : 'pending', { last_error: null })
```
- Symptom: a member blocks then unblocks a task (`task.block` / `task.unblock`, `rpcOrchestration.ts:181-193`) whose dependencies are already `done`. `depsDone` is hardcoded to "zero dependencies", so any task with an ordering edge drops to `pending`. The handler never calls `refreshTaskReadiness`, and `Orchestrator.tick()` (`orchestrator.ts:102-163`) never calls it either — the only triggers are `ObjectiveStatusChanged→active` (`events.ts:260`), `TaskCompleted` (`events.ts:315`), `ReviewCompleted` (`events.ts:350`). Nothing re-evaluates the task unless an unrelated sibling completes.
- Consequence: if it is the last open task, `maybeCompleteObjective` (`events.ts:436-447`) counts `pending` as open → objective hangs in `active` permanently.
- **Resolved:** `TaskUnblocked` now sets the task to `pending` and calls `refreshTaskReadiness(db, task.objectiveId)`, which promotes it to `ready` iff its dependencies are actually terminal. Regression tests in `store.test.ts`: "unblocking a task with satisfied dependencies makes it ready…" and "blocking then unblocking the last open task still lets the objective complete".

### W-2 (P1) `refreshTaskReadiness` treats a missing dependency as satisfied — `src/workspace/events.ts:158`
```ts
const depsDone = task.dependsOn.every((depId) => (byId.get(depId)?.status ?? 'done') === 'done')
```
- Symptom: `byId` is scoped to the one objective. A `dependsOn` id that is not found — typo, stale id after a re-plan, cross-objective ref — defaults to `'done'` and the dependent dispatches early. The RPC create path validates deps (`rpcOrchestration.ts:142`); direct `TaskCreated` events and `decompose.ts:152` do not.
- Also: a `cancelled` dependency never equals `'done'`, so its dependents strand (latent — `TaskCancelled` has a projection handler at `events.ts:333` but is not emitted anywhere in production yet).
- **Resolved:** new `TERMINAL_DEP_STATUSES = {done, cancelled}`; the check is now `const dep = byId.get(depId); return dep ? TERMINAL_DEP_STATUSES.has(dep.status) : false` — an unknown id is explicitly *not* satisfied (a stuck task is louder and safer than a mis-dispatch), and a cancelled dependency no longer strands its dependents. Regression test in `store.test.ts`: "a task that names an unknown dependency is never dispatched…".

### W-3 (P1) Orchestrator dispatch ceiling uses `return`, starving later objectives — `src/workspace/orchestrator.ts:137`
```ts
for (const objective of objectives) {
  // ... reviewer routing, lines 116-131 — read-only, needs no dispatch slot ...
  for (const task of ready) {
    if (inFlight >= this.maxConcurrent) return   // ← exits the whole tick, not just this objective
```
- Symptom: when the first active objective fills `maxConcurrentDispatch` (default 8), the `return` abandons the rest of the objectives loop. Every later objective gets no dispatch **and** no reviewer routing — even though reviews are read-only and never counted in `inFlight` (`orchestrator.ts:111`). Objective B's `in-review` tasks wait for objective A to drain.
- **Resolved:** `tick()` is now two passes over `objectives` — pass 1 routes every objective's in-review tasks to reviewers (no ceiling), pass 2 dispatches ready work and uses `break` (not `return`) at the ceiling. Regression test in `orchestrator.test.ts`: "a saturated objective does not starve a later objective of reviewer routing".

### W-4 (P1) Retryable failures are re-queued with no backoff — `src/workspace/orchestrator.ts:222-244`
- Symptom: `handleFailures` calls `classifyFailure(task.lastError, { source: 'report' })` then, for `class === 'retryable'`, immediately appends `TaskStatusChanged→ready`. `classifyFailure` (`autonomy/goalGraph.ts:770-797`) also returns `retryAfter` (30_000 ms for `rate limit | 429 | quota exceeded | too many requests`) — `handleFailures` never reads it. The orchestrator reacts to its own `TaskStatusChanged` event plus a 5 s sweep, so the task is re-dispatched at once.
- Consequence: a rate-limited task thrashes the wall and burns all of `maxAttempts` (default 2, `events.ts:272`) in seconds, then escalates to a human for something that would have cleared itself. `autonomy/loop.ts:801-809` fixed exactly this for the non-workspace path (`lastError?.retryAfter` → `await delay(backoffMs)`).
- **Resolved:** no schema change — `handleFailures(now)` computes `readyAt = Date.parse(task.updatedAt) + failure.retryAfter` (the `TaskFailed` projection time is the failure time) and `continue`s the task, leaving it `failed`, until `now >= readyAt`; the 5 s sweep revisits. Regression test in `orchestrator.test.ts`: "a rate-limited failure waits out its backoff before being re-queued".

### W-5 (P1) Reservation renewal bypasses the event spine → a projection rebuild loses every lease — `src/workspace/reservations.ts:103-109`
```ts
export function renewForTask(store: WorkspaceStore, taskId: string, now = Date.now()): number {
  const held = store.reservations(true).filter((r) => r.taskId === taskId)
  for (const reservation of held) {
    store.raw().query('UPDATE reservations SET expires_at = ? WHERE id = ? AND released_at IS NULL').run(now + LEASE_TTL_MS, reservation.id)
```
- Symptom: this raw `UPDATE` is the one reservation write that is not an appended event. After any projection rebuild-from-events, every renewal vanishes and `expires_at` reverts to the acquire-time value (`ReservationAcquired` payload, `events.ts:364-369`). The next `reconcileReservations` (`reservations.ts:127-133`) then mass-expires reservations that are still actively held → the orchestrator dispatches a second agent onto the same files. This is precisely the conflict the ledger exists to prevent (`reservations.ts:1-13`).
- Counter-example (correct): task-lease renewal goes through the `TaskProgress` event (`events.ts:304-308`).
- **Resolved:** new `ReservationRenewed` event type + projection case (`UPDATE reservations SET expires_at = ? WHERE id = ? AND released_at IS NULL`); `renewForTask` appends it instead of the raw `UPDATE`. Renewals are now on the spine and survive a rebuild. Regression test in `reservations.test.ts`: "renewForTask pushes the lease out — on the event spine, not a raw write" (asserts a `ReservationRenewed` event and `auditChainIntact()`).

### W-6 (P2) Projection fold is not deterministic — `Date.now()` where `event.at` belongs — `src/workspace/events.ts:373` (also `299`, `306`, `368`)
- Symptom: `ReservationReleased` / `ReservationExpired` set `released_at = Date.now()`; `TaskStarted` / `TaskProgress` / `ReservationAcquired` use `?? Date.now()` fallbacks. Replaying the same event log at a different wall-clock time yields different projection rows.
- Impact today: harmless for `released_at` (only nullness is queried) but it is the same purity invariant W-5 depends on, and `lease_expires_at` fallbacks could shift a lease across the reconcile cutoff on replay.
- **Resolved:** new `eventMs(event)` helper (`Date.parse(event.at)`, falling back to `Date.now()` only if the timestamp is unparseable); every `Date.now()` in a projection handler — `released_at`, and the `lease_expires_at` / `acquired_at` / `expires_at` fallbacks — now routes through it. Replaying the same log twice yields identical projections.

### Workspace non-bugs (checked)
- `store.ts:110-117` throwing-listener isolation — deliberate, commented.
- `identity.ts:50-52` token hash lookup — sha256 + DB lookup, no timing-attack surface worth constant-time compare.
- `reservations.ts:52-86` `acquireForTask` check-then-append — fully synchronous (`bun:sqlite` + no `await`), so atomic within one process; cross-process is out of scope by design (server holds the handle).

---

## Verification (to run before claiming fixes)

```powershell
# typecheck
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun run typecheck
# focused tests (adjust per fix)
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun test --timeout=20000 src/tools/editMatch.test.ts src/profile.test.ts src/shell.test.ts src/repoLock.test.ts
# workspace subsystem (W-1 .. W-6)
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun test --timeout=20000 src/workspace/
# full suite before delivery
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun test --timeout=20000 src/
git diff --check; git status --short
```

Per `AGENTS.md`: smallest coherent change, preserve strict TS + ESM/Bun, keep secrets out of logs/receipts/commits, inspect `git diff` before reporting completion.

## Suggested fix order
1. ~~W-1 … W-6 (workspace subsystem)~~ — **DONE 2026-09-09**, shipped to `production`.
2. P0-1, P0-2, P0-3 (blast radius: RCE / corruption / torn writes).
3. P0-4, P0-5 (hang-invisible failures).
4. P1-1 → P1-4 (small, testable, high confidence).
5. P1-5 → P1-10 (error-handling consistency).
6. P2 in churn order: `workspace/rpc*` → `autonomy/*` → `tools/*`.
