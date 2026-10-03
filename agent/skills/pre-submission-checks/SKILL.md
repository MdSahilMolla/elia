---
name: pre-submission-checks
description: >
  Use this checklist before finalizing any change or launching a preview. It verifies type safety, confirms file paths are valid, and ensures schema fields meet submission requirements. Rely on it to catch build errors and enforce site standards early in the workflow.
---

# Pre-Submission Checks

## Build & Type Safety

*   **Directory:** Run all `bun` commands (`install`, `build`, `dev`, `test`, `typecheck`) from `workspace/flower-blooming`.
*   **Type Checking:** Always run `bun run typecheck` before committing. If the script is missing, use `bun run build` or add it.
*   **TypeScript:** Separate function parameters and object properties with commas in `src/tools` to prevent TS1005 errors.
*   **Python:** Install dependencies (`pip3`) before runtime.

## File & Path Safety

*   **Verify Paths:** Confirm nested paths exist (e.g., via `grep` on parent directories) before targeting them.
*   **list_files:** Validate the target is an existing directory under `workspace/flower-blooming`.
*   **Relative Paths:** Use paths relative to the workspace root; avoid absolute user paths.

## Tooling & Runtime

*   **View Site:** Use `bun run dev` then `preview http://localhost:3000`. If `preview` returns HTTP 500, delete `.next` and retry.
*   **Command Safety:** Avoid interactive commands (`input()`) in `run_command`. Use `printf` instead of `echo -e` for piped input.
*   **Empty Lines:** Expect `grep` exit code 1 on no matches; handle gracefully.

## Submission & Verification

*   **Verdicts:** Every item in `submit_acceptance` and `submit_assumptions` needs an associated verdict.
*   **Schema Fields:** Ensure `retrievedAt` and `sourceDate` are non-empty strings (max 100 chars). Set `horizon` to a valid ISO date or timestamp in question creation.

## UI & Website Standards

*   **Structure:** Research paper sites use static `index.html` and `styles.css` (no build tools).
*   **HTML:** `index.html` <= 150 lines, include a meta description.
*   **CSS:** `styles.css` <= 80 lines, include a trailing newline.
*   **Naming:** Class selectors must start with `.` and class names with `rp-`.
*   **Style:** Black-on-white palette, `system-ui` font, lowercase text, fixed top nav, pill buttons, and 768px mobile breakpoint.

## Migration Notes

*   **Svelte:** Do not assume Svelte files exist during migration; projects may use vanilla JS.
*   **Skill Installation:** Use `npx skills add -y --agent '*'`.