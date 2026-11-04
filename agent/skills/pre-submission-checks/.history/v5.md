---
name: pre-submission-checks
description: >
  Use this checklist to catch common build errors, verify submission criteria,
  and apply consistent UI standards before finalizing commits or launching previews.
---

# Pre-Submission Checks

## Build & Type Safety

*   **Directory:** Always run bun commands (`install`, `build`, `dev`, `test`, `typecheck`) from the `workspace/flower-blooming` directory.
*   **Type Checking:** Before finalizing any change, run `bun run typecheck`. If no script exists, use `bun run build` for validation or add the script.
*   **TypeScript:** In `src/tools`, always separate function parameters and object properties with commas to avoid TS1005 errors.
*   **Python:** Install dependencies (e.g., streamlit, pandas) with `pip3` before use.

## File & Path Safety

*   **Verify Paths:** Before targeting nested paths (e.g., `src/autonomy/loop.ts`), verify the file exists (e.g., using `grep` on the parent directory).
*   **list_files:** Ensure the target path is a valid existing directory under `workspace/flower-blooming`.
*   **Relative Paths:** Use paths relative to the workspace root; avoid absolute user paths.

## Tooling & Runtime

*   **View Site:** Run `bun run dev` then `preview http://localhost:3000`. `preview` auto-reloads and exits normally; `dev` does not. If `preview` returns HTTP 500, delete `.next` and retry.
*   **Command Safety:** Avoid interactive commands (e.g., Python's `input()`) in `run_command`. Use `printf` instead of `echo -e` for piped input to Python.
*   **Empty Lines:** When using `grep` to check for empty lines in CSS, expect exit code 1 if no matches; handle gracefully.

## Submission & Verification

*   **Verdicts:** Ensure every item in `submit_acceptance` has an associated acceptance criterion verdict, and every item in `submit_assumptions` has an assumption verdict.
*   **Battmann Fields:** Ensure `retrievedAt` strings are non-empty and under 100 characters.
*   **Risk Assessment:** Include a non-empty `sourceDate` string (max 100 chars) in the first factor.
*   **Create Question:** Set `horizon` to a valid ISO date or timestamp.

## UI & Website Standards

*   **Structure:** Research paper sites start with static `index.html` and `styles.css`; no build tools needed.
*   **HTML:** `index.html` must be <= 150 lines (target ~90) and include a meta description.
*   **CSS:** `styles.css` must be <= 80 lines (target ~22) with a trailing newline.
*   **Naming:** All CSS class selectors must start with `.` and all class names must begin with `rp-`.
*   **Style:** Use black-on-white palette, `system-ui` font, lowercase text, fixed top nav (`position:fixed; top:0;` + backdrop-filter), pill buttons, and 768px mobile breakpoint.

## Migration Notes

*   **Svelte:** Do not assume Svelte files exist in `src/` during migration reviews; projects may have converted to vanilla JS.
*   **Skill Installation:** When adding a skill with `npx skills add`, include the `-y` flag and `--agent '*'`.
