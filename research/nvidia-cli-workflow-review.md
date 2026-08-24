# NVIDIA NIM CLI workflow review

## Review provenance

- Provider: NVIDIA NIM OpenAI-compatible API
- Review model: `openai/gpt-oss-20b`
- Models endpoint verified on 2026-08-23; Elia discovered 102 model identifiers, including `openai/gpt-oss-20b` and `nvidia/llama-3.3-nemotron-super-49b-v1.5`.
- Review input: bounded dossier containing the current CLI entrypoint, session persistence, runtime output modes, provider registry, shutdown code, scheduler, slash prompt, confirmation helper, task sessions, package scripts, and current working diff.

## NVIDIA findings and disposition

1. NVIDIA suggested that the custom provider might fail when `ELIA_PROVIDER=custom` uses `ELIA_MODEL` without a base URL. This was a false positive: Elia correctly requires `ELIA_BASE_URL` for the custom OpenAI-compatible provider, and `tryResolveProvider` already honors `request.baseURL` and ambient `ELIA_BASE_URL` before the preset URL.
2. NVIDIA identified that `--quiet` made `interactiveTerminal` false because quiet was included in `plainOutput`. This was accepted as a usability defect. Elia now preserves a real TTY editor and slash completion in quiet mode while still suppressing status noise; plain and JSON modes remain non-interactive.
3. NVIDIA proposed stronger shutdown exception logging. Elia already catches each cleanup independently, continues the cleanup stack, clears the stack, and exits only after the cleanup pass, so no change was necessary.

## Live validation

- A normal NVIDIA-backed one-shot query succeeded with exit code 0.
- A quiet NVIDIA-backed query using `openai/gpt-oss-20b` returned exactly `CLI_OK` with exit code 0 and no stderr output.
- Live NVIDIA model discovery through `listProviderModels('nvidia')` returned 102 sorted models.
- A JSONL NVIDIA-backed query exposed stale historical task records in `tasks_updated` events; this was investigated as an event-snapshot behavior, not evidence of browser execution. The normal human CLI path did not open a browser for a harmless prompt.
- Provider-independent validation exposed an eager configuration path: top-level `autonomy/risk.ts` and the startup skills/registry chain could initialize provider configuration before usage errors. The CLI now lazy-loads risk checks, defers provider-dependent command imports until validation completes, and loads learned skills only for commands that execute tools.
- After the fixes, `--help`, `--version`, malformed `auto`, malformed `evolve`, and malformed `fork` commands return their own usage/validation errors without provider credentials.

## Implemented fixes

- Added strict safe-integer parsing for CLI numeric options, rejecting suffixes such as `1000ms`, negatives, empty values, and out-of-range action budgets.
- Added the governor’s exported hard action cap to keep CLI and runtime limits consistent.
- Added session-directory creation, safe session-ID validation, and malformed persisted-session rejection.
- Preserved quiet-mode interactivity with focused runtime tests.
- Lazy-loaded the risk classifier, provider-dependent autonomous/agent/evolve/resume/fork modules, and the tool registry behind skill availability.

All credentials were passed through environment variables and were not written to this file.
