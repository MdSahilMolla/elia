# Elia General-Agent Capability Audit

## Executive assessment

Elia already has a strong coding-agent core: model/provider selection with automatic failover, a two-tier model cascade, role-typed sub-agents, parallel dependency waves, durable goal graphs, checkpoints and rewind, action governance, browser bridging, cyber engagement scaffolding, web search/fetch, spreadsheet reading and writing, deterministic data-science workflows, deterministic finance calculations, production-readiness audits, environment preflight, richer domain task sessions, structured completion confidence, autonomous execution profiles, verification, repair, lessons, and run receipts. It is not yet a complete general-purpose autonomous agent because external environment delivery, advanced statistical/financial modeling, and quality guarantees across non-coding work still require project-specific evidence and human review.

No honest system can guarantee that every possible task is flawless. The correct target is a **general execution substrate** with explicit capability discovery, domain playbooks, reversible planning, confirmation gates for consequential actions, durable recovery, and benchmark-backed quality thresholds.

## Current capability map

| Capability area | Current state | Main gap |
|---|---|---|
| Coding and debugging | Strong: read/write/edit, shell, tests, browser, task delegation, specialist engineering roles | Needs broader artifact workflows and stronger end-to-end acceptance checks |
| Production SaaS delivery | Production specialist plus read-only repository readiness audit for CI/CD, deploy manifests, migrations, observability, rollback, incident, and backup evidence | No proof of external-environment health or deployment success; production mutation remains governed and project-specific |
| Marketing | Existing persona with web research and writing tools | No reusable campaign/report artifact schemas |
| Finance | Finance specialist plus deterministic unit economics, runway, scenario, and DCF calculations with basis/date/source disclosures and sensitivity cases | No full 3-statement, LBO, accounting-policy, or licensed-adviser workflow; external financial data still needs source-specific integration |
| Business analysis | Partially covered by Finance and Tech | No explicit business-analyst persona for requirements, process, KPI, and decision analysis |
| Data analysis | Data specialist plus deterministic CSV/TSV/JSON/JSONL profiling, validation, grouped summaries, correlation, and linear regression with reproducibility limitations | No advanced statistical inference, causal analysis, experiment significance testing, visualization pipeline, or automated leakage detection |
| Cybersecurity | Cyber mode, engagement scope, security tools, security role, and governance exist | Needs broader defensive playbooks, evidence normalization, and safer reusable report outputs |
| Automation | Shell, browser bridge, task orchestration, autonomy profiles, and goal graphs exist | No unified workflow/action catalog or external event/communication adapter layer |
| Research | Web search/fetch and parallel scouts exist | Needs source registry, citation/provenance contract, and research deliverables |
| Browser/computer use | Browser bridge supports status, navigation, snapshot, extraction, click, type, press, and wait | A bridge must be configured; authenticated external actions need explicit user takeover/approval |
| Environment awareness | Read-only preflight reports project shape, git state, runtimes/CLIs, credential presence, and browser transport presence without exposing secret values | Snapshot can become stale; presence does not prove authorization, login, reachability, or health |
| Email/calendar/external parties | Connectors such as Gmail and Google Calendar are present but disabled in the current session; Elia has no native email tool | Requires user-enabled connectors or a trusted browser/bridge, with confirmation and audit trails |
| Completion truth | Completion assessor distinguishes verified, partial, blocked, failed, and aborted runs with evidence, blockers, confidence, and next actions | Subjective acceptance and external-world outcomes still need domain-specific postconditions or human review |
| Long-running autonomy | Durable goal graph, checkpoints, run receipts, repair attempts, profiles, structured completion states, and resume support exist | Needs stronger pause/resume semantics, external event delivery, and a persistent always-on worker |


## Proposed end-to-end architecture

1. **Capability registry.** Classify every task into one or more capabilities such as coding, finance, business analysis, data analysis, cybersecurity, research, browser operations, communication, automation, and document/spreadsheet work. The registry should expose required tools, risk level, preferred roles, output contracts, and verification checks.

2. **Plan-and-execute contract.** Every non-trivial task should produce a goal, assumptions, dependencies, execution waves, external side effects, acceptance criteria, and a recovery policy before execution. The existing proposal/goal-graph system is the foundation; the missing part is domain-aware output and verification metadata.

3. **Specialist playbooks.** Add explicit business, data, research, communications, automation, and defensive-cyber specialists while retaining the existing marketing, finance, tech, and engineering roles. Specialists should differ primarily by prompts, tool allowlists, output contracts, and verification—not by duplicated orchestration code.

4. **Action layer.** Keep deterministic actions in tools and use the model for interpretation, planning, and judgment. Browser, email, calendar, messaging, file, shell, spreadsheet, and API actions must pass through one policy layer that classifies sensitivity, requires exact confirmation for consequential effects, and records evidence.

5. **Quality layer.** Require domain-specific checks: formulas and assumptions for finance, source citations for research, schema and statistical checks for data, reproducible evidence for security, delivery confirmation for communication, and postcondition verification for browser/API actions.

6. **Recovery layer.** On failure, classify the failure as transient, authentication, permission, unavailable capability, invalid input, unsafe action, or logic defect. Retry only transient failures, switch providers when configured, pause for user input when credentials or approval are required, and resume from the last durable goal node without repeating completed external actions.

7. **Interaction layer.** Support both user-only collaboration and external-party workflows. The agent may draft and prepare communication autonomously, but sending, publishing, purchasing, deleting, or changing account state requires explicit approval immediately before the exact action. Login, CAPTCHA, payment, and sensitive-input steps require user takeover.

## Priority order

| Priority | Deliverable | Why first |
|---|---|---|
| P0 | Capability registry and specialist routing | Makes the broad agent surface discoverable and prevents every task from being treated as generic coding |

| P0 | Unified action policy and external-action audit events | Required before email, browser, calendar, or messaging can be safely used end to end |
| P1 | Advanced business, data, research, communications, and automation playbooks | Expands domain-specific verification beyond the current bounded workflows |
| P1 | Output contracts and domain verification | Converts plausible prose into verifiable work products |
| P1 | Task state, pause/resume, user-interaction requests, and delivery receipts | Makes long-running delegated work reliable |
| P2 | Connectors and browser/email/calendar workflows | Depends on enabled user integrations and should not silently guess accounts or recipients |
| P2 | Benchmark suite across all capability families | Measures accuracy, speed, recovery, and safety instead of relying on claims |

## Definition of done for a reliable general agent

A capability is considered delivered only when Elia can discover it, plan it, execute it with the right tools, verify its postconditions, pause for missing user input or approval, resume without duplicating completed actions, and emit an evidence-backed result. “Best” should be evaluated by task success rate, factual/source accuracy, external-action safety, median time to completion, recovery rate, and reproducibility—not by a claim of universal flawlessness.

## External reference notes

OpenAI's official ChatGPT agent description emphasizes a unified system combining visual browser interaction, text web access, terminal/API access, research, artifacts, user interruption, connectors, and scheduled tasks. It also emphasizes confirmation before consequential actions, active supervision for sensitive workflows, takeover for login or sensitive input, prompt-injection defenses, and explicit limitations: https://openai.com/index/introducing-chatgpt-agent/.

OpenAI's Operator description reinforces that computer-use agents need screenshot/GUI interaction, user takeover for login/payment/CAPTCHA, confirmation before sending or submitting, refusal of high-stakes or sensitive tasks, prompt-injection defenses, and monitoring: https://openai.com/index/introducing-operator/.

Manus describes its general-purpose agent direction as research, automation, and complex end-to-end tasks, with an execution layer intended to make advanced AI capabilities reliable and scalable in real-world settings: https://manus.im/blog/manus-joins-meta-for-next-era-of-innovation.
