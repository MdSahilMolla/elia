---
name: test-workflow-practices
description: >
  Guidance for executing and validating tests in the Elia workspace,
  covering prerequisite setup, file targeting, and payload requirements
  to avoid common initialization and submission failures.
---
# Test Workflow Practices

## Prerequisites and Setup
Ensure the dev server is running before executing `bun test`. Run `bun run typecheck` on autopilot integration tests to avoid hidden property access errors. Set `ANTHROPIC_API_KEY` or `ELIA_API_KEY` before importing modules that resolve providers at import time, such as `config.ts`.

## Test Execution
Check the shared blackboard for existing test results before investigating failures. Target specific test files like `src/config.test.ts` directly, as running tests without a specific pattern may fail due to missing provider initialization.

## Validation and Initialization
Verify test files like `src/ui/workspacePanel.test.ts` initialize without side effects before relying on their exit codes. Address initialization failures in these files before relying on test results, as they may block test execution even if other tests pass.

## Environment Readiness
When inspecting Rust test skipping logic, read `src/autonomy/envReadiness.test.ts` instead of `src/evolve/envReadiness.test.ts`. Ensure Rust tests in `envReadiness.test.ts` use conditional skipping via `hasCargo` (Bun.which('cargo')) and `maybeCargo` (test or test.skip) to prevent failures on systems without cargo.

## Submission Requirements
When calling `submit_verdict`, ensure at least one issue is included in the payload to avoid immediate failure. When calling `submit_acceptance`, include a verdict for every acceptance criterion in the payload, even those that are satisfied, as the command fails immediately if any criterion lacks a verdict.
