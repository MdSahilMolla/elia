---
name: elia-development-workflow
description: >
  Use this skill for day-to-day development in the elia codebase. It
  covers workspace conventions, command safety, testing, and
  conventions for site generation. It helps you avoid common build,
  integration, and runtime errors before delivery.
---
# Elia Development Workflow

## Workspace and Bun Usage

Always run `bun` commands (install, build, dev, test) from the project `workspace/` directory. Use `cwd` explicitly in commands that operate on subdirectories. Keep all command paths relative to the workspace root.

## Type Checking and Testing

Run `bun run typecheck` before finalizing any change. If the project lacks a typecheck script, use `bun run build` for type validation.

## Tool and Command Usage

- When invoking `run_command`, avoid commands that require interactive input (e.g., Python `input()`). Use only non-interactive commands.
- When piping input to Python scripts, use `printf` instead of `echo -e` to avoid exit code 1 failures.
- When invoking `risk_assessment`, include a non-empty `sourceDate` string of at most 100 characters in the first factor.
- When invoking `create_question`, set the `horizon` field to a valid ISO date or timestamp.
- When invoking `list_files` or similar commands, handle non-zero exit codes from `grep` (e.g., exit code 1 if no matches) gracefully.
- When invoking `npx skills add`, include the `-y` flag to auto-approve and provide `--agent '*'` to satisfy required options.

## File and Path Safety

- When invoking nested paths, verify the file exists first (e.g., using `ls` on the parent directory).
- When invoking file-system commands like `list_files`, ensure the target path is a valid existing directory.

## Development and Preview

To view a site, ensure you have a valid web server running. Avoid assumptions about build tools; prefer static HTML/CSS for research-style sites unless otherwise specified.

## Submission Protocol

Before invoking `submit_acceptance` or `submit_assumptions`, ensure that every acceptance criterion or assumption has an associated verdict; otherwise the submission will fail.

## Python Dependencies

Install Python dependencies using `pip3` before attempting to import them in the project. Pre-compile Python modules with `python3 -m py_compile` before executing imports to catch syntax errors early.

## Research Paper Website Conventions

When creating a research-paper theme website, start with a static `index.html` and a single `styles.css`; no build tools are required.

- **index.html:** Keep it no more than 150 lines and include a meta description.
- **styles.css:** Keep it no more than 80 lines. Use class selectors prefixed with `.` and ensure all class names begin with `rp-`.
- **Style Guide:** Use a black/white palette, system-ui font, and a fixed top navigation bar (`position:fixed; top:0;`) with a subtle backdrop-filter. Include a marquee footer and pill-shaped buttons. Apply minimal interactive states such as hover lift or shadow for buttons.