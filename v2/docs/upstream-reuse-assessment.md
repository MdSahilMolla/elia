# Upstream Codex and Claude Code Reuse Assessment

**Status:** Engineering and provenance decision record
**Reviewed:** 2026-08-24
**Elia baseline:** `manus` at `211eeb402927210e9f5154cabbb110d176114f93`
**Codex revision inspected:** `2df67054232090af8d2fa197c46b994bc2b0dda1`

> This document is an engineering and provenance assessment, not legal advice. A qualified license review is required before distributing a derivative product that vendors third-party source or binaries.

## Executive decision

Elia should **not** wholesale-copy or embed the Codex Rust engine into its Bun/TypeScript runtime, and it must **not** copy the Claude Code runtime or other Anthropic source that is covered by the public repository’s all-rights-reserved/commercial terms. The highest-value compatible path is to preserve Elia’s existing autonomous core and add only narrow boundaries: protocol-compatible optional adapters where a stable external protocol is documented, plus clean-room implementations of behavior that Elia already needs.

Codex source is Apache-2.0 licensed and can be reused directly in a carefully isolated component, but direct reuse would create obligations and operational cost. Any copied Codex file would need the Apache license, relevant copyright and attribution notices, a readable copy of the Codex NOTICE content, prominent notices on modified files, and a dependency/license audit. OpenAI and Codex names must not be used as Elia branding beyond truthful descriptive attribution. Claude Code source is not classified as reusable source under this assessment.

No Codex or Claude Code source has been copied into Elia as part of this review. The local `/home/ubuntu/codex-upstream` checkout is inspection-only and is not an Elia dependency.

## Source and license record

| Upstream | Revision or reference | License status | Elia disposition |
|---|---|---|---|
| [OpenAI Codex repository][1] | `2df67054232090af8d2fa197c46b994bc2b0dda1` | Apache License 2.0; repository includes `LICENSE` and `NOTICE` | **Conditionally reusable** with provenance, attribution, dependency, and trademark controls |
| [Codex LICENSE][2] | Apache 2.0, copyright 2025 OpenAI | Requires license and attribution retention, modified-file notices, and NOTICE propagation where applicable | **Mandatory if source is copied** |
| [Codex NOTICE][3] | OpenAI Codex attribution plus Ratatui MIT attribution | Must remain readable in a distributed derivative where applicable | **Mandatory if relevant Codex code is copied** |
| [Anthropic Claude Code repository][4] | Public `main` materials inspected | Public `LICENSE.md` says © Anthropic PBC, all rights reserved, subject to Commercial Terms of Service | **Prohibited for direct runtime/source copying absent separate permission** |
| [Claude Code license][5] | Current public repository license page | Not an OSI-style permissive source license for the runtime | **Study concepts only; independently reimplement** |

## Candidate classification

The classification below is deliberately conservative. “Direct Apache reuse” means source would be copied or vendored and therefore requires an explicit provenance record for the exact file and revision. “Protocol-compatible adapter” means Elia communicates with an independently built or separately installed process through a documented interface, without importing its implementation. “Clean-room reimplementation” means Elia authors its own implementation from behavior-level requirements and public concepts, without copying protected expression. “Prohibited” means the current public terms do not authorize the proposed use.

| Candidate | Relevant behavior | Classification | Decision and constraints |
|---|---|---|---|
| Codex `command_canonicalization.rs` | Stable command identity for approval-cache matching; distinguishes simple shell commands from complex scripts | **Clean-room reimplementation candidate** | Implement only the behavior Elia needs inside its own governor/action-ledger model. Direct copying is unnecessary unless a future license review selects this exact file. |
| Codex `permissions_toml.rs` and related permission profiles | Typed profiles, inheritance, cycle detection, workspace roots, filesystem and network permissions | **Clean-room reimplementation candidate** | Elia’s action assessments and contracts already provide the relevant boundary. Add profile inheritance only if a product requirement justifies it; do not port the Rust/TOML implementation wholesale. |
| Codex `exec_policy.rs` | Layered policy rules, deterministic rejection reasons, prefix matching, approval requirements | **Clean-room reimplementation candidate** | Preserve Elia’s governor as the authority. Any new rule evaluator must remain subordinate to Elia’s approval, unattended blocking, receipts, and audit semantics. |
| Codex `exec.rs` and sandbox crates | Process execution, cancellation, output caps, process-group termination, platform sandboxing | **Protocol-compatible adapter or separate service** | Do not embed the Rust sandbox engine in the Bun process. If stronger OS isolation is required, use a separately built and pinned helper with an explicit IPC contract, capability reduction, and independent security review. |
| Codex app-server protocol | Thread/turn lifecycle, streaming events, interrupt/steer, review and approval messages | **Protocol-compatible adapter** | Candidate for an optional coding backend only after pinning a protocol version, defining lifecycle/timeout/error translation, and ensuring Elia’s governor remains authoritative for side effects. |
| Codex MCP catalog/connection manager | External tool discovery, connection lifecycle, resource and elicitation handling | **Protocol-compatible adapter / clean-room boundary** | Prefer Elia’s existing tool registry and connector governance. Add an MCP bridge only as an isolated connector with capability discovery, timeout, redaction, and per-action authorization. |
| Codex plugin/skill manifests | Discoverable capabilities and installable extensions | **Clean-room reimplementation** | Elia already loads synthesized and user-provided skills. Reuse the product concept, not upstream code or branding. |
| Claude Code runtime and internal agent implementation | Agentic coding execution and orchestration | **Prohibited** | Do not copy, vendor, translate, or link against the runtime under the current public license terms. |
| Claude Code feature-development plugin | Clarification, discovery, architecture, implementation, review workflow | **Clean-room reimplementation** | Elia can express the behavior through its goal graph, proposal contracts, personas, delegation, verification, and review stages. Do not reproduce source wording or file contents. |
| Claude Code settings and hook examples | Deny/ask permissions, managed rules/hooks, pre-tool validators | **Clean-room reimplementation** | Elia already has governed tools and action contracts. Adopt only independently authored equivalents that preserve Elia’s stronger durable evidence and approval semantics. |

## Mapping onto Elia

Elia already contains the control-plane primitives that the upstream projects expose in more local or product-specific forms. The integration goal is therefore not to replace Elia’s core, but to make any optional upstream-compatible path subordinate to the same governance and recovery rules.

| Capability boundary | Elia authority | Codex concept that informs the boundary | Required invariant |
|---|---|---|---|
| Command identity and approval caching | `src/autonomy/governor.ts`, action audit/ledger code | Command canonicalization and deterministic policy matching | Approval identity must be stable without weakening exact-scope authorization; complex scripts must not be over-generalized. |
| Shell execution | `src/shell.ts`, `src/tools/runCommand.ts` | Bounded output, timeout/cancellation outcome, process-group termination, I/O-drain protection | Every invocation remains deadline-bound, output-capped, cancellable, and receipt-producing. |
| Action preconditions/postconditions | `src/autonomy/actionContract.ts` | Explicit execution requirements and post-execution evidence | Missing environment or verification evidence is a blocked/failed contract, not implicit success. |
| Approvals and unattended mode | `src/autonomy/governor.ts`, `src/autonomy/goalGraph.ts` | Granular approval-policy conflict handling | Unattended mode may not authorize critical external side effects; user takeover and exact approvals remain explicit. |
| Durable lifecycle | `src/autonomy/goalGraph.ts`, `src/autonomy/scheduler.ts`, `src/autonomy/daemon.ts` | Codex thread/turn lifecycle and interrupt/steer semantics | Resume, stale-lease recovery, cancellation, and receipts must remain durable across process boundaries. |
| Delegated coding work | `src/autonomy/fleet.ts`, `proposal.ts`, `variants.ts`, `worktree.ts` | Codex agent/session and worktree execution ideas | File ownership, dependency waves, isolated worktrees, and objective verification remain Elia-controlled. |
| External tools and connectors | `src/tools/registry.ts`, browser/communication modules | Codex MCP catalog and connection manager | External capabilities are opt-in, discoverable, redacted, deadline-bound, and governed per action. |
| Skills and workflows | Elia skill loading and synthesized tool registry | Claude feature-dev/plugin concepts | Skills may add capability but must not silently change safety policy or authorize side effects. |

## Phase-three selection

For the first implementation, Elia will add one small **clean-room command-identity utility** inspired by the behavior observed in Codex's approval canonicalization. It will normalize only explicitly recognized system shell-wrapper paths for durable action-key stability, while preserving the exact command/script text and leaving Elia's governor, shell execution, approval decisions, and raw model messages unchanged. This is selected because it is local, testable, low-risk, and directly compatible with Elia's existing `actionKey` replay/approval boundary.

An optional Codex app-server adapter remains a later candidate, not part of this change. It requires a pinned protocol version, a trusted executable or endpoint policy, lifecycle and event translation, process isolation, authentication handling, version compatibility tests, and a clear failure/rollback path. No Claude Code source or runtime will be integrated.

## Recommended integration boundary

The smallest high-value integration is an **optional Codex-compatible backend adapter**, not a copied Codex runtime. It would be disabled unless an operator explicitly configures a trusted Codex executable or app-server endpoint. The adapter would translate Elia’s task/session lifecycle into the selected protocol and translate streamed events back into Elia’s model/tool/event types. It would never bypass Elia’s governor, action contracts, worktree ownership, output limits, credential policy, or durable receipts.

The selected clean-room command-identity utility is implemented in `src/autonomy/commandIdentity.ts` and integrated into `src/autonomy/goalGraph.ts`. Its tests cover recognized POSIX and PowerShell wrapper paths, exact complex-script preservation, mode separation, unknown executable paths, and durable action-key replay. The utility changes only the durable identity used for replay/approval matching; Elia still stores the raw input digest and executes the original command unchanged. This does not copy Codex source and does not create a third-party license obligation.

Full Rust engine embedding is rejected at this stage. It would add a second execution runtime, cross-platform sandbox complexity, a large transitive dependency graph, separate release and vulnerability-management obligations, and a difficult boundary for Elia’s durable leases and receipts. A helper process could be revisited later if an isolated sandbox requirement cannot be met by the host platform and the helper contract is independently reviewed.

## Direct-reuse procedure if later approved

If a future change selects a Codex Apache component for direct source reuse, the change must satisfy all of the following before merge:

1. Record the exact upstream repository, commit, path, license, copyright holder, and reason for selecting the file.
2. Copy the Apache-2.0 license text and the relevant Codex NOTICE attribution into an Elia third-party attribution location, such as `third_party/` and `THIRD_PARTY.md`.
3. Add a prominent changed-file notice to every modified copied file, retaining upstream copyright and attribution notices.
4. Audit the copied file’s imports and transitive dependencies; do not assume the top-level license covers all dependency code.
5. Keep OpenAI/Codex marks descriptive and avoid product branding that implies endorsement or affiliation.
6. Add focused tests, security review notes, and a rollback path. Confirm that copied behavior cannot bypass Elia’s governor or expose secrets.
7. Run typecheck, the complete Bun test suite, `git diff --check`, package/license checks, and any adapter protocol compatibility tests before pushing.

No Claude Code source may enter this procedure unless Anthropic provides separate written permission or a clearly applicable license change is independently verified.

## Implementation record

This change adds no `third_party/` vendor tree, no Rust runtime, no Codex binary, no Claude Code source, and no new package dependency. The only implementation is an independently authored TypeScript utility and its regression tests. It preserves Elia’s raw model behavior, governor decisions, action contracts, execution path, and receipts. A future direct Codex source reuse would require the procedure above and must be reviewed separately.

## Outcome

The direct answer is **“yes, selectively for Codex; no for Claude Code’s runtime.”** Codex’s Apache-licensed source can legally permit reuse when all obligations are met, but the current Elia architecture makes a protocol adapter or clean-room equivalent more maintainable and safer than wholesale copying. Claude Code’s public repository is useful for studying high-level workflow patterns and extension concepts, but its runtime/source is not directly reusable under the current all-rights-reserved/commercial terms.

## References

[1]: https://github.com/openai/codex "OpenAI Codex repository"
[2]: https://github.com/openai/codex/blob/main/LICENSE "OpenAI Codex Apache License 2.0"
[3]: https://github.com/openai/codex/blob/main/NOTICE "OpenAI Codex NOTICE"
[4]: https://github.com/anthropics/claude-code "Anthropic Claude Code repository"
[5]: https://github.com/anthropics/claude-code/blob/main/LICENSE.md "Anthropic Claude Code license"
[6]: https://github.com/anthropics/claude-code/blob/main/plugins/feature-dev/commands/feature-dev.md "Claude Code feature development plugin"
[7]: https://github.com/anthropics/claude-code/blob/main/examples/settings/settings-strict.json "Claude Code strict settings example"
[8]: https://github.com/anthropics/claude-code/blob/main/examples/hooks/bash_command_validator_example.py "Claude Code Bash validator hook example"
