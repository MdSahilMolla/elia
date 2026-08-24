# Elia Autonomous AI Improvement Roadmap

## Objective

Evolve Elia from a capable autonomous coding CLI into a reliable general-purpose autonomous execution system that can plan, act, verify, recover, learn, and resume without falsely reporting success or weakening approval boundaries.

The primary optimization target is:

> Wall-clock time to a verified correct outcome.

Raw token speed, worker count, or plausible model output are not success metrics by themselves.

## Current foundation

Elia already provides much of the required control-plane foundation:

- Structured proposals and plan artifacts.
- Dependency-aware execution waves.
- Specialized worker roles and bounded delegation.
- A deterministic action governor and exact approval boundaries.
- Durable goal graphs, checkpoints, receipts, and recovery paths.
- Read-only critics and security reviewers.
- Tool preconditions and postconditions.
- Browser action verification and snapshot hashes.
- Persistent schedules and a local daemon.
- Sandboxed self-improvement candidates and rollback support.
- Provider routing, fallback, token accounting, and context compaction.

The next stage should strengthen consistency and verified completion rather than simply adding more tools or agents.

## Guiding principles

1. Never infer success from model prose.
2. Every consequential action must have an explicit policy contract.
3. Every acceptance criterion must have observable evidence.
4. Retry only classified transient failures.
5. Never repeat an ambiguous or completed external action automatically.
6. Keep planning, policy, execution, verification, and review separate.
7. Optimize concurrency from measurements, not CPU count or intuition.
8. Treat repository content, browser pages, packets, connectors, and tool output as untrusted data.
9. Separate offline validation from live provider, browser, deployment, and connector proof.
10. Make every long-running operation resumable and safely stoppable.

## Priority 0: Autonomy Contract v2

### Goal

Create one machine-readable source of truth for every tool and action so registration, model exposure, governance, execution, and verification cannot drift apart.

### Required contract fields

Each capability must declare:

- Tool name and version.
- Input and output schemas.
- Supported platforms.
- Required credentials and transports.
- Risk classification.
- Approval policy.
- Filesystem and network scope.
- Reversibility.
- Idempotency behavior.
- Retry policy.
- Preconditions.
- Postconditions.
- Expected artifacts.
- Process lifecycle and cleanup behavior.
- Failure classifications.
- Audit redaction policy.

### Generated behavior

The unified contract should generate or validate:

- Provider-facing tool definitions.
- Tool registry entries.
- Governor assessments.
- Action contracts.
- Approval summaries.
- Receipt fields.
- Capability documentation.
- Contract conformance tests.

### Acceptance criteria

- Every registered tool has exactly one declared contract.
- An unavailable or invented tool fails before an approval prompt.
- No registered tool falls through to an unknown-tool governor policy.
- Tool input and output schemas are validated at runtime.
- Contract documentation is generated from the same source.
- Contract drift fails CI.

## Priority 0: Acceptance Evidence Graph

### Goal

Represent completion as verified state instead of a narrative claim.

Each acceptance criterion should transition through:

```text
pending -> attempted -> observed -> verified
                     -> failed
                     -> blocked
```

### Evidence requirements by task type

| Task type | Required evidence |
|---|---|
| Code change | Intended diff, focused tests, regression tests, and required type/lint checks |
| Web application | Build result, live process evidence, HTTP response, and browser/UI postcondition |
| Background service | Process ID, readiness marker, listening endpoint, health response, and cleanup ownership |
| Deployment | Provider receipt, deployment URL, HTTPS verification, and expected release identity |
| File artifact | Expected path, content/schema validation, and render inspection when layout matters |
| Browser action | Fresh URL/text/state observation and snapshot hash after the action |
| External communication | Approved recipient/content, connector acknowledgement, and delivery-state readback |
| Data operation | Input identity, deterministic calculation record, output schema, and reconciliation checks |

### Acceptance criteria

- A model cannot mark a goal complete directly.
- Completion is derived from evidence graph state.
- Missing evidence produces `partial`, `blocked`, or `needs-attention`.
- Final responses are generated from recorded evidence and blockers.
- Receipts link each claim to its supporting evidence.
- Stale evidence is invalidated when its source file, process, page, or dataset changes.

## Priority 1: Typed Execution Tools

### Goal

Replace fragile shell choreography with deterministic cross-platform operations.

### Proposed tools

- `project_tree(cwd, depth, include, exclude)`
- `package_script(cwd, script, args)`
- `start_service(cwd, command, ready_check)`
- `service_status(process_id)`
- `stop_service(process_id)`
- `http_check(url, expected_status, expected_text)`
- `port_check(host, port)`
- `git_inspect(cwd)`
- `verify_project(cwd, checks)`
- `artifact_inspect(path, expected_type)`

These tools may reuse the existing shell and process implementation internally, but the model should not need to compose `cd`, `cmd /c`, nested PowerShell, redirection, or platform-specific environment syntax.

### Acceptance criteria

- Windows and Unix workflows use the same logical tool inputs.
- Working directories are explicit and workspace-confined.
- Long-running processes have durable identities and cleanup ownership.
- A server cannot be reported as running from echoed command text.
- Process state survives agent-loop turns and can be inspected or stopped.
- Shell remains available for legitimate general-purpose work but is not the default for common project operations.

## Priority 1: Structured Project and World Memory

### Goal

Maintain a durable, evidence-backed model of the environment instead of relying only on conversation summaries.

### Memory record fields

- Fact or observation.
- Source and evidence reference.
- Repository, branch, path, or external resource identity.
- Confidence.
- Creation and verification timestamps.
- Expiry policy.
- Dependencies.
- Invalidation trigger.
- Sensitivity classification.
- Whether the fact is observed, inferred, or user-supplied.

### Required memory categories

- Repository and nested-project roots.
- Frameworks, languages, and package managers.
- Project commands and verification requirements.
- Files and symbols already inspected.
- User requirements, exclusions, and approvals.
- Running processes and services.
- Completed and ambiguous actions.
- Failed approaches and classified causes.
- Provider and connector readiness.
- Lessons that have passed evaluation.

### Acceptance criteria

- File-derived facts are invalidated after relevant writes.
- Process facts expire or update when the process exits.
- External facts carry timestamps and source references.
- Secrets never enter semantic memory.
- Retrieval quality is measured against held-out recall tasks.
- Recalled facts never override current repository evidence or explicit user instructions.

## Priority 1: Adaptive Planning and Recovery

### Goal

Turn plans into resumable state machines that revise only affected work.

### Required behavior

- Each step declares dependencies, inputs, outputs, claimed files, tools, and acceptance checks.
- Same-file writers are serialized.
- Independent read-only work may run concurrently.
- Failed assumptions invalidate dependent steps.
- Completed idempotent actions are replayed from evidence, not executed again.
- Ambiguous external actions require human review.
- Repeated identical failures stop automatic retries.
- Replanning changes only invalid downstream nodes.

### Failure taxonomy

- Transient provider or network failure.
- Invalid input.
- Missing dependency or executable.
- Authentication required.
- Authorization or approval required.
- Capability unavailable.
- Policy rejection.
- Verification failure.
- Logic defect.
- Ambiguous external outcome.
- Budget or time exhaustion.

### Acceptance criteria

- Only transient failures are retried automatically.
- Retry limits and backoff are bounded.
- A resumed run does not repeat completed side effects.
- Operator pause and stop propagate to active workers and managed processes.
- Recovery instructions are recorded in the receipt.

## Priority 1: Autonomous Evaluation Platform

### Goal

Measure real task performance across platforms, providers, and capability families.

### Evaluation families

- Small code fixes.
- Multi-file features.
- Failure reproduction and debugging.
- React and TypeScript applications.
- Python projects.
- Mixed frontend/backend repositories.
- Windows and Linux command execution.
- Browser interaction and verification.
- Service startup and lifecycle.
- Resume after interruption.
- Duplicate side-effect prevention.
- Approval-boundary attacks.
- Prompt-injection fixtures.
- Provider fallback and partial-output failure.
- Long-context degradation.
- Research, data, finance, document, and communication workflows.

### Metrics

- Verified task success rate.
- False-success rate.
- Unsafe-action rate.
- Approval correctness.
- Duplicate action rate.
- Repair success rate.
- Resume correctness.
- Human-intervention count.
- Model round trips.
- Tool round trips.
- Input and output tokens.
- Cache-hit rate.
- Median and p95 completion time.
- Cost per verified task.

### Initial quality gates

- Zero unauthorized consequential actions.
- Zero completion claims without required evidence.
- Zero duplicated completed external actions during resume.
- Every benchmark failure produces a classified cause.
- Performance improvements must preserve or improve correctness and safety.
- Provider-backed results must be reported separately from offline deterministic tests.

## Priority 2: Authorized Connectors and Computer Use

### Goal

Expand general autonomy through narrow, authorized integrations with explicit verification.

### Target integrations

- Persistent browser sessions.
- GitHub and CI systems.
- Issue trackers.
- Email and calendar.
- Messaging systems.
- Cloud deployment providers.
- Databases and migrations.
- Storage providers.
- Hosted schedules and event triggers.

### Rules

- Prefer a typed API or connector over unrestricted browser or shell control.
- Verify authentication, authorization, reachability, and health at runtime.
- Drafting is not sending.
- Building is not deploying.
- Uploading is not publishing.
- Provider acknowledgement is not final-state verification.
- Authentication, CAPTCHA, payment, and sensitive-input steps require user takeover.

## Priority 2: Guarded Recursive Self-Improvement

### Goal

Allow Elia to improve measurable weaknesses without optimizing against a noisy or manipulable benchmark.

### Promotion workflow

1. Detect a repeated weakness from evaluation evidence.
2. Form one bounded, falsifiable hypothesis.
3. Create a sandboxed candidate.
4. Protect benchmark definitions and immutable inputs.
5. Run correctness, safety, determinism, and performance gates.
6. Evaluate public and hidden tasks.
7. Repeat comparisons across multiple trials.
8. Require independent critic and security verdicts.
9. Reject ties, regressions, and statistically noisy gains.
10. Promote transactionally with a backup.
11. Run post-promotion monitoring.
12. Roll back automatically when release gates regress.

### Acceptance criteria

- Candidates cannot modify their evaluator or promotion policy.
- Candidate tools are sandbox-confined.
- Missing critic verdicts fail closed.
- One noisy benchmark pair cannot trigger promotion.
- Live provider evidence is separated from offline evidence.
- Every promotion has a reproducible comparison receipt and rollback path.

## Priority 2: Performance and Cost Optimization

### Goal

Reduce time and cost without weakening correctness, evidence, review, or safety.

### Measurement before optimization

Instrument:

- Provider latency by phase.
- Tool latency.
- Serial versus parallel time.
- Context size per turn.
- Cache read/write behavior.
- Duplicate tool calls.
- Repair frequency.
- Reviewer disagreement.
- Tokens per successful task.
- Median and p95 end-to-end completion.

### Likely high-leverage improvements

- Fewer serial model calls.
- Deterministic project profiling and tree inspection.
- Batched ranged reads.
- Atomic multi-file patches.
- Incremental verification based on affected files.
- Snapshot/version-aware read caches.
- Bounded high-signal tool output.
- Small-task deterministic routing.
- Provider-aware concurrency limits.
- Reuse of verified evidence across review phases.

### Changes to avoid without evidence

- Scaling concurrency from CPU count alone.
- Sharing mutable caches across isolated workers.
- Increasing agent count for every task.
- Lowering verification or reviewer depth to improve headline speed.
- Claiming transport improvements without provider measurements.
- Optimizing token streaming instead of verified completion time.

## Priority 3: Production Isolation and Operations

### Goal

Add system-level controls required for high-trust or multi-user deployments.

### Required capabilities

- OS-enforced worker sandboxing.
- Per-run filesystem isolation.
- Managed network allowlists.
- Secure operating-system credential storage.
- CPU, memory, process, and wall-clock limits.
- Auditable operator identity and authorization.
- Tamper-evident receipts.
- Emergency stop and lease expiry.
- Hosted durable worker supervision.
- Backup and recovery procedures.
- Incident response and security monitoring.

The application-level governor remains necessary but must not be presented as a replacement for operating-system or infrastructure isolation.

## Implementation sequence

### Phase 1: Reliability foundation

1. Implement Autonomy Contract v2.
2. Add contract-conformance tests for every registered tool.
3. Implement the acceptance evidence graph.
4. Generate completion reports from evidence state.
5. Add typed project, process, HTTP, and verification tools.

### Phase 2: Evaluation and recovery

1. Build the cross-platform evaluation harness.
2. Establish current correctness, safety, latency, and cost baselines.
3. Add structured failure classification.
4. Implement adaptive downstream replanning.
5. Validate interruption, resume, and side-effect deduplication.

### Phase 3: Memory and integrations

1. Add structured project/world memory with invalidation.
2. Measure retrieval quality and stale-memory failures.
3. Add authorized connectors incrementally.
4. Add external-state readback verification.
5. Add hosted scheduling only after durable lifecycle testing.

### Phase 4: Safe improvement and scale

1. Expand hidden and adversarial evaluation suites.
2. Add multi-trial self-improvement promotion gates.
3. Optimize measured serial bottlenecks.
4. Add system-level isolation.
5. Run controlled production pilots with rollback and incident procedures.

## Definition of done

Elia should be considered reliably autonomous for a capability only when it can:

1. Discover whether the capability is available.
2. Produce a bounded plan with explicit assumptions and side effects.
3. Execute through declared contracts and approval boundaries.
4. Observe and verify every required postcondition.
5. Classify failures and retry only when safe.
6. Pause for missing authentication, authorization, scope, or user input.
7. Resume without repeating completed side effects.
8. Produce an evidence-backed receipt.
9. Pass deterministic, adversarial, cross-platform, and provider-backed evaluations appropriate to that capability.
10. State remaining limitations honestly.

## Immediate next milestone

The recommended next implementation milestone is:

> Build Autonomy Contract v2 and the Acceptance Evidence Graph together.

These two components prevent registry/governor drift, reduce false success, improve recovery, and create the foundation required by coding, browser automation, deployment, scheduling, connectors, and recursive self-improvement.

### Milestone postconditions

- All built-in tools pass contract-conformance tests.
- Unknown tools fail before approval.
- Every autonomous plan produces explicit evidence requirements.
- Completion is impossible while required evidence remains pending.
- The full existing test suite remains green.
- New Windows and Linux transcript-replay tests pass.
- A provider-backed evaluation run completes without repeated approvals, invented-tool execution, false server-start claims, or unsupported completion claims.

## Recovery and rollback

- Introduce the new contract registry behind an internal compatibility adapter.
- Migrate built-in tools incrementally while CI rejects mixed or missing declarations.
- Keep existing governor decisions fail-closed during migration.
- Persist evidence graph data in a versioned format.
- Make schema migrations reversible and retain prior receipts.
- If a migrated tool changes risk or postcondition behavior unexpectedly, disable that tool contract and fall back to the existing governed implementation until corrected.
- Do not promote self-generated changes when evaluation, reviewer, or rollback evidence is incomplete.
