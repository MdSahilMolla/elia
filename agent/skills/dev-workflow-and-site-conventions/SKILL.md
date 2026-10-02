---
name: dev-workflow-and-site-conventions
description: >
  Use this when executing build or deployment tasks in the Elia workspace,
  especially for research paper style sites. It specifies directory context,
  type checks, preview workflows, Python/TS validation, tool invocation constraints,
  and strict CSS/HTML conventions.
---

# Development Workflow and Site Conventions

## Execution Context and Paths

Always run `bun` commands (install, build, dev, test) from the project root where the package.json and sources live. Ensure all file and command paths are relative to the workspace root; never include absolute user paths. Before finalizing any change, run `bun run typecheck`; if absent, use `bun run build` for validation. Verify file existence before targeting nested paths; use `grep` on parent directories to list available files.

## Preview and Cleanup

To view a site, run `bun run dev` followed by `preview http://localhost:3000`. Note that `preview` auto-reloads and exits normally, while `bun run dev` runs persistently. If preview returns HTTP 500, delete stale Next.js artifacts with `rm -rf .next` before retrying. Verify the current working directory exists before executing git commands to avoid exit code 1 failures.

## Research Paper Theme Constraints

When building a research paper theme website, start with a static `index.html` and `styles.css` without build tools or dependencies. The site must remain pure HTML/CSS. Adhere to these strict styling rules:
- **File Limits**: `index.html` must be concise and include a meta description. `styles.css` must be concise.
- **Selectors**: Use only class selectors prefixed with `rp-`, beginning with `rp-`.
- **Visual Theme**: All CSS uses a black/white palette, system-ui font, fixed top navigation, marquee footer, and pill-shaped buttons.
- **Navigation**: Implement a fixed top navigation with `position:fixed; top:0;` and a subtle backdrop-filter to match the humanastudio.com aesthetic.
- **Interactions**: Apply subtle interactive states like hover lift and shadow for phases and buttons.

## TypeScript, Python, and Migration

- **TypeScript**: In TypeScript files under `src/tools`, separate function parameters and object properties with commas to avoid TS1005 errors.
- **Python**: Install Python dependencies using `pip3` before attempting to import them in the project. Precompile Python modules with `python3 -m py_compile` before executing imports to catch syntax errors and avoid runtime hangs. When interacting with Python scripts that require input, avoid using `echo -e` for piped input as it may cause exit code 1 failures; use `printf` instead. Ensure scripts requiring interactive input receive complete input sequences matching their expected logic to avoid runtime errors. Scripts using `input()` must catch `EOFError` to handle exhausted piped input gracefully. Where possible, use only non-interactive commands via `run_command`.
- **Svelte**: Do not assume Svelte source files like `App.svelte` exist in `src/` during migration reviews, as the project may have already converted to vanilla JavaScript.

## File System and Safety

- **Path Validation**: When invoking file-system commands such as `list_files`, ensure the target path is a valid existing directory under the workspace root; a non-existent path will cause the command to fail.

## Utility Commands and Submission

- **Skills**: When adding a skill with `npx skills add`, include the `-y` flag to auto-approve and `--agent '*'` to satisfy required options and avoid exit code 1.
- **Submissions**: When invoking `submit_acceptance`, ensure every acceptance criterion has an associated verdict before calling; otherwise the submission will fail. When invoking `submit_assumptions`, ensure each assumption has an associated verdict before calling. When calling `risk_assessment`, include a non-empty sourceDate string of at most 100 characters in the first factor.
- **Tool Invocation**: When invoking `create_question`, set the `horizon` field to a valid ISO date or timestamp.
