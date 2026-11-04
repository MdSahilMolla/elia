---
name: elia-dev-workflow-guide
description: >
  Use this guidance when executing development tasks within the Elia project,
  specifically for building sites, verifying types, handling commands, and
  maintaining consistent project constraints.
---
# Elia Project Development Workflow

## Build & Verification
Run `bun run typecheck` before making changes. If missing, run `bun run build` and follow with `node --check` to confirm outputs compile. For Python code, install dependencies with `pip3` before importing and pre-compile modules with `python3 -m py_compile` to catch syntax errors early.

## Site & Server Safety
To view the site, run `bun run dev` and preview `http://localhost:3000`. If you receive an HTTP 500 error, delete stale Next.js artifacts with `rm -rf .next` before retrying. Never use `run_command` to start long-running servers like `python3 -m http.server`; processes will time out and terminate.

## Working Directory & Commands
Execute all bun commands and file operations from the `workspace/flower-blooming` root using relative paths only. Never run from the repository root or use absolute user paths. When using `run_command`, avoid `echo -e` for piped input; use `printf` instead. Handle exit statuses gracefully for tools like `grep`, `git worktree add`, or custom scripts.

## Website Design
Use a static `index.html` and single `styles.css` only, with no build tools or external dependencies. Keep `index.html` ≤150 lines and include a meta description. Keep `styles.css` ≤80 lines. Use a fixed top navigation bar (`position:fixed; top:0;`) with subtle backdrop-filter, black/white palette, system-ui font, marquee footer, and pill-shaped buttons. Prefix class selectors with `.` and names with `rp-`.
