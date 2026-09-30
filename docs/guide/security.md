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
- `denyCommandPatterns` — case-insensitive regular expressions; blocked when any matches the command line of `run_command`, `run_program`, `process` with action `start`, or cyber mode's `run_security_tool`. Every tool that executes a shell string is covered, so routing a command through a different tool does not evade the list.
- `requireApprovalAtOrAbove` — `"safe"`, `"review"`, or `"critical"` (default). Any action assessed at this risk or higher stops being auto-allowed in unattended mode and needs an explicit approval.

A malformed policy file fails loudly rather than being ignored. A refused action reports `Blocked by .elia/policy.json`.

### Elia's own trust stores

A handful of files decide what elia trusts and who has already said yes: `.elia/policy.json` (the tightening policy above), `.elia/allow.json` and `~/.config/elia/allow.json` (standing "always allow" rules), and `~/.config/elia/preauth.json` plus its `preauth.secret` (time-limited pre-authorizations, and the HMAC key that signs them). Two rules keep them from being edited quietly:

- **A trust edit is never a workspace write.** `write_file`, `edit_file`, `lsp_refactor` and `delete_file` aimed at any of these paths — anywhere under a `.elia/` directory, or anywhere under the per-user `~/.config/elia` home — are assessed `critical` / approve with the `trust-control` intent, marked non-reversible, and deliberately excluded from the "asked once per run" family. One approval cannot carry into a second trust edit later in the same run; an unattended run refuses them outright, and only a human's own `elia auto --authorize trust-control` can pre-authorize one. Ordinary project files that merely share a name (`src/policy.json`, `config/allow.json`) are unaffected.
- **The per-user allow list is signed.** Its rules are exactly the standing authority that lets a later run skip an approval, so the file carries an HMAC-SHA256 over its rules keyed by the same per-user secret that signs pre-authorizations. An unsigned or edited file is refused rather than honored, which is what makes the governor's parent-signs-the-child boundary real for that store: a shell mishap, a dropped-in repository, or any other writer cannot grant itself a permanent bypass. The checked-in project allow file stays unsigned by design — a reviewed team decision, in the same spirit as `policy.json` only ever being able to tighten.

`preauth.secret` is itself treated as a credential: the file tools refuse to read it, and a shell command that names a trust store is classified as a sensitive read rather than riding the read-only shell policy.

The per-user stores live under `~/.config/elia` rather than `~/.elia`, one level further from a checked-out repository's own `.elia` directory. An existing `~/.elia/preauth.json`, `~/.elia/preauth.secret`, or `~/.elia/allow.json` is migrated once on first use — carrying the grants and the signing secret across, so existing authorizations stay valid — and then removed rather than left behind as a second copy of the same authority.
