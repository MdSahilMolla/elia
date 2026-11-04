---
name: pre-submission-checks
description: >
  Use this checklist to verify build integrity, schema compliance, and runtime
  safety before finalizing commits, deployments, or handoffs. Apply it to every
  task where you output code, modify files, or submit structured results to ensure
  the work passes validation, respects file system boundaries, and meets contractual
  requirements.
---
# Pre-Submission Checks

## Build & Type Verification
*   **Work Directory:** Run all package, build, and test commands from the active project root. Do not assume nested paths; verify your working directory before execution.
*   **Type Safety:** Always run the type checker (`bun run typecheck`) before submitting. If a dedicated script is missing, ensure the build pipeline validates types.
*   **Syntax Discipline:** In TypeScript, separate function parameters and object properties with commas to prevent parser errors. Install Python dependencies before invoking scripts.

## File & Path Integrity
*   **Existence Checks:** Never target nested files or directories without verifying their existence first. Use available tools to confirm the path is valid.
*   **Path Scoping:** Use relative paths rooted at the workspace root. Avoid hard-coded absolute paths.
*   **Tool Usage:** When validating directory structure, ensure your target is a valid, existing directory under the current workspace.

## Runtime & Tooling Safety
*   **Command Behavior:** Avoid interactive commands in `run_command`. Use `printf` for piped input to Python.
*   **Preview Workflows:** When viewing sites, use the appropriate preview command. If a server error occurs, clear cached build artifacts and retry.
*   **Graceful Handling:** When checking for specific content with tools like `grep`, handle non-zero exit codes gracefully.

## Submission Contract Compliance
*   **Verdict Alignment:** Every item in `submit_acceptance` must have a corresponding acceptance criterion verdict; every item in `submit_assumptions` must have an assumption verdict.
*   **Metadata Validity:** Ensure `retrievedAt` strings are non-empty and under 100 characters. Include a non-empty `sourceDate` string (max 100 chars) in the first risk factor.
*   **Temporal Fields:** Set `horizon` to a valid ISO date or timestamp when creating questions.

## UI & Website Standards
*   **Minimalist Structure:** Research paper sites should use static `index.html` and `styles.css` without build tools when possible.
*   **Naming Conventions:** All CSS class selectors must start with `.` and all class names must begin with `rp-`.
*   **Visuals:** Use a black-on-white palette, `system-ui` fonts, and lowercase text. Ensure the top nav is fixed with a backdrop filter and include a 768px mobile breakpoint.

## Migration & Skill Installation
*   **Project States:** Do not assume legacy frameworks (like Svelte) exist during migration; verify the actual file tree.
*   **Skill Integration:** When adding skills via the installer, always include the `-y` flag and `--agent '*'` to prevent prompts.