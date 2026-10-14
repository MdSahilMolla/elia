---
name: elia-testing-navigation-guidance
description: >
  Synthesizes recurring lessons on browser navigation, test execution, and submission protocols to prevent common build, hygiene, and acceptance failures in the Elia repository.
---
# Elia Testing and Navigation Standards

This skill consolidates recurring lessons on navigation, testing, and submission protocols to prevent common build and review failures.

## Browser Navigation
- Always use absolute HTTP(S) URLs with `browser.navigate`. Relative paths or `file://` URIs cause navigation errors.
- Start the local dev server (`bun dev`) on `http://localhost:3000` before running tests that import `workspacePanel.test.ts` or `securityTriage.test.ts`.

## Test Execution
- Use `bun test` with explicit paths; `bun run test:fast` is not reliable for general testing.
- Configure `ELIA_OUTAGE_RETRY_DELAYS_MS` with one comma-separated delay value per expected outage retry pass.
- Guard cargo-dependent tests with `hasCargo()` and use `test.skip` when cargo is unavailable.

## Submissions and Security
- Provide a verdict for *every* acceptance criterion and assumption in `submit_acceptance` and `submit_assumptions`.
- Never hardcode AWS or API keys. Read secrets from the environment and fail startup if missing.

## File and Path Safety
- Verify file paths do not duplicate the project root when invoking `read_file` on agent skills.
- Use `git show HEAD -- <paths>` instead of `git show --no-stat`.
- Treat empty lock files in `unreadableLockIsStale()` as in-progress acquisitions, not stale.
