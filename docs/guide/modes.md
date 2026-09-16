# Modes and specialists

[← Back to the README](../../README.md)

## Dev mode

Elia’s default general-purpose coding mode is called **dev mode**. It covers building, debugging, refactoring, testing, software operations, browser work, and task delegation. Start it explicitly with `elia --dev`, or switch back to it interactively with `/dev`. The old `/normal` command remains accepted as a compatibility alias but is not shown in command completion.

Dev mode is separate from execution policy: manual policy asks before risky actions, while auto policy skips preliminary risk checks but keeps governed irreversible actions behind explicit approval unless unattended execution has been explicitly requested.

## Dev-mode project hooks

Dev mode can load optional declarative validators from `.elia/dev-hooks.json`, or from the `ELIA_DEV_HOOKS` environment variable. Hooks can block a matching tool request with a static explanation, which is useful for repository conventions such as preferring `rg`, requiring a project-specific command, or disallowing browser mutations in an unsupervised workflow. They match only an exact tool name and/or a literal substring in the tool input; they cannot execute scripts, load modules, call URLs, grant approvals, or override the autonomy governor.

```json
[
  {
    "id": "prefer-rg",
    "tool": "run_command",
    "inputContains": "grep ",
    "message": "Use rg instead of grep for repository searches."
  }
]
```

Malformed or oversized hook configuration fails closed. Hooks are inherited by delegated workers and autonomous repair passes in dev mode, but they are not loaded in Cybersecurity, Sports, or Fitness modes.

## Specialist modes and capability contracts

Elia routes requests across explicit specialist modes: **Sports**, **Fitness**, **Marketing**, **Finance**, **Business Analyst**, **Data Analyst**, **Research**, **Cybersecurity**, **Automation**, **Communications**, **AI/ML**, **Production Engineering**, and **Tech**. Automatic routing is available through `elia agent "<request>"`; interactive sessions can pin a specialist with `/sports`, `/fitness`, `/marketing`, `/finance`, `/business`, `/data`, `/research`, `/cybersecurity`, `/automation`, `/communications`, `/ai`, `/production`, or `/tech`. `/sports` and `/fitness` are also true operating modes, so their system prompts and delegated workers inherit the selected domain. Use `/capabilities` to inspect each mode’s risk class, preferred tools, and required output contract.

Each specialist must separate facts, assumptions, recommendations, and unknowns. Finance and cybersecurity work require explicit assumptions or authorized scope; data work requires quality checks and reproducibility; research requires sources and citations; Sports work must separate supplied facts from metrics, estimates, and opinion; Fitness work must remain conservative and non-medical; communications and automation require exact approval immediately before consequential external actions.

## Sports mode and Fitness mode

Sports mode supports evidence-aware match and opponent analysis, scouting, athlete or player comparisons, performance metrics, league and tournament research, event operations, fan engagement, sponsorship analysis, and sports-business workflows. Its deterministic `sports` tool can summarize team-match rows, rank players by a supplied metric, and validate structured sports data. It never fetches or invents scores, rankings, injuries, contracts, or predictions; current external facts require configured research tools and source verification.

Fitness mode supports sustainable goal setting, workout organization, strength and conditioning basics, mobility, cardio, habit tracking, recovery reflection, sleep and activity summaries, and conservative plan adaptation. Its deterministic `fitness` tool can create a bounded generic weekly template, summarize supplied activity logs, and validate tracking rows. It is not a doctor, physiotherapist, dietitian, or emergency service: it does not diagnose, prescribe treatment, guarantee results, or infer health conditions from wearable data. Pain, injury, concerning symptoms, eating-disorder concerns, pregnancy-related questions, and medical conditions require qualified professional guidance.

## Battmann strategic-intelligence mode

Start with `elia --battmann`, switch with `/mode battmann`, or run governed autonomy with `elia auto --battmann "<goal>"`. Battmann produces evidence-backed strategic briefs across trade, geopolitics, financial markets, supply chains, policy, and commodities. Every turn is anchored to the real wall-clock date, so "what happens next" questions re-confirm the current situation from recent primary reporting before analysis rather than answering from a stale mental model; `web_search` takes `recencyDays` for a clock-derived freshness window, and each brief states the as-of date of its newest source. Its workspace-local SQLite system of record defaults to `.elia/battmann.sqlite` and preserves evidence, claim-level excerpts and reviews, resolvable questions, immutable forecast revisions, accepted/disputed resolution events, versioned ontology objects, links, scenarios, decisions, outcomes, benchmark runs, datasets with lineage, action proposals, geolocated events, deployment stages, and a hash-chained audit log.

The deterministic `battmann` tool supports dependence-aware evidence updates and ensembles, Brier score/log loss/calibration diagnostics, chronological domain/base-rate benchmarks, and as-of-safe reports. Observed ledger timestamps cannot be future-dated; future forecast and scenario horizons remain valid. Live scoring excludes forecasts not physically recorded before accepted resolution; historical replays must use `forecastClass: "backtest"` and cannot support a live-superiority claim. A final system-backed report fails closed until every included claim has a supported review; draft reports surface unresolved reviews. `report_from_store` writes Markdown, machine-readable JSON, and printable HTML. Use an output such as `.elia/artifacts/risk-brief.md` to expose all three companions in Elia's artifact panel.

Four analytic primitives turn the ledger into decision support without ever inventing a number:

- **`risk_assessment`** — a 0-100 score from dated, sourced, weighted factors. Correlated factors are averaged within an independence group so repeated coverage of one driver does not compound the score; the output carries each factor's contribution, a confidence level, a leave-one-group-out sensitivity, and a direction of travel from the supplied factor momentum.
- **`consequence_chain`** — annotates a tree of first-, second-, and third-order consequences. Each edge carries `P(effect | cause)`; the tool returns the path probability to every node, the dominant path, the weakest link, and the deep low-probability tail risks.
- **`find_path` / `object_detail` / `list_objects`** — traverse the evidence-linked ontology built with `upsert_object`/`link_objects`. `find_path` enumerates the bounded dependency paths between two entities (a chokepoint two hops from the client, a tier-2 supplier owned by a sanctioned entity), respecting each link's validity window.
- **`explain_causality`** — a deterministic provenance trace: the upstream contribution paths behind a target entity's risk, scored by link confidence and per-hop decay, with the weakest edge and the evidence gaps on each path named explicitly. It is a static structural trace, not a dynamical propagation model.

The mode is shaped like Palantir's four pillars, at CLI scale:

- **Foundry** — the evidence-linked ontology, plus `register_dataset` / `dataset_lineage` for a hash-chained provenance graph, and a writeback engine (`define_action` → `propose_action` → `decide_action_proposal`). A proposal records an intent and executes nothing; the human decision is a separate signed record and any real side effect is still governed at the tool boundary.
- **Gotham / Maven** — `register_geo_event`, `geo_query` (radius search around a coordinate or a geolocated object), and `situation_snapshot` (a categorised common operating picture with the objects under active geo-pressure). Built only from registered events — there are no live sensor feeds.
- **AIP** — the agent is the reasoning layer, calling the deterministic tools rather than computing numbers itself. Every record carries a `securityClassification` (`public`/`internal`/`confidential`/`restricted`); a read that passes a lower `clearance` withholds classified records and redacts paths through them in `find_path` and `explain_causality`.
- **Apollo** — `define_deployment_target` and `stage_deployment` produce constraint-checked, versioned manifests under `.elia/artifacts/deploy/` (classification ≤ target maximum, required formats present, SHA-256 per file). Transmitting a bundle is a separate step that needs explicit approval.

Every write to the store appends to a tamper-evident `audit_trail` — an actor-stamped SHA-256 hash chain that `audit_trail` re-verifies on read.

Two domains get dedicated primitives:

- **Financial / economic** — `exposure_assessment` aggregates sourced FX / rate / commodity / credit / geographic exposures into a diversified scenario loss: exposures in one independence group add, groups combine by root-sum-of-squares, and an HHI reports concentration. It is a deterministic scenario loss, not a value-at-risk. `define_indicator` / `record_indicator_reading` / `indicator_series` keep a dated macro-indicator ledger with change, trend, and a z-score against the indicator's own history. (The general [`finance`](../../src/tools/finance.ts) tool remains for corporate DCF and runway.)
- **Defence / security** — `posture_assessment` computes a sourced correlation-of-forces balance between two actors per capability category (a quality-weighted bean-count, explicitly not an operational outcome model); `effector_pairing` runs a deterministic priority-ordered threat-to-effector assignment and names the coverage gaps.
- **Alternatives** — `alternatives` ranks sourced substitutes (suppliers, routes, sources) across weighted, min-max-normalised criteria, with a per-criterion breakdown, an incumbent comparison, and a drop-one-criterion stability check.

`dashboard` renders the entire store as one picture — a derived alert strip (rising forecasts, high-severity events, indicator outliers, live scenarios, review backlog), open questions with their latest probability and revision trend, scenarios, macro indicators with trend and z-score, the geospatial common operating picture, pending action proposals, and the forecast track record — written to `.elia/artifacts/` as **HTML, JSON, and Markdown** so it opens in Elia's workspace panel. It is refreshed on demand from stored, dated, sourced records; it is not a live feed.

These controls make forecasts reproducible and harder to contaminate; they do not establish that Battmann is universally more accurate than external forecasting systems. That requires a large independently resolved live sample, a frozen evaluation protocol, competitive baselines, and external review. SQLite is a local single-workspace store; the classification labels and clearance filter are workspace-level metadata, not enterprise access control, and the deployment actions stage bundles without transmitting them.

Recurring intelligence runs preserve the mode: `elia schedule add --mode battmann --every 6h "refresh the supply-chain risk brief"`. The daemon is local and runs only while its host is online.

## Cybersecurity mode

Start with `elia --cyber` or switch with `/mode cyber`. Cyber mode is for **authorized** security testing, CTF, vulnerability research, and defensive hardening — it acts only against systems the user owns or has written authorization to test, and refuses destructive techniques, denial-of-service, opportunistic scanning of third-party infrastructure, and detection-evasion tooling built for malicious use.

Work is organised around an **engagement** — a `workspace/engagements/<slug>/` folder scaffolded by `new_engagement` with a `SCOPE.md` authorization record that every downstream action stays inside:

- **`run_security_tool`** runs any installed scanner (nmap, nuclei, sqlmap, gobuster, …) for a scaffolded engagement and saves the raw output under `recon/`.
- **`http_probe`** sends one HTTP request to an in-scope target and records the full request/response pair to `recon/traffic.jsonl`. The target host must appear in `SCOPE.md` — hostnames, IPs, and IPv4 CIDR ranges are matched, and an out-of-scope host is refused.
- **`log_finding`** records a confirmed finding and *requires evidence*: one or more files under `recon/` that actually exist. A claim with no tool output behind it is rejected — a finding cites a file or it does not get logged. Findings land in `findings.jsonl` and `findings.md`.
- **`engagement_report`** compiles `report.md` from the logged findings, ordered by severity, with an excerpt of each finding's evidence embedded for reproducibility. Any finding whose evidence file has since gone missing is flagged and the report is marked a **draft**.

`http_probe` and `run_security_tool` reach a live target, so they are critical actions that need an authorization boundary; in unattended mode they are blocked, while `log_finding` (a workspace-local write) is not. Recurring authorized re-tests preserve the mode: `elia schedule add --mode cyber --every 6h "re-run recon for the acme-webapp engagement"`.

## Web research providers

`web_search` is available in every Elia mode and normalizes Exa, Serper, and Brave results into one dated source format. Set `ELIA_SEARCH_PROVIDER=auto` and one or more of `EXA_API_KEY`, `SERPER_API_KEY`, or `ELIA_SEARCH_API_KEY` (Brave). Auto selection prefers Exa, then Serper, then Brave. A returned snippet is discovery evidence, not proof; agents should fetch and inspect material primary sources before relying on a claim.

Use `/capabilities` inside a session to inspect the live registry of specialist domains, risk classes, preferred tools, and output contracts.

## Coding language and framework support

Elia’s Tech specialist is compatible with projects built in **Python**, **TypeScript/JavaScript**, **Bun**, and **React/TSX**, including common adjacent tooling such as Vite, Next.js, pytest, npm, pnpm, and project-specific scripts. Compatibility means Elia can inspect the project, edit source and configuration, run the declared commands, debug failures, and verify the result; it does not require the target project to use Elia’s own Bun stack.

| Stack | Project signals Elia detects | Typical verification |
|---|---|---|
| Python | `pyproject.toml`, `requirements.txt`, `setup.cfg`, virtual-environment metadata, `.py` files | pytest, project scripts, type/lint tools such as mypy or ruff when declared |
| TypeScript/JavaScript | `package.json`, `tsconfig.json`, `.ts`/`.tsx`/`.js` files | package-manager test, typecheck, lint, and build scripts |
| Bun | `bunfig.toml`, Bun lockfiles, Bun package scripts, `bun test`/`bun run` commands | Bun tests, scripts, typecheck, and build commands |
| React/TSX | React dependencies, `.jsx`/`.tsx`, Vite/Next configuration, component and route structure | project test, typecheck, lint, and production build scripts |

Elia uses the target project’s existing package manager and conventions rather than assuming one toolchain. Before coding in an unfamiliar repository, the Tech agent can use the deterministic `project_profile` tool to report detected stacks, package manager, manifest signals, and declared verification commands. It can work across these stacks in one delegated task, for example updating a Python API, a TypeScript service, and a React client in separate dependency-aware steps, then running the relevant verification for each. `run_command` accepts a workspace-confined `cwd`, so Windows projects do not need fragile `cd`, `cmd /c`, or nested PowerShell composition. Its managed background mode returns success only after bounded startup output proves readiness and registers the process for cancellation and shutdown cleanup.
