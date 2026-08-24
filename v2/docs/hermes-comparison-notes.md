# Hermes Agent comparison and clean-room integration plan

## Source and license

The official [NousResearch Hermes Agent repository](https://github.com/NousResearch/hermes-agent) is marked MIT licensed, with the license text in its repository [`LICENSE`](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE). Its README and architecture documentation describe a Python agent with a terminal TUI, messaging gateway, persistent memory and session search, skills, scheduled automations, parallel subagents, MCP, and multiple terminal backends.

This document records an engineering decision, not legal advice. The MIT license permits selective source reuse when the copyright and permission notice are retained, but every copied file and bundled dependency still requires provenance and license review. No Hermes source is copied in this integration.

## Capability map

| Hermes concept | Elia v2 status | Decision |
|---|---|---|
| Agent loop and provider resolution | Elia already has a raw-model provider loop, dynamic model routing, fallback, bounded retries, cancellation, usage accounting, and prompt compaction. | Do not duplicate the Python runtime. |
| Persistent memory and session search | Elia already has project lessons, durable run journals, checkpoints, receipts, and the `recall` tool with ranked historical episodes and file snapshots. | Keep Elia’s existing stores; improve only if a concrete gap appears. |
| Scheduled autonomous jobs | Elia already has a durable scheduler with claims, leases, recovery, profiles, action budgets, and run receipts. | Do not port Hermes cron. |
| Pre-tool hooks and approvals | Elia now has clean-room dev-mode declarative hooks plus its existing governor, action contracts, and durable approvals. | Extend only with narrowly bounded validators. |
| Skills and progressive discovery | Elia has user/project `*.skill.ts` modules, validation, quarantine, synthesized tools, and `@skills` selection. It lacks external skill-directory discovery and declarative bundles. | Implement external directories and bundles with explicit configuration and deterministic selection. |
| Messaging gateway and multi-platform delivery | Elia has governed browser/communication tools and connector-aware delivery but does not ship a Hermes-style multi-platform gateway. | Keep the safer adapter boundary; do not import the gateway runtime. |
| Terminal backends | Elia has bounded local shell execution and git worktree variants. Hermes has Docker/SSH/serverless backends. | Defer backend ports until a concrete host/isolation requirement exists. |
| TUI and interruption | Elia already has a native streaming CLI, slash commands, cancellation, task sessions, and run controls. | Improve only from observed UX gaps. |

## Selected implementation

The next integration adds two configuration-only skill capabilities in Elia’s existing TypeScript loader. `ELIA_SKILL_DIRS` permits an operator to expose explicitly selected shared skill directories, and `.elia/skill-bundles.json` lets an operator name a small group of already-loaded skills as a single selection. External directories are lower precedence than user and project skills, and project skills remain the highest-precedence local source. Bundles expand only selection names; they do not alter prompts, execute code, or bypass tool/governance checks.

Both features are bounded, deterministic, and optional. When unset, Elia’s existing skill behavior is unchanged. Invalid bundle configuration fails closed at selection time, while invalid skill modules continue to use Elia’s existing quarantine path. The implementation is independently authored and uses no Hermes source.
