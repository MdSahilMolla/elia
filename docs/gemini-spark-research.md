# Gemini Spark research and Elia design decision

**Review date:** 2026-08-22

## Executive conclusion

Gemini Spark is useful product inspiration for Elia’s background-task experience, but it is not a model name that Elia can select with `ELIA_MODEL`, and this repository does not claim a direct Spark-account integration. Google describes Spark as a separate personal agent that runs tasks in the background under the user’s direction, supports connected Google apps, schedules, reusable skills, monitoring, and takeover, and is designed to check before major actions [1]. Google’s support documentation describes Spark as experimental and in early development, with user supervision and a stated limit of up to 15 concurrent tasks [2].

Google also documents a **Gemini Interactions API** for developers. That API can create model or managed-agent interactions, expose tools, run an interaction in the background with `background: true`, retrieve it, and cancel a still-running background interaction [6]. The callable developer surface is therefore real, but the reviewed documentation presents it as the Gemini API/Interactions API rather than as a public Spark-control API. Elia should integrate the developer API only as a separately verified provider route; it must not pretend that an API key grants access to a user’s Spark tasks, Google account, browser session, or connected apps.

## References

[1]: https://gemini.google/overview/agent/spark/ "Gemini Spark overview"
[2]: https://support.google.com/gemini/answer/17094507?hl=en&co=GENIE.Platform%3DAndroid "Gemini Spark availability and help"
[3]: https://support.google.com/gemini/answer/13594961?hl=en "Gemini Apps Privacy Hub"
[4]: https://ai.google.dev/gemini-api/docs "Gemini API documentation"
[5]: https://ai.google.dev/gemini-api/docs/models "Gemini API model catalog"
[6]: https://ai.google.dev/api/interactions-api "Gemini Interactions API reference"

## What Elia adopts

Elia adopts the **control-plane pattern**, not unrestricted authority:

| Spark-like idea | Elia implementation | Boundary |
|---|---|---|
| Tasks and schedules | `.elia/schedules.json`, `elia schedule`, and the single-flight `elia daemon` | The worker must run on an online machine or hosted service; the default sandbox is not a 24/7 host. |
| Background execution | `elia daemon --once` or a foreground polling daemon | Each run has a lease, wall-clock budget, receipt, and stop signal. |
| Connected capabilities | Existing browser and communication adapters plus specialist tools | Presence is not authorization; connectors, login, reachability, and account permissions remain separate facts. |
| Supervision and takeover | Human-review action states, task sessions, exact approvals, and browser/credential takeover boundaries | Login, CAPTCHA, payment, sending, publishing, buying, deletion, account changes, and production mutation do not become unattended merely because they are scheduled. |
| Skills | Existing `.elia/skills` loader and synthesized skills | A skill is not a permission grant; every invocation still passes the action governor and contract checks. |
| Completion confidence | Postconditions, verification commands, evidence, structured completion assessment, and redacted receipts | A model’s claim of success is never external-world proof. |

## Current Gemini relationship in Elia

Elia’s existing `google` provider uses the Gemini API’s documented OpenAI-compatible endpoint and a configured `GEMINI_API_KEY` to call a selected Gemini model. That is different from controlling the Gemini Spark consumer product. The new background scheduler also does not call Spark: it runs Elia’s own autonomous loop, tools, action governor, and durable graph. A future Interactions API adapter could be valuable for long-running or provider-native background model calls, but it would require a separate implementation and tests for tool schema translation, background status polling, cancellation, usage accounting, error recovery, and safety policy. It should not be added by simply changing the model string.

## Safety and deployment decision

The phrase “fully unsupervised real-world action” is not implemented as blanket permission. Elia can continue unattended read-only, reversible, and idempotent work when prerequisites and postconditions are explicit. It escalates when a browser transport is missing, a command is unavailable, a result is non-zero or timed out, a postcondition is unmet, a lease expires, or an action would create a consequential external effect. Truly continuous execution requires a persistent online user machine or a properly hosted worker with explicit connector credentials, monitoring, and a stop path; source code alone cannot keep the ephemeral development sandbox alive.

This produces the useful part of the Spark experience—durable work that can continue without another prompt—while retaining evidence, approvals, recovery, and user control for the parts where an autonomous mistake could send a message, spend money, change an account, damage production, or expose private data.
