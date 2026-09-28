# Modes and specialists

[← Back to the README](../../README.md)

## Dev mode

Elia’s default general-purpose coding mode is called **dev mode**. It covers building, debugging, refactoring, testing, software operations, browser work, and task delegation. Start it explicitly with `elia --dev`, or switch back to it interactively with `/mode dev` (`/mode` alone opens a picker; `tech` is an alias for dev).

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

Elia routes requests across explicit specialist modes: **Sports**, **Fitness**, **Marketing**, **Finance**, **Business Analyst**, **Data Analyst**, **Research**, **Cybersecurity**, **Automation**, **Communications**, **AI/ML**, **Production Engineering**, and **Tech**. Automatic routing is available through `elia agent "<request>"`; interactive sessions can pin one with `/betamode <name>` — `sports`, `fitness`, `marketing`, `finance`, `business`, `data`, `research`, `cybersecurity`, `automation`, `communications`, `ai` or `production` (`/betamode` alone opens a picker) — and `/mode cyber` / `/mode battmann` switch the core modes. Sports and Fitness are also true operating modes, so their system prompts and delegated workers inherit the selected domain. Use `/capabilities` to inspect each mode’s risk class, preferred tools, and required output contract.

Each specialist must separate facts, assumptions, recommendations, and unknowns. Finance and cybersecurity work require explicit assumptions or authorized scope; data work requires quality checks and reproducibility; research requires sources and citations; Sports work must separate supplied facts from metrics, estimates, and opinion; Fitness work must remain conservative and non-medical; communications and automation require exact approval immediately before consequential external actions.

## Sports mode and Fitness mode

Sports mode supports evidence-aware match and opponent analysis, scouting, athlete or player comparisons, performance metrics, league and tournament research, event operations, fan engagement, sponsorship analysis, and sports-business workflows. Its deterministic `sports` tool can summarize team-match rows, rank players by a supplied metric, and validate structured sports data. It never fetches or invents scores, rankings, injuries, contracts, or predictions; current external facts require configured research tools and source verification.

Fitness mode supports sustainable goal setting, workout organization, strength and conditioning basics, mobility, cardio, habit tracking, recovery reflection, sleep and activity summaries, and conservative plan adaptation. Its deterministic `fitness` tool can create a bounded generic weekly template, summarize supplied activity logs, and validate tracking rows. It is not a doctor, physiotherapist, dietitian, or emergency service: it does not diagnose, prescribe treatment, guarantee results, or infer health conditions from wearable data. Pain, injury, concerning symptoms, eating-disorder concerns, pregnancy-related questions, and medical conditions require qualified professional guidance.

## Battmann strategic-intelligence mode

Start with `elia --battmann`, switch with `/mode battmann`, or run governed autonomy with `elia auto --battmann "<goal>"`. Battmann produces evidence-backed strategic briefs across trade, geopolitics, financial markets, supply chains, policy, and commodities, for the question every brief answers: what is happening, why, what may happen next, how likely it is, and what needs attention. Every turn is anchored to the real wall-clock date, so "what happens next" questions re-confirm the current situation from recent primary reporting first; each brief states the as-of date of its newest source.

Battmann's store is a workspace-local SQLite file (`.elia/battmann.sqlite` by default). It holds evidence, claims and reviews, resolvable questions with immutable forecast revisions, indicator readings, an evidence-linked ontology, scenarios, decisions and outcomes, datasets with lineage, action proposals, geolocated events, deployment bundles, and a hash-chained audit log.

### Real data feeds

Figures come from code, not from the model. The `battmann` tool's `feed_query` action fetches data from public sources, and `ingest_feed` fetches it and records it. `elia battmann pull` does the same from the command line:

| Feed | Source | What it gives | Key |
|---|---|---|---|
| `fx` | ECB euro reference rates, via Frankfurter | Daily exchange rates on business days; USD-based rates are cross rates of the ECB's EUR rates | none |
| `worldbank` | World Bank World Development Indicators API | Any WDI indicator by country and year | none |
| `imf` | IMF DataMapper (World Economic Outlook) | WEO indicators; values for the current year and later are labelled projections and never recorded as readings | none |
| `comtrade` | UN Comtrade | Trade value by reporter, partner and HS code, annual or monthly, with each partner's share of the world total. Taiwan appears as "Other Asia, nes" (partner 490), shown as `TWN` | none for the public preview (one period per call, 500 rows); `COMTRADE_API_KEY` for the full API |
| `gdelt` | GDELT DOC 2.0 API | Daily worldwide news volume and coverage share for a query, last 90 days. This measures attention, not events | none (GDELT allows one request per 5 seconds) |
| `commodity` | IMF Primary Commodity Price System (SDMX) | Monthly average prices or indices: crude oil (`POILAPSP`), Asian LNG (`PNGASJP`), copper (`PCOPP`), aluminium (`PALUM`), tin (`PTIN`), wheat, and others | none |
| `tariff` | World Bank WITS (UNCTAD TRAINS) | Applied tariffs by six-digit HS code: the simple average of reported ad valorem rates, MFN or for a partner. Schedules lag about two years, and a missing year is reported, not guessed | none |

`feed_query` records the fetched response as one evidence row and returns its `evidenceId`, so whatever the model looked at can be cited. `ingest_feed` also records every reading and subscribes. Data already recorded is faster to read with `indicator_series`. `supplier_concentration` reads the latest partner shares and HHI of every trade flow recorded by partner.

Hosts are fixed in code (`src/battmann/feeds.ts`). The model supplies validated parameters only, never a URL. Redirects are refused, responses are size-bounded, and API keys travel in headers, never in a recorded URL. A recorded figure carries its request URL, retrieval time and the SHA-256 of the raw response bytes, and its evidence row is marked `provenance: feed`. The dashboard marks each indicator as `feed` or `agent` accordingly.

The store is append-only. Re-pulling a feed adds only new observations. If the source has since revised a value, the pull reports it and keeps what was recorded. Every `ingest_feed` subscribes the request, and `elia battmann refresh` re-pulls every subscription with its window rolled forward to today.

### The certified track record

A forecast only means something if it is scored against an outcome, and against something simpler than itself. A question created with a `resolutionRule` works like this:

- **Resolved by code.** The rule names a feed series, the period or window that decides it, a comparator and a threshold. `resolve_due` (or `elia battmann refresh`) reads the value back from the source once it is published and records the resolution with `provenance: feed`. It never resolves early, and a missing value stays pending. The model cannot resolve or void such a question; only a person can void one, with `elia battmann void`.
- **Timestamped by the clock.** A certified question opens when it is recorded. Its forecasting cutoff comes from the rule: the start of a daily observation or of a month of commodity prices (both partly observable from their first day), or the end of an annual or monthly trade or indicator period. The clock stamps every forecast on it, so a supplied `asOf` cannot backdate one, and nothing is accepted after the cutoff. A forecast that cites no evidence gets the question's own feed series attached.
- **Scored against a baseline.** When the question opens, elia logs a statistical baseline as its own forecaster (`baseline`). For daily rates it uses a driftless random walk with volatility measured from recent returns. For annual and monthly totals it uses the empirical distribution of the series' own changes. Only elia can write the baseline; `scorecard` and `elia battmann record` report Battmann's Brier score, the baseline's, and skill against the baseline on the same questions. Below 30 matched questions the comparison is flagged as not yet meaningful.

Rules can read `fx`, `worldbank`, `comtrade`, `commodity` (one month's average) and `gdelt` (a window). IMF WEO values cannot resolve a question, because the current-year figures are projections that later editions revise.

### Operating it from the command line

These commands run without a model:

```bash
elia battmann seed india-semiconductors    # subscribe the playbook's feeds and open its certified questions
elia battmann pull comtrade IND 8542 --periods 2024,2025
elia battmann refresh                      # refresh feeds, resolve due questions, update baselines, rebuild the dashboard
elia battmann watch --every 6h             # repeat refresh while this process runs
elia battmann record                       # the certified track record
elia battmann dashboard                    # .elia/artifacts/battmann-dashboard.{html,json,md}
```

`elia battmann brief india-semiconductors` seeds the playbook if needed, then starts the Battmann agent on the configured model to write the brief. The agent re-confirms the situation from recent reporting, forecasts every open certified question, scores supply-disruption risk, traces consequences, ranks alternative suppliers from the Comtrade shares, and writes a draft report and the dashboard. The `india-semiconductors` playbook follows the Government of India monitoring its semiconductor imports. It subscribes these feeds:
- Comtrade imports of integrated circuits (HS 8542) by partner for five years and by month, and of discrete semiconductors (HS 8541).
- USD against INR, CNY, KRW and JPY.
- World Bank and IMF indicators.
- GDELT coverage of Taiwan and of export controls.
- IMF prices for oil, LNG, copper, aluminium and tin.
- India's applied tariffs on processors, memory, other ICs, and solar cells and modules.

It opens certified questions whose thresholds sit near the latest fetched values.

`watch` runs only while its process does. For unattended monitoring, use `elia battmann cycle <playbook>`. It refreshes, resolves and updates baselines, then re-runs the brief when the agent's forecasts are older than `--reforecast-days` (7 by default). `elia battmann autorun install <playbook> [--at 22:00]` schedules that daily from the current workspace with the operating system's own per-user scheduler:
- **macOS:** a launchd agent in `~/Library/LaunchAgents`.
- **Linux:** a line in your crontab, tagged with the workspace so it can be found again.
- **Windows:** a Task Scheduler task under `elia\` that runs a small script kept in the workspace's `.elia/`.

`status` shows the schedule, the last result and the log tail. `uninstall` removes exactly what `install` created. The job carries no API keys: its model step uses the provider saved with `elia config set`, and without one only the model-free steps run. It needs a durable workspace (temporary directories are refused), and it runs only while you are logged in and the machine is awake.

A certified forecast more than 25 points from the baseline comes back with a note asking for the specific evidence the baseline cannot see. Agent-driven work can recur with `elia schedule add --mode battmann --every 6h "re-forecast the open certified questions"`.

### Analysis tools

Four analytic primitives turn the ledger into decision support without inventing a number:

- **`risk_assessment`**: a 0-100 score from dated, sourced, weighted factors. Correlated factors are averaged within an independence group, so repeated coverage of one driver does not compound the score. The output carries each factor's contribution, a confidence level, a leave-one-group-out sensitivity, and a direction of travel from the supplied factor momentum.
- **`consequence_chain`**: annotates a tree of first-, second- and third-order consequences. Each edge carries `P(effect | cause)`; the tool returns the path probability to every node, the dominant path, the weakest link, and the deep low-probability tail risks.
- **`find_path` / `object_detail` / `list_objects`**: traverse the evidence-linked ontology built with `upsert_object` and `link_objects`, for example a chokepoint two hops from the client, or a tier-2 supplier owned by a sanctioned entity.
- **`explain_causality`**: a deterministic provenance trace of the upstream paths behind a target entity's risk, scored by link confidence and per-hop decay, naming the weakest edge and the evidence gaps. It is a static structural trace, not a dynamical model.

For finance, `exposure_assessment` aggregates sourced FX, rate, commodity, credit and geographic exposures into a diversified scenario loss with an HHI concentration score. It is a deterministic scenario loss, not a value-at-risk. `define_indicator` / `record_indicator_reading` / `indicator_series` keep a dated indicator ledger (feeds write into the same ledger) with change, trend and a z-score against the indicator's own history. `alternatives` ranks sourced substitutes (suppliers, routes, sources) across weighted, min-max-normalised criteria, with a drop-one-criterion stability check.

The ledger also carries `register_dataset` / `dataset_lineage`, a hash-chained provenance graph. `define_action` → `propose_action` → `decide_action_proposal` records an intent and a separate human decision, and executes nothing. `register_geo_event` / `geo_query` / `situation_snapshot` give a geolocated picture built only from registered events; there are no live sensor feeds. `define_deployment_target` / `stage_deployment` produce constraint-checked, versioned bundles under `.elia/artifacts/deploy/` without transmitting them. Every write appends to the tamper-evident `audit_trail`, which re-verifies its hash chain on read.

`dashboard` renders the store as one page, written to `.elia/artifacts/` as HTML, JSON and Markdown. It shows alerts (rising forecasts, indicator outliers, failing feeds, review backlog), open questions with Battmann's probability beside the baseline's, indicators with their source and date, feed health, the certified track record, scenarios, the geospatial picture and pending proposals. It is regenerated on demand and by `refresh`, not streamed. `report_from_store` writes a governed Markdown, JSON and printable-HTML report; a final report fails closed until every included claim has a supported review.

Evidence is graded:
- **Feed:** fetched by code from a data feed, with the raw response hashed.
- **Fetched:** the excerpt was checked, by code, against the page `web_fetch` retrieved in the session, and the page's hash is kept. `register_evidence` refuses an excerpt that is not on the page it names.
- **Unverified:** a search snippet, or text that was never checked against a fetched page.

The model cannot set the grade. The report shows each claim's verified sources, and each evidence record's grade.

Every figure in a claim is checked against the stored text of the evidence it cites. That is the excerpt the source or the feed code wrote, never the model's own supporting excerpt. `register_claim` refuses an `observed_fact` whose figures are not in its evidence. For a calculation, estimate or judgement it returns the unmatched figures as a flag. The report's judgments table lists them for the reviewer. In a live brief this caught two real mistakes: supplier shares taken from HS 8541 but cited against the HS 8542 record, and a scheme outlay cited to a press release that never states it. A derived figure or a model estimate is flagged too, which is right, because the reader should know it is not a measurement.

### Classification boundary

Records carry a `securityClassification` (`public`, `internal`, `confidential`, `restricted`), and the boundary is enforced in code (`src/battmann/modelBoundary.ts`):

- If every model route this session can use runs on this machine (the deep and fast tiers, role overrides, and auto fallbacks), the tool carries every record. A local route is Ollama on loopback, or a `custom` endpoint on loopback.
- If any route is a cloud model, reads through the `battmann` tool are clamped to the cloud ceiling, and writing a record labelled above it is refused, because content a cloud model composed has already left the machine. The ceiling is `internal` by default; set `ELIA_BATTMANN_CLOUD_CLEARANCE=public` or `confidential` to change it. `restricted` never goes to a cloud model.
- The store file is a protected path. `read_file`, search and shell reads such as `sqlite3` or `strings` on `battmann*.sqlite` are treated like `.env`, so the tool is the only way a model reaches the records. A custom `storePath` must keep "battmann" in its file name for that reason.
- `elia battmann …` commands run without a model, so their dashboard shows every record.

What this does not cover: files the agent reads with other tools. A confidential spreadsheet read with `read_spreadsheet` in a cloud session goes to that cloud model. Keep such material out of cloud sessions, or run Battmann on a local model.

### Limits

These controls make forecasts reproducible and hard to flatter. They do not show that Battmann forecasts better than anyone else. That needs a large independently resolved live sample, which the certified record accumulates over time, plus competitive baselines and external review. The store is a local, single-workspace SQLite file, not enterprise access control. `watch` and the scheduler are local processes, not hosted 24/7 monitoring. The sources' own terms apply to what you do with their data; check UN Comtrade's, GDELT's and the others' terms before commercial redistribution.

## Data Science mode

Start with `elia --datascience` (or `--ds`), switch with `/mode datascience`, or run governed autonomy with `elia auto --datascience "<goal>"`. Data Science mode is an execution system, not a code-writing assistant: elia loads the data, checks it, runs the analysis, validates the result, and answers with Objective · Data · Method · Results · Validation · Limitations · Artifacts. It follows the loop understand → inspect → plan → execute → validate → analyze → iterate → explain → deliver.

The model decides what to run. A deterministic TypeScript engine (`src/datascience/`) computes it, and each action's own postcondition checks decide whether the result can be trusted. Every call writes an execution record under `.elia/datascience/runs/`: the input datasets with content fingerprints, the parameters, the seed, any SQL, expression, or Python code, the checks, and the outputs. A result whose checks failed comes back marked `VALIDATION FAILED`, and the prompt forbids reporting it as a finding. Code that ran without an exception is not treated as a validated result.

### Tools

| Tool | Actions |
|---|---|
| `ds_data` | `load` (CSV/TSV/JSON/JSONL/XLSX/XML/PDF/DOCX/Markdown natively; Parquet/Feather/Avro/ORC/XLS via Python; SQLite; Postgres/MySQL/Redshift read-only; DuckDB/SQL Server/Oracle/Snowflake/BigQuery via Python drivers; REST APIs; `s3://`), `schema`, `inspect` (data dictionary, semantic types, candidate keys, grain), `quality` (transparent 0–100 score by component; drift against another version), `relationships`, `transform` (recorded pipeline → new dataset version), `sql` (read-only over workspace datasets), `export`, `lineage`, `preview` |
| `ds_stats` | `describe`, `test` (auto-selected with assumption checks, effect sizes, CIs, post-hoc), `correlations`, `regression` (OLS with HC3/cluster SEs, logistic, Poisson, negative binomial, robust, mixed), `power`, `multiple_testing`, `bootstrap`, `ab_test` (SRM, CUPED, guardrails, segments), `design_experiment`, `causal` (DiD, propensity/IPW/AIPW/matching, RDD, IV, synthetic control, DAG) |
| `ds_ml` | `train` (AutoML: leakage screen, grouped/stratified/time-series CV, baseline, one-standard-error selection, untouched holdout, calibration, fairness, permutation importance), `predict` (drift checks), `explain`, `models`, `promote`, `model_card`, `cluster`, `reduce`, `anomalies`, `drift`, `recommend` |
| `ds_timeseries` | `analyze` (decomposition, ADF/KPSS, ACF/PACF, change points, anomalies), `forecast` (methods compared by rolling-origin backtest, empirical prediction intervals, compared against naive) |
| `ds_analytics` | `root_cause`, `cohorts`, `funnel`, `rfm`, `clv`, `kpis`, `simulate`, `queue`, `optimize` (LP/MILP with shadow prices), `graph`, `geo`, `text`, `llm_eval` |
| `ds_report` | `plan`, `chart` (validated accessible palette, data table beside every chart), `report` (HTML + Markdown from execution records; narrative numbers are traced to results), `powerbi`, `records`, `deliver` |
| `ds_python` | `capabilities`, `run` (isolated job; code recorded), `setup` (installs into `.elia/datascience/venv`) |

Cleaning never modifies a source: `transform` writes a new version with lineage, and loaded snapshots are stored gzip-compressed under `.elia/datascience/data/`. Statistical routines are tested against SciPy and NumPy reference values.

### What asks first

Analysis and workspace-local writes run without asking: new dataset versions, models, charts, and reports under `.elia/datascience/`. The governor asks before any of these: querying a live database, sending a stored credential to an API (a `${ENV}` header, `urlEnv`, or `s3://`), reading from an API on a local or private address, exporting a file into the project, running Python, and installing packages. Installing packages and Python code that names a secret-bearing path (`.env`, `.aws/…`) are critical-risk. SQL sent to a database must pass a read-only guard and runs inside a read-only transaction.

Credentials are passed by environment-variable name (`dsnEnv`, `urlEnv`, `"Bearer ${API_TOKEN}"`) and never appear in tool input, output, or records. elia's own model-provider, GitHub, search, deployment, and cloud keys are refused as data-source credentials, so they cannot be forwarded to an endpoint or into analysis code. Reviewer sub-agents (critic, security, scout, …) get only the computation actions.

### From the command line

These commands do not use a model:

```bash
elia ds capabilities      # every ds_* action and how it touches the world
elia ds datasets          # registered datasets, versions, sources and derivations
elia ds runs              # recent execution records and their validation status
elia ds record <runId>    # one record in full
elia ds verify            # recheck recorded artifacts against their SHA-256
elia ds python            # the Python interpreter and data packages available
```

### Limits

- **Power BI.** `ds_report powerbi` writes a Power BI Project (PBIP): a TMDL semantic model with a star schema, DAX measures, and a Date table, plus PBIR report pages. Its JSON files were validated against Microsoft's published schemas during development; the repository tests check the file layout, relationships, and DAX references. It is not a `.pbix`: open the `.pbip` in Power BI Desktop and use File → Save As to get one. The project has not been opened in Power BI Desktop as part of elia's tests.
- **Python is optional.** The TypeScript engine runs on any machine with Bun. XGBoost/LightGBM/CatBoost, SHAP, Prophet, UMAP/HDBSCAN, deep learning, Parquet writing, and the Python-driver databases need the packages installed (`ds_python setup`, which asks first).
- **Sandboxing.** Python runs in a separate process with a scrubbed environment, a timeout, and CPU and memory limits (memory limits apply on Linux). It is not a container unless `ELIA_SANDBOX=container` and `ELIA_SANDBOX_IMAGE` are set.
- **Not implemented:** streaming sources such as Kafka, geocoding of addresses, and deep-learning computer vision in the TypeScript engine. Text sentiment is a lexicon baseline and is labelled as one.
- **Scale.** Data is held in memory, up to 2 million rows per dataset. For larger data, aggregate in the database first.

## System Intelligence mode

Start with `elia --sysintel` (or `--si`), switch with `/mode sysintel`, or run governed autonomy with `elia auto --sysintel "<goal>"`. System Intelligence mode is dev mode run as a whole technical organization: research, product, engineering, infrastructure, security, data, QA, and operations feeding work into each other. It keeps every dev-mode tool and adds an engine (`src/sysintel/`) that holds each piece of work to the lifecycle a mature organization would put it through.

The model decides what the organization should do next. The engine decides what is true: which stage an initiative is in, whether its gates are met, and whether a review or a test still applies to the current code. The record lives under `.elia/sysintel/` (one JSON file per initiative, versioned artifacts, and an append-only `journal.jsonl`).

### How work moves

1. **Intake.** A request becomes an initiative with an origin (business, product, research, engineering, data, security, operations) and a lifecycle: `feature`, `change` (the git workflow), `research`, `incident`, `vulnerability`, `data-pipeline`, `analysis`, `ml`, `llm`, `ux`, `rfc`, or `planning`.
2. **Triage.** Facts about the work (files, systems, severity, flags such as `security`, `data`, `deployed`, `irreversible`, `novel`) set a scale from `trivial` to `strategic`. The scale decides which stages and gates apply. A one-file fix gets code → tests → merge. An irreversible migration gets an RFC with a rollback plan and an architecture review. A strategic bet needs the person's direction sign-off. Wording that clearly implies a flag (for example "login", "migration", "drop table") adds the flag. Triage and re-triage can only raise rigor, never lower it.
3. **Ownership.** Each stage has an owner hat, one of 25 roles from CTO and chief scientist to SRE, QA, TPM, and technical writer. Each hat owns one question: the research scientist asks "does this approach work?", the SRE asks "does it stay reliable?". `si_work brief` turns the current stage (or a work item) into a ready `task` call for the worker that wears that hat; `si_work brief review:<kind>` briefs an independent reviewer instead. Initiatives belong to a team: `si_org structure` prints the org chart. It has the CTO / Chief Scientist, Research, Product, Engineering, Data / ML / AI, Reliability / Security / QA, and Programs teams. It also has the specialised teams an autonomous-AI organization adds: agent research, evaluation, experiment infrastructure, model engineering, agent runtime, observability, safety and security, data infrastructure, automated experimentation, and research knowledge management.
4. **Gates.** A stage passes only on evidence the engine produced or verified:
   - an artifact that passes its template;
   - a check the engine ran itself (`si_record check` runs the command through the governor as `run_command` and records the exit status against a fingerprint of the working tree);
   - a commit or branch it found in git;
   - a review from an independent worker;
   - a sign-off the person gave.

   The lead's own statements are notes. They can close discovery-style stages but never a test, review, or release gate.
5. **Loops.** `si_work advance to:<earlier stage>` records an iteration: a refuted hypothesis, a failed review, a regression. Production problems and postmortem action items become linked follow-up initiatives (`si_work intake parent:SI-n`). A validated research result becomes an engineering initiative through `si_work handoff`. The handoff needs an independent research review and a feasibility assessment covering inference cost, latency, memory, reliability, scalability, security, maintainability, licensing, and data requirements.

### Evidence rules

- **Freshness.** Reviews and checks are tied to the git tree the working directory would commit, excluding `.elia`. That tree is the same before and after a commit and changes on any edit. An approval or a passing test on an earlier version of the code does not count for the current one, and release and production sign-offs are tied to the code they approved.
- **Design reviews and code reviews.** A review names what it reviewed: the code, or a version of a design document. Security and infrastructure review a feature's design at the design stage, and security reviews the code again before release. A review of the design never satisfies a gate that asks for a review of the code. Architecture review follows the chain senior/staff review → principal architecture review → security review → approval, and each step needs a review from the reviewer wearing that hat.
- **Independence.** A review counts only when it comes from a worker qualified for that review kind: `critic`/`bughunter` for code review, `security` for security review, `tester` for QA sign-off, `accessibility`, or `critic` wearing the staff, principal, SRE, or chief-scientist hat for architecture, reliability, and research reviews. A review from the operator at the terminal also counts. The lead's review and the author's review are recorded as self-review and never pass a gate.
- **Artifacts.** 33 templates: PRD, roadmap, user stories, RFC, ADR, design doc, API spec, test plan, release plan, literature review, research proposal, experiment plan, experiment results, benchmark report, paper, feasibility, SLO, runbook, incident report, postmortem, threat model, security review, vulnerability report, data contract, lineage, analysis report, model card, eval report, UX spec, strategy, OKRs, program plan, and developer guide. Every required section must hold real content, and some sections have extra checks: an experiment's conclusion must say supported, refuted, or inconclusive; SLO targets must be percentages; key results must be measurable. Postmortems that assign blame get a warning. Each version is hashed. `elia si verify` finds files changed after they were recorded, and a changed artifact no longer passes a gate.

### Tools

| Tool | Actions |
|---|---|
| `si_org` | `roles`, `role`, `structure` (the org chart and its teams), `lifecycles`, `lifecycle`, `ownership`, `reviews`, `ladder`, `cadence` (daily engineering and research loops, weekly, quarterly, and where each forum lives in the record), `triage` (a preview that records nothing) |
| `si_work` | `intake`, `show`, `list`, `gate`, `advance`, `plan`, `item`, `retriage`, `block`, `unblock`, `depend`, `assign` (the owning team), `link` (existing initiatives as follow-ups), `handoff`, `close`, `brief`, `report` (`board`, `priorities` for Monday planning, `week` for the Friday review, `quarter`, `flywheel`, `dependencies`, `risks`, `knowledge`, `digest`) |
| `si_artifact` | `template`, `write`, `validate`, `show`, `list`, `export` |
| `si_record` | `note`, `link`, `check`, `commit`, `branch`, `review`, `decide`, `risk`, `signoff` |

Delegated workers get the org model, read access to the record, and their own evidence actions: reviewers record verdicts, and builders run checks and close work items. Moving an initiative between stages and asking for sign-offs stay with the lead.

### What asks first

Reading the model and appending to the record run without asking. A check's command is gated exactly like `run_command`. Exporting an artifact into the project asks under the review band. A sign-off (`direction`, `release`, `production`, `accept-risk`) is critical: the governor asks the person every time. An earlier "allow for this session", a rule in `allow.json`, or a remembered run decision never covers a sign-off, and an unattended run with nobody to ask cannot give one. The engine records a sign-off only when the rest of the stage is already met. Direct writes to `.elia/sysintel/` through file tools or shell commands are refused as `sysintel.record-edit`.

### From the command line

These commands do not use a model:

```bash
elia si                       # the board: every initiative, its stage, owner hat, and open gates
elia si show SI-3             # one initiative in full, gates evaluated now
elia si report priorities     # Monday: what matters this week, in order
elia si report week           # Friday: shipped, learned, failed, next (also quarter, flywheel, dependencies, risks, knowledge, digest)
elia si structure             # the org chart and its teams
elia si journal               # every change to the record
elia si verify                # recheck artifacts against their hashes
elia si signoff SI-3 release  # sign off yourself (needs an interactive terminal and a typed confirmation)
elia si review SI-3 code-review approve --note "read the diff, ran the tests"
```

`signoff` and `review` refuse to run without a real terminal, so a model driving a shell cannot perform them for you.

### Limits

- The organization is elia and its workers. Hats are prompts, tool sets, and ownership rules, not separate people, so independent review means a separate worker with its own context, not a second human. For decisions that need a person, the engine asks for one.
- Evidence is local. Pull requests, CI runs, dashboards, and papers can be attached as links, but the engine cannot verify what is on the other end of a URL. Only checks it runs, git objects, and artifacts on disk are verified.
- Freshness needs git. Outside a repository, check freshness is judged by time (after the stage began) and review staleness is not tracked.
- Metrics (lead time, deployment frequency, time to recover, review send-back rate, hypothesis outcomes) are counted from this workspace's record only.

## Cybersecurity mode

Start with `elia --cyber` or switch with `/mode cyber`. Cyber mode is for **authorized** security testing, CTF, vulnerability research, and defensive hardening — it acts only against systems the user owns or has written authorization to test, and refuses destructive techniques, denial-of-service, opportunistic scanning of third-party infrastructure, and detection-evasion tooling built for malicious use.

Work is organised around an **engagement** — a `workspace/engagements/<slug>/` folder scaffolded by `new_engagement` with a `SCOPE.md` authorization record that every downstream action stays inside:

- **`run_security_tool`** runs any installed scanner (nmap, nuclei, sqlmap, gobuster, …) for a scaffolded engagement and saves the raw output under `recon/`. It parses the command's network targets and refuses an out-of-scope one; a command whose targets it cannot read — a local binary, a wordlist path — still runs, and its log records that scope was not verified. A binary that is not installed is refused outright rather than saved as a "command not found" result, so a missing tool can never be cited as evidence. `timeoutMs` raises the 5-minute default for decompilation-length work.
- **`http_probe`** sends one HTTP request to an in-scope target and records the full request/response pair to `recon/traffic.jsonl`. The target host must appear in `SCOPE.md` — hostnames, IPs, and IPv4 CIDR ranges are matched, and an out-of-scope host is refused, including when it appears as a redirect target. Cookies persist per engagement in `recon/session.json` (owner-readable, values masked everywhere they are reported), so a login made with one probe is sent on the next; `clearSession` drops it. This is what makes testing behind authentication possible.
- **`security_triage`** reads a saved recon log and returns structured findings instead of raw text: nmap XML, nuclei JSONL, and nmap text output become ports, versions, and per-template matches, each carrying its evidence line and a checkable risk score. An unrecognised format says so rather than inventing findings.
- **`ctf_toolchain`** reports which security tools are actually installed across the pwn, rev, crypto, stego, and misc categories, with a ready-to-run install plan for what is missing and each step's approval cost. It detects and reports; it never installs.
- **`ctf_playbook`** returns the ordered triage procedure for one category — how to recognise it, what to run, what the output looks like, and the usual dead ends.
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
