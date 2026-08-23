# Elia repository guidance

This file is a map for agents working in this repository. It is project guidance, not a replacement for the user’s request, system safety policy, or explicit approval boundaries.

## Source of truth

Read `README.md` for setup and CLI behavior. Read `docs/agent-capability-audit.md` for honest capability boundaries, `docs/general-agent-evaluation.md` for evaluation expectations, and `docs/production-readiness-audit.md` before making claims about delivery or deployment. Read the relevant source and tests before editing; do not infer behavior from documentation alone.

## Engineering workflow

Use the smallest coherent change that satisfies the request. Preserve TypeScript strictness and the existing ESM/Bun conventions. Run `NO_COLOR=1 ANTHROPIC_API_KEY=test-key-for-local-tests bun run typecheck` and the focused tests after changes, then run `NO_COLOR=1 ANTHROPIC_API_KEY=test-key-for-local-tests bun test` before delivery. Inspect `git diff` and run `git diff --check` before reporting completion.

For autonomous work, keep plans bounded and resumable. Use the durable goal graph, action governor, verification, review, receipts, and recovery paths. Never report success without postcondition evidence. Treat nested delegation, durable actions, approvals, and blocked budgets as part of completion truth.

## Safety boundaries

Never bypass authentication, CAPTCHA, paywalls, authorization, or security controls. Do not silently send messages, publish, purchase, transfer funds, change accounts or subscriptions, delete data, mutate production, or perform destructive or irreversible actions. Drafting or analysis is not execution. Ask for the exact approval required and record the outcome.

Browser access requires a configured and authorized transport. A local scheduler is not guaranteed 24/7 hosting. Provider, connector, and credential availability must be verified at runtime; do not claim an external action happened without evidence.

## Change boundaries

Avoid unrelated refactors and generated artifacts. Keep user data and secrets out of logs, receipts, prompts, and commits. If a proposed change would require kernel-level sandboxing, secure keyring integration, managed network policy, persistent hosting, or unrestricted browser control, document the limitation and implement only a safe adapter or explicit failure path unless the user provides the required environment.
