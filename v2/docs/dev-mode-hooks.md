# Development-mode tool hooks

Elia supports optional, **development-mode-only** tool hooks for repository-specific validators. The feature is a clean-room implementation of a general pre-tool validation concept observed in public coding-agent workflows; it does not copy upstream source or runtime code.

Hooks are supplementary policy. They can block a matching action and explain how to proceed, but they can never grant permission, bypass the autonomy governor, bypass action contracts, authorize external side effects, or change the command that Elia executes. Hooks are applied before precondition and governor evaluation, and a blocked action is returned to the model as an ordinary tool error so it can correct the plan.

## Configuration

Create `.elia/dev-hooks.json` in the project root, or set `ELIA_DEV_HOOKS` to a JSON array. The environment variable takes precedence over the project file. The configuration is read only for `dev` mode; `cyber`, `sports`, and `fitness` modes do not load it.

Each hook is declarative and has this shape:

```json
[
  {
    "id": "prefer-rg",
    "tool": "run_command",
    "inputContains": "grep ",
    "message": "Use rg instead of grep for repository searches."
  },
  {
    "id": "no-browser-mutations",
    "tool": "browser",
    "message": "Browser mutations require a supervised turn."
  }
]
```

A hook may match an exact tool name, a literal substring in the stable JSON representation of the tool input, or both. At least one matcher is required. Matching is literal rather than regular-expression-based, which keeps configuration predictable and avoids executing user-supplied code. A hook cannot name a script, module, URL, shell command, or executable.

The configuration is bounded to 32 hooks. Hook identifiers are limited to 80 characters, literal matchers to 2,000 characters, and messages to 500 characters. Duplicate identifiers, malformed JSON, oversized values, or hooks without a matcher fail closed before the dev run starts.

## Execution and inheritance

Direct `dev` turns load the hooks around the agent loop. Autonomous development runs load them around the complete run, so delegated workers and repair passes inherit the same hook context through Elia’s async execution boundary. This keeps the policy consistent across the lead, fleet, and nested child workers.

A hook block is recorded as an authorization-class action failure when an autonomous goal graph is active. It does not create an approval that can be used to override the hook. The operator can change the project configuration and start a new or resumed run under the corrected policy. Existing action reservations, leases, raw input digests, and receipts remain durable.

## Relationship to Elia’s safety model

Hooks are not a sandbox. They are an additional application-level validator that sits before the existing layers:

| Layer | Responsibility | Can a dev hook bypass it? |
|---|---|---:|
| Tool hook | Project-specific literal validation and blocking | No |
| Action contract | Preconditions, postconditions, retry disposition, takeover requirement | No |
| Autonomy governor | Risk classification, unattended blocking, exact approval boundary | No |
| Goal graph | Idempotency, leases, durable approvals, evidence, recovery | No |
| Tool implementation | Workspace paths, timeouts, browser/communication controls, output bounds | No |

The hook implementation does not modify system prompts or model requests. It does not replace the selected model, insert a personality wrapper, or alter raw model output. It only adds an optional deterministic gate around tool execution.

## Files and tests

The implementation is in `src/autonomy/devHooks.ts`. `src/agentLoop.ts` evaluates active hooks before action contracts and governor checks. `src/agent.ts` scopes hooks to direct development turns, and `src/autonomy/loop.ts` scopes them to autonomous development runs and inherited delegated workers. Coverage is provided by `src/autonomy/devHooks.test.ts` and the end-to-end case in `src/agentLoop.test.ts`.

The feature is intentionally optional. With no `.elia/dev-hooks.json` and no `ELIA_DEV_HOOKS`, Elia behaves as before. The existing governor, action contracts, worktree isolation, verification, reviewer restrictions, and external-side-effect approvals remain the authoritative safety controls.
