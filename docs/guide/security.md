# Security boundaries and policy

[← Back to the README](../../README.md)

## Security boundaries

Elia applies defense-in-depth controls before local or network-sensitive work. File tools resolve every existing path component canonically and reject `..` traversal, absolute paths outside the active or explicitly designated workspace, symlink escapes, and dangling symlink ancestors. Paths that commonly contain credentials—such as `.env` files, SSH keys and directories, cloud credential stores, browser profiles, npm configuration, and token or password files—are blocked before bytes can enter model context. Directory listing and recursive search omit protected entries, and shell commands that would disclose protected files remain critical even after a user approves the surrounding action.

Durable run state, checkpoints, task snapshots, journals, ledgers, schedules, coordination notes, and communication drafts are stored with private directories (`0700` where supported), owner-only files (`0600` where supported), atomic replacement, and permission repair for older state. These are local filesystem safeguards, not encryption or a substitute for a protected operating-system account.

`web_fetch` accepts only HTTP(S) URLs, rejects embedded credentials and local, private, link-local, metadata, multicast, and reserved targets, resolves public hostnames before requesting, bounds response size and duration, and refuses automatic redirects. Custom model endpoints must use HTTPS. A localhost development endpoint is permitted only when `ELIA_ALLOW_INSECURE_LOCAL_ENDPOINT=1` is explicitly set; it remains a local development exception, not a production trust model. DNS checks are defense in depth and do not claim to eliminate every time-of-check/time-of-use or network-rebinding risk, so use network isolation for stronger guarantees.

The same address policy extends to the adjacent network paths: remote MCP connectors (`url`-based servers) may only target loopback or genuinely public HTTP(S) hosts, carry no embedded credentials, and refuse redirects; `preview`'s `url` branch rejects private/metadata targets the way `web_fetch` does, keeping loopback dev servers—its stated purpose—as the only local exception; and Jev and connection-warming use the same HTTPS-or-explicit-loopback rule as any custom model endpoint.

The React artifact server binds to loopback and uses a bounded, traversal-safe resolver. It is intended for local preview, not public hosting. Elia remains a local application rather than a hardened multi-user sandbox: it does not provide kernel isolation, hosted identity, a secure keyring, or guaranteed protection from a user who grants the process broad operating-system access. See [`SECURITY.md`](../../SECURITY.md) for reporting and supported-version guidance.

### Deterministic policy: `.elia/policy.json`

A checked-in `.elia/policy.json` tightens the autonomy governor before the model runs — enforced by code at the tool boundary, not by a prompt the model can argue its way around. It can only make the governor stricter, never looser. Fields (all optional):

- `denyTools` — tool names blocked outright, e.g. `["codex_delegate", "communication"]`.
- `denyIntents` — governor intents blocked outright, e.g. `["github.push", "browser.click"]` (a `tool.action` pair, so `github.push` is denied while `github.commit` is not).
- `denyCommandPatterns` — case-insensitive regular expressions; a `run_command` is blocked when any matches.
- `requireApprovalAtOrAbove` — `"safe"`, `"review"`, or `"critical"` (default). Any action assessed at this risk or higher stops being auto-allowed in unattended mode and needs an explicit approval.

A malformed policy file fails loudly rather than being ignored. A refused action reports `Blocked by .elia/policy.json`.
