---
name: provider-and-test-initialization-patterns
description: >
  Use this when configuring tests, validating provider/model combinations,
  or troubleshooting test failures related to module initialization. It
  covers environment variable setup, provider validation behavior, Rust
  toolchain guards, and specific test patterns.
---
# Provider and Test Initialization Patterns

## Environment Variable Setup
- Set `ANTHROPIC_API_KEY` and other provider environment variables (like `ELIA_API_KEY` or `ELIA_EVOLVE_API_KEY` when `ignoreAmbient: true` is used) **before** any imports in test files. Providers resolve at import time; setting them after imports can cause resolution failures.
- In `config.test.ts` and similar files, use `process.env.ANTHROPIC_API_KEY ??= 'test-key-for-local-tests'` at line 1.

## Provider and Model Validation
- `validateModelForProvider()` returns warning strings for mismatches.
- `saveProviderConfiguration()` converts these warnings to thrown errors before saving.
- `checkConfigHealth()` converts mismatches to exit code 1 at startup.
- Mismatch validation occurs in two places: `saveProviderConfiguration()` (before saving) and `checkConfigHealth()` (at startup).

## Test Patterns and Mocks
- For `switchModel/switchThinking` tests, save original environment variables (`ELIA_PROVIDER`, `ELIA_MODEL`, `ELIA_THINKING`) at import time and restore them directly in `afterEach`. Do not use `switchModel/switchThinking` with captured config values.
- Avoid adding global retry-delay mocks (`ELIA_TRANSIENT_RETRY_DELAYS_MS`, `ELIA_OUTAGE_RETRY_DELAYS_MS`) to `agentLoop.test.ts`. Tests like "provider stays overloaded" depend on default retry counts. Set these env vars locally only in tests that explicitly need to skip network waits.

## Rust Toolchain Validation
- Rust toolchain validation guards are implemented across three layers to prevent silent failures:
  1. `src/autonomy/toolchain.ts`: Exports `checkRustToolchain()` to validate cargo/rustc are on PATH and execute successfully.
  2. `src/autonomy/envReadiness.ts`: Detects missing Cargo.toml and reports Rust toolchain as a blocker.
  3. `justfile` recipes: Shell-level pre-checks exit with clear errors before invoking cargo.
- Ensure these files are present and correctly referenced in your environment.

## Known Test Initialization Issues
- `src/tools/securityTriage.test.ts` and `src/ui/workspacePanel.test.ts` may exit with code 1 due to module initialization side effects or unresolved providers.
- Verify initialization checks in these specific tests before relying on their exit codes for acceptance.
