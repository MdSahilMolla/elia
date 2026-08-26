import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { currentAgent, resolveWorkspacePath } from '../autonomy/context.ts'
import { terminateProcessGroup, clampOutput, readBoundedOutput } from '../shell.ts'

/**
 * Delegates a task to the real, separately-installed OpenAI Codex CLI
 * (`codex`) — not a reimplementation of its auth or a wrapper around
 * OpenAI's API. Codex handles its own login (a ChatGPT subscription or an
 * API key, whichever the user configured via `codex login`), its own
 * sandboxing, and its own request path entirely; elia just shells out to the
 * binary the same way a person would from a terminal, then reads back its
 * final answer. If codex isn't installed, this tool says so and stops —
 * it never tries to authenticate on the user's behalf.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60_000 // a full agentic coding session, not a quick command
const MAX_OUTPUT_LENGTH = 100_000

let cachedAvailability: boolean | undefined

export async function codexAvailable(): Promise<boolean> {
  if (cachedAvailability !== undefined) return cachedAvailability
  try {
    const proc = Bun.spawn(['codex', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    cachedAvailability = (await proc.exited) === 0
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

/** Test-only: clears the cached availability check. */
export function resetCodexAvailabilityForTests(): void {
  cachedAvailability = undefined
}

export const codexTool: Tool = {
  name: 'codex_delegate',
  description:
    "Delegates a coding task to the real, separately-installed OpenAI Codex CLI, running under the user's own codex login and its own sandbox — not a wrapper around OpenAI's API. Use for a second, independent agent's take on something, or when the user explicitly asks to use Codex. Codex acts autonomously in the given directory (can read, write, and run shell commands under its workspace-write sandbox) and this tool returns its final answer.",
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The task to hand to Codex' },
      path: { type: 'string', description: "Directory Codex should treat as its working root (defaults to the current workspace)" },
      timeout_ms: { type: 'number', description: `Maximum time to wait, in milliseconds (default ${DEFAULT_TIMEOUT_MS})` },
    },
    required: ['prompt'],
  },
  async execute(input) {
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      throw new Error('codex_delegate requires a non-empty "prompt" string argument.')
    }
    if (!(await codexAvailable())) {
      return 'The codex CLI is not installed or not on PATH. Install it with `npm install -g @openai/codex` and sign in with `codex login` first — codex_delegate only shells out to the real binary, it does not implement Codex auth itself.'
    }

    const cwd = typeof input.path === 'string' && input.path.trim().length > 0 ? resolveWorkspacePath(input.path) : (currentAgent().cwd ?? process.cwd())
    const timeoutMs = typeof input.timeout_ms === 'number' && input.timeout_ms > 0 ? input.timeout_ms : DEFAULT_TIMEOUT_MS

    const outDir = mkdtempSync(join(tmpdir(), 'elia-codex-'))
    const outFile = join(outDir, 'last-message.txt')

    try {
      const proc = Bun.spawn(
        // --approve-for-me already implies the workspace-write sandbox with
        // automatic review — codex rejects the combination of --sandbox and
        // --approve-for-me outright (a real CLI incompatibility, not
        // redundant caution), so don't pass -s alongside it.
        ['codex', 'exec', input.prompt, '-C', cwd, '--approve-for-me', '--skip-git-repo-check', '-o', outFile],
        { stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? {} : { detached: true }) },
      )

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        terminateProcessGroup(proc)
      }, timeoutMs)

      const signal = currentAgent().signal
      const onAbort = () => terminateProcessGroup(proc)
      signal?.addEventListener('abort', onAbort, { once: true })

      let stdout = ''
      let stderr = ''
      let exitCode = 1
      try {
        ;[stdout, stderr, exitCode] = await Promise.all([
          readBoundedOutput(proc.stdout, MAX_OUTPUT_LENGTH),
          readBoundedOutput(proc.stderr, MAX_OUTPUT_LENGTH),
          proc.exited,
        ])
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      if (timedOut) return `codex_delegate timed out after ${timeoutMs}ms and was terminated.\n${clampOutput(stdout, MAX_OUTPUT_LENGTH)}`

      let finalMessage = ''
      try {
        finalMessage = readFileSync(outFile, 'utf8').trim()
      } catch {
        // codex may not have written a final-message file if it failed before producing one.
      }

      if (exitCode !== 0) return `codex exited with code ${exitCode}.\n${clampOutput(stderr || stdout, MAX_OUTPUT_LENGTH)}`
      return finalMessage || clampOutput(stdout, MAX_OUTPUT_LENGTH) || '(codex produced no output)'
    } finally {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup.
      }
    }
  },
}
