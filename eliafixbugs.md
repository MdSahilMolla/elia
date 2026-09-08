# Elia — Bug-Hunt Report

> Generated: 2026-09-09 (UTC). Scope: full sweep (correctness, crashes, error handling, concurrency, security, tests). Verification: static reads + subagent sweeps; runtime `typecheck` / `bun test` NOT yet run for this report — see Verification section.
> Repo: `D:\elia`, branch `production` @ `b7b3595` at time of sweep.

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

## Verification (to run before claiming fixes)

```powershell
# typecheck
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun run typecheck
# focused tests (adjust per fix)
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun test --timeout=20000 src/tools/editMatch.test.ts src/profile.test.ts src/shell.test.ts src/repoLock.test.ts
# full suite before delivery
NO_COLOR=1; $env:ANTHROPIC_API_KEY="test-key-for-local-tests"; bun test --timeout=20000 src/
git diff --check; git status --short
```

Per `AGENTS.md`: smallest coherent change, preserve strict TS + ESM/Bun, keep secrets out of logs/receipts/commits, inspect `git diff` before reporting completion.

## Suggested fix order
1. P0-1, P0-2, P0-3 (blast radius: RCE / corruption / torn writes).
2. P0-4, P0-5 (hang-invisible failures).
3. P1-1 → P1-4 (small, testable, high confidence).
4. P1-5 → P1-10 (error-handling consistency).
5. P2 in churn order: `workspace/rpc*` → `autonomy/*` → `tools/*`.
