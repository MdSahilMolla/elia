---
name: elias-cli-and-ui-conventions
description: >
  This skill applies when building or maintaining research paper–style sites,
  running Python or Bun scripts, or styling interfaces within the Elia workspace.
  It defines safe execution patterns, workspace conventions, and UI standards
  to ensure consistent, reliable outputs.
---
# Elia CLI and UI Conventions

## Command Execution and Workspace
- Execute all Bun commands, file references, and file-system operations from the `workspace/flower-blooming` root using relative paths only; never run from the repository root or use absolute user paths.
- Verify that target files exist before reading them.
- Use `run_command` for all script invocation, keeping interactions non-interactive.
- Do not pipe input to Python scripts using `echo -e`; instead use `printf` for reliable piped data.
- Handle commands that may exit with non-zero codes gracefully; supply required flags or arguments (e.g., `-y`, `--agent '*'`, non-empty `sourceDate` ≤100 chars, valid ISO date for `horizon`).
- Never use `run_command` to start long-running servers (e.g., `python3 -m http.server`) in elia, as the process will time out and terminate.

## Python and Dependencies
- Before importing any package, install dependencies with `pip3`.
- Pre-compile modules with `python3 -m py_compile` to catch syntax errors early and avoid backend import timeouts.

## UI and Website Design
- Use a static `index.html` and a single `styles.css` only; no build tools or external dependencies.
- Keep `index.html` ≤150 lines and include a meta description.
- Keep `styles.css` ≤80 lines with class selectors prefixed by `.` and names beginning with `rp-`; keep CSS concise, avoid redundant rules, and use subtle interactive states such as hover lift and shadow for phases and buttons.
- Implement a fixed top navigation bar using `position: fixed; top: 0;` with a subtle backdrop-filter to match the humanastudio.com aesthetic. Use a black/white palette with system-ui fonts. Include a marquee footer and pill-shaped buttons. Preserve these styles across pages.