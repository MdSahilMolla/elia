# Elia supervision and control

## Operating contract

Elia is a supervised terminal agent. Interactive autonomous work is supervised by default: the operator approves the plan, review-risk actions reach an approval boundary, and critical external or irreversible actions remain blocked or require an exact approval record. Unattended execution is an explicit opt-in mode, not a hidden default.

The policy is selected through the CLI or environment:

| Setting | Meaning |
|---|---|
| Default | Supervised autonomous execution |
| `--supervised` | Explicitly require the supervised policy |
| `ELIA_SUPERVISION=supervised` | Pin supervised policy in a deployment |
| `--unattended`, `--yolo`, `--autonomous` | Explicitly opt into bounded unattended execution |
| `ELIA_SUPERVISION=unattended` | Pin unattended policy in a deployment |

Conflicting supervised and unattended settings fail closed. In unattended mode, the autonomy governor still blocks critical actions. It does not treat the absence of an operator as authorization for publishing, sending messages, purchasing, authentication, CAPTCHA handling, destructive changes, production mutations, or other irreversible actions.

## Operator controls

The live task dashboard supports `c` to stop/cancel and `p` to pause an active task. `Ctrl+C`, `SIGTERM`, wall-clock budgets, and governed action budgets are additional stop boundaries.

Durable autonomous runs can be controlled from another terminal:

```bash
elia control status
elia control pause <run-id>
elia control stop <run-id>
elia resume <run-id>
```

Pause and stop commands write an atomic, validated `control.json` request into the run directory. The owning process polls the request at a bounded interval, records the request in the run journal, updates the task session, and aborts the internal run signal. A stopped run is reported as paused/aborted and must be reviewed before resumption. Completed runs reject later pause/stop requests.

The control file is not an authorization bypass. It only stops work or asks the owner to stop safely. Any future resume still passes through the existing plan, graph, governor, approval, verification, and completion-assessment boundaries.

## Audit and recovery

Autonomous runs persist a goal graph, journal, checkpoints, action ledger, task session, and receipt under `.elia/runs/<run-id>/`. Control requests are recorded as journal phases. Stale leases and missing heartbeats recover into reviewable states rather than being silently replayed. A completion claim is not accepted without verification evidence and structured review.

The control plane is local to the project and process environment. It is not a hosted management service, does not provide multi-user identity or authorization, and cannot guarantee execution across machine shutdowns. Production or multi-user deployments need an authenticated supervisor service, OS-level service isolation, secret management, audit retention, and explicit operator identity controls.

## Open-source distribution boundary

Elia is open-source software licensed under the GNU Affero General Public License v3.0 (`AGPL-3.0-only`). Distribution and modification must follow the terms in the repository and package `LICENSE` files. In particular, operators who modify Elia and make the modified program available for users to interact with over a network must offer those users the corresponding source as required by the license.
