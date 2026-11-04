---
name: elias-research-paper-site-workflow
description: >
  Use this guidance when building or maintaining research-paper-style websites within the Elia workspace. It covers environment setup, build checks, file constraints, command handling, and submission requirements to ensure consistency and prevent common errors.
---
# Elia Research Paper Site Workflow

## Environment and Paths
- Always execute bun commands, file references, and file system operations from the `workspace/flower-blooming` root using relative paths only. Never run from the repository root or use absolute user paths.
- Verify that target files exist before reading them.

## Build and Development Checks
- Run `bun run typecheck` before any change. If the project lacks a typecheck script, run `bun run build` and always run `node --check` after building to ensure all TypeScript outputs compile.
- To view the site, run `bun run dev` and then `preview http://localhost:3000`. If you receive an HTTP 500 error, delete stale Next.js artifacts with `rm -rf .next` before retrying.
- If Python scripts are involved, pre-compile them with `python3 -m py_compile` to catch syntax errors and avoid backend import timeouts.

## File and Design Constraints
- Start research-paper theme websites with a static `index.html` and a single `styles.css`; no build tools or external dependencies are required.
- Ensure `styles.css` is no more than 80 lines, uses class selectors prefixed with `.`, and all class names begin with `rp-`.
- Ensure `index.html` is no more than 150 lines and includes a meta description.
- UI styling: implement a fixed top navigation bar (`position:fixed; top:0;`) with a subtle backdrop-filter to match the humanastudio.com aesthetic; use a black/white palette, system-ui font, marquee footer, and pill-shaped buttons; preserve these styles.
- CSS rules should be concise, avoid redundant rules, and use subtle interactive states such as hover lift and shadow for phases and buttons.

## Command Handling
- When running commands that may exit with non-zero codes (e.g., `grep`, `list_files`, `npx skills add`, `git worktree add`, `risk_assessment`, `create_question`), handle the exit status gracefully and provide required flags or arguments (`-y`, `--agent '*'`, non-empty `sourceDate` ≤100 chars, valid ISO date for `horizon`).
- Use only non-interactive commands via `run_command`; avoid `echo -e` for piped input to Python scripts and instead use `printf`.
- Install Python dependencies with `pip3` before importing them in any scripts.
- Never use `run_command` to start long-running servers such as `python3 -m http.server` in elia, because the process will time out and terminate.

## Submission Requirements
- Before calling `submit_acceptance` or `submit_assumptions`, ensure every acceptance criterion or assumption has an associated verdict; otherwise the submission will fail.
