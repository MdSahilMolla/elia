---
name: research-paper-workflow-standards
description: >
  Use this skill when building or maintaining research-paper-style websites
  in this workspace. It enforces safe command execution, file size limits,
  theme standards, and submission requirements to keep work consistent and verifiable.
---
# Research Paper Workflow Standards

## Development & Tooling
- Run all Bun commands (`install`, `build`, `dev`, `test`) and reference files from the workspace root only. Use relative paths; avoid absolute paths or repository-root execution to prevent duplication.
- Before finalizing changes, run `bun run typecheck`. If that script is missing, fall back to `bun run build` to validate TypeScript types.
- To view the site, run `bun run dev` and then `preview http://localhost:3000`. If the preview fails with HTTP 500, clear stale artifacts with `rm -rf .next` before retrying.
- Before adding worktrees, verify existing ones with `git worktree list` to avoid duplicate worktree errors.

## Theme Implementation
- Start sites with static `index.html` and `styles.css` files; avoid build tools for the base theme.
- **Design Standards:** Use a black/white palette, system-ui fonts, fixed top navigation, marquee footer, and pill-shaped buttons.
- **Navigation:** Implement fixed top navigation with `position:fixed; top:0;` and a backdrop filter to match the required aesthetic.
- **CSS Rules:** Class selectors must be prefixed with `rp-`. Keep CSS concise and avoid redundant rules.
- **File Limits:**
  - `index.html`: Max 150 lines; include a meta description.
  - `styles.css`: Max 80 lines; ensure a trailing newline.

## CLI & Command Safety
- Use `npx skills add -y --agent '*'` when adding skills.
- Handle non-zero exit codes (e.g., `grep` returning 1) gracefully.
- Verify that skill files exist before reading them.
- Avoid interactive commands (`python input()`, etc.) when invoking via `run_command`.
- Use `printf` instead of `echo -e` for piped Python inputs.

## Python & Dependencies
- Install Python packages with `pip3` before importing them.
- Pre-compile modules with `python3 -m py_compile` before execution to catch syntax errors early.

## Submission & Safety
- Before calling `submit_acceptance` or `submit_assumptions`, ensure every criterion has an associated verdict.
- When invoking `risk_assessment`, include a non-empty `sourceDate` string (≤100 chars).
- When calling `create_question`, set `horizon` to a valid ISO date or timestamp.
