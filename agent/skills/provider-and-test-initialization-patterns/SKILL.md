---
name: provider-and-test-initialization-patterns
description: >
  Use this skill when configuring tests, validating provider/model combinations,
  or troubleshooting test failures related to module initialization. It covers
  environment variable setup, provider validation behavior, Rust toolchain guards,
  dev server requirements, and test execution patterns.
---
# Provider and Test Initialization Patterns

## Environment Variable Setup
- Set provider API keys (`ANTHROPIC_API_KEY`, `ELIA_API_KEY`, `ELIA_EVOLVE_API_KEY`) **before** any imports in test files. Providers resolve at import time; setting keys after imports causes resolution failures.
- In `config.test.ts`, use `process.env.ANTHROPIC_API_KEY ??= 'test-key-for-local-tests'` at line 1.
- For `switchModel/switchThinking` tests, capture original environment variables (`ELIA_PROVIDER`, `ELIA_MODEL`, `ELIA_THINKING`) at import time and restore them directly in `afterEach`. Do not use `switchModel/switchThinking` with captured config values (which may be undefined at import time).

## Provider and Model Validation
- `validateModelForProvider()` returns undefined for valid combinations and an error string for mismatches. It validates: Codex (only 'default'), Ollama (requires `model:tag`), Anthropic (starts with 'claude-'), and cross-provider mismatches.
- `saveProviderConfiguration()` converts validation warnings to thrown errors before saving.
- `checkConfigHealth()` converts mismatches to exit code 1 at startup.
- Validation is integrated in `src/config.ts` for config initialization, tiers, and overrides (lines 201, 780, 787, 796). Ensure `src/providerSettings.ts` and `src/config.ts` implement validation before saving or starting the app.

## Test Execution and Dev Server
- Start the local dev server with `bun dev` (http://localhost:3000) **before** running `bun test`. Tests like `src/ui/workspacePanel.test.ts` and `src/tools/securityTriage.test.ts` will exit with code 1 if the dev server is not running.
- Always verify `src/ui/workspacePanel.test.ts` initializes without side effects before relying on its exit codes.
- Avoid running `bun test` without a specific file pattern; target specific files like `src/config.test.ts` directly to avoid initialization failures.
- Always run `bun run typecheck` before relying on test results.

## Rust Toolchain Validation
- Rust toolchain validation is implemented across three layers to prevent silent failures:
  1. `src/autonomy/toolchain.ts`: Exports `hasCargo()`, `hasRustc()`, and `checkRustToolchain()`.
  2. `src/autonomy/envReadiness.ts`: Detects missing Cargo.toml and reports Rust toolchain as a blocker.
  3. `justfile` recipes: All cargo-invoking recipes include shell-level pre-checks to fail gracefully when cargo is missing.
- Tests in `src/autonomy/envReadiness.test.ts` use conditional skipping via `hasCargo` and `maybeCargo`. Verify crates are detected as blockers when cargo is missing.

## Test Patterns and Mocks
- For `switchModel/switchThinking` tests, avoid using `switchModel/switchThinking` with captured config values. Capture env vars at import time and restore directly.
- Avoid adding global retry-delay mocks (`ELIA_TRANSIENT_RETRY_DELAYS_MS`, `ELIA_OUTAGE_RETRY_DELAYS_MS`) to `agentLoop.test.ts`. Tests like "provider stays overloaded" depend on default retry counts. Set these env vars locally only in tests that explicitly need to skip network waits.
- To verify security fixes, run `bun run test src/tools/securityTriage.test.ts` and check that `resolveReconLogPath` rejects Windows paths (C:\), absolute paths (/etc/passwd), and directory traversal (../../).

## Submission and Navigation Protocols
- `submit_verdict`: Ensure at least one issue is included in the payload.
- `submit_acceptance`: Provide a verdict for every criterion, including those labeled as satisfied.
- `submit_assumptions`: Provide a verdict for every assumption, including those titled 'None additional'.
- `browser.navigate`: Requires an absolute http(s) URL. Relative paths or file:// URIs will result in navigation errors.