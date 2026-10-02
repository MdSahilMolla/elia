---
name: runtime-hygiene-protocols
description: >
  Guidelines for running tests, configuring browser sessions, and handling external
  dependencies like Rust and secrets. Use this when writing test scripts, verifying
  fixes, or configuring environment readiness to prevent common setup failures.
---
# Runtime Environment & Test Hygiene Protocol

## Browser Navigation
When using `browser.navigate`, always supply an absolute `http://` or `https://` URL. Relative paths and `file://` URIs cause navigation to fail.

## Testing & Verification
Use `bun test` with explicit file paths instead of `bun run test:fast`, which is not idempotent. If the application requires a running server, start it via `bun dev` before running tests. Verify that tests pass with their expected exit codes, noting that some (like `src/ui/workspacePanel.test.ts`) may exit with code 1 due to module initialization side effects before the fix is applied.

Specific test behaviors:
- The `src/fileLock.test.ts` test at line 54 (just-created lock held, not reclaimed) requires a grace period fix in `unreadableLockIsStale()`.
- `src/autopilot/autopilot.test.ts` contains no `test.todo` or `test.skip` markers.
- `envReadiness` tests correctly flag Rust crates as blockers when cargo is missing.

## Cargo & Rust Dependencies
In test files (e.g., `envReadiness.test.ts`, `provisionEnvironment.test.ts`), guard cargo-dependent tests using `hasCargo()` checks. Use `test.skip` via `maybeCargo` when cargo is unavailable. When adding cargo-invoking recipes to `justfile`, include a shell-level pre-check to exit with an error if `cargo --version` fails.

## Security & Configuration
Do not hardcode API keys (AWS, OpenAI) in source files. Read them from environment variables and fail startup if they are missing. When implementing path resolution logic (e.g., `resolveReconLogPath`), reject Windows paths, absolute system paths, and directory traversal sequences.

## Task Execution & Assumptions
When submitting assumptions, provide a verdict for every assumption, including the "None" entry. If repair attempts fail to clear build or review gates (e.g., hygiene failures or test mismatches), diagnose the root cause before committing to a plan. Always verify file paths do not duplicate the project root when reading agent skills, and do not assume `src/layout.ts` exists in the project root.
