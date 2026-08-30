import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { ActionRequest } from './governor.ts'
import { isPathWithinWorkspace, resolveWorkspacePath } from './context.ts'

export type ContractFailureDisposition = 'retryable' | 'human-review'
export type ContractCheckKind = 'command-available' | 'browser-transport' | 'workspace-path' | 'shell-exit-zero' | 'result-contains' | 'result-url-prefix'

export interface ContractCheck {
  kind: ContractCheckKind
  value?: string
  description: string
}

export interface ActionContract {
  idempotencyKey: string
  preconditions: ContractCheck[]
  postconditions: ContractCheck[]
  maxAttempts: number
  failureDisposition: ContractFailureDisposition
  requiresUserTakeover: boolean
}

export interface ContractEvaluation {
  ok: boolean
  phase: 'precondition' | 'postcondition'
  failures: string[]
  evidence: string[]
  nextAction?: string
}

const SAFE_BROWSER_ACTIONS = new Set(['status', 'navigate', 'refresh', 'back', 'forward', 'snapshot', 'extract', 'scroll', 'wait', 'wait_for', 'verify'])
const SHELL_COMMAND = /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:command\s+)?([A-Za-z0-9_./-]+)(?:\s|$)/

/** Commands that start a server and never return — measured on "did it come up", not "exit 0". */
const LONG_RUNNING_SERVER = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)|vite(?:\s|$)|next\s+(?:dev|start)|nodemon|ts-node-dev|concurrently|http-server|serve(?:\s|$)|flask\s+run|uvicorn|gunicorn|rails\s+s(?:erver)?|php\s+artisan\s+serve)\b/i

export function contractForAction(request: ActionRequest, cwd: string, idempotencyKey: string): ActionContract {
  const preconditions: ContractCheck[] = []
  const postconditions: ContractCheck[] = []
  let requiresUserTakeover = false
  let failureDisposition: ContractFailureDisposition = 'retryable'

  if (request.name === 'deployment') {
    const action = typeof request.input.action === 'string' ? request.input.action : 'unknown'
    const provider = typeof request.input.provider === 'string' ? request.input.provider : 'unknown'
    const target = typeof request.input.target === 'string' ? request.input.target : 'unknown'
    if (action === 'deploy' && (provider === 'vercel' || provider === 'netlify')) {
      preconditions.push({ kind: 'command-available', value: provider, description: `${provider} CLI must be available before deployment work runs` })
    }
    if (action === 'plan') {
      postconditions.push({ kind: 'result-contains', value: '"status": "planned"', description: 'the deployment plan must report readiness' })
    } else if (action === 'build') {
      postconditions.push({ kind: 'result-contains', value: '"status": "built"', description: 'the local build must report a successful build' })
    } else if (action === 'deploy' && target === 'production') {
      requiresUserTakeover = true
      failureDisposition = 'human-review'
      postconditions.push({ kind: 'result-contains', value: '"status": "deployed"', description: 'the production deployment must report a deployed status' })
    } else if (action === 'deploy') {
      postconditions.push({ kind: 'result-contains', value: '"status": "deployed"', description: 'the preview deployment must report a deployed status' })
    } else if (action === 'verify') {
      postconditions.push({ kind: 'result-contains', value: '"status": "verified"', description: 'the deployment URL must respond successfully' })
    }
  }

  if (request.name === 'run_command') {
    const command = typeof request.input.command === 'string' ? request.input.command.trim() : ''
    const executable = SHELL_COMMAND.exec(command)?.[1]
    // Shell builtins have no PATH entry, so a "is it in PATH" check always fails
    // for them. This covers both sh builtins and — critically on Windows, where
    // they are cmd.exe builtins rather than real executables — mkdir, copy, del,
    // and friends. A precondition that fails `mkdir` strands the whole run.
    const SHELL_BUILTINS = new Set([
      'cd', 'echo', 'export', 'set', 'source', 'pushd', 'popd', 'dir', 'type', 'command', 'exit', 'true', 'false',
      'mkdir', 'md', 'rmdir', 'rd', 'copy', 'move', 'del', 'erase', 'ren', 'rename', 'cls', 'ver', 'vol', 'path',
      'title', 'date', 'time', 'call', 'start', 'assoc', 'ftype', 'color', 'prompt', 'chdir', 'mklink', 'setlocal',
      'endlocal', 'shift', 'goto', 'rem', 'if', 'for', 'break', 'test',
    ])
    if (executable && /^[A-Za-z0-9_./-]+$/.test(executable) && !SHELL_BUILTINS.has(executable.toLowerCase())) {
      preconditions.push({ kind: 'command-available', value: executable, description: `${executable} must be available before the command runs` })
    }
    // A long-running server (npm run dev, vite, next dev, a bare `serve`) never
    // exits, so "exit 0" is the wrong bar — it would always look like a failure
    // and drive a repair loop. Those are started differently (see run_command's
    // own guidance); everything else must still exit clean.
    if (!LONG_RUNNING_SERVER.test(command)) {
      postconditions.push({ kind: 'shell-exit-zero', description: 'the command must return exit code 0 and not time out' })
    }
  }

  if (request.name === 'browser') {
    const action = typeof request.input.action === 'string' ? request.input.action : 'unknown'
    preconditions.push({ kind: 'browser-transport', description: 'a configured browser transport must be present before browser work runs' })
    if (!SAFE_BROWSER_ACTIONS.has(action)) {
      requiresUserTakeover = true
      failureDisposition = 'human-review'
    }
    if (typeof request.input.expectText === 'string' && request.input.expectText.length > 0) {
      postconditions.push({ kind: 'result-contains', value: request.input.expectText, description: `the browser result must contain expected text: ${request.input.expectText}` })
    }
    if (typeof request.input.expectUrl === 'string' && request.input.expectUrl.length > 0) {
      postconditions.push({ kind: 'result-url-prefix', value: request.input.expectUrl, description: `the browser result must show the expected URL prefix: ${request.input.expectUrl}` })
    }
  }

  if (request.name === 'write_file' || request.name === 'edit_file') {
    const rawPath = typeof request.input.path === 'string' ? request.input.path : ''
    let target = rawPath
    try {
      target = resolveWorkspacePath(rawPath, cwd)
    } catch {
      // Preserve the raw value so evaluation records an explicit containment failure.
    }
    preconditions.push({ kind: 'workspace-path', value: target, description: 'the file target must remain inside the active workspace and contain no symlink escape' })
    postconditions.push({ kind: 'workspace-path', value: target, description: `${basename(target || rawPath || 'file')} must exist after the write` })
  }

  return {
    idempotencyKey,
    preconditions,
    postconditions,
    maxAttempts: failureDisposition === 'human-review' ? 1 : 2,
    failureDisposition,
    requiresUserTakeover,
  }
}

export async function evaluatePreconditions(contract: ActionContract, cwd: string, signal?: AbortSignal, environment: NodeJS.ProcessEnv = process.env): Promise<ContractEvaluation> {
  const failures: string[] = []
  const evidence: string[] = []
  for (const check of contract.preconditions) {
    if (check.kind === 'browser-transport') {
      const configured = Boolean(environment.ELIA_BROWSER_MCP_SERVER || environment.ELIA_BROWSER_BRIDGE_COMMAND || environment.ELIA_BROWSER_CDP_URL)
      if (configured) evidence.push('browser transport configured; login, reachability, and authorization remain unverified')
      else failures.push('no browser transport configured; configure an enabled user-Chrome connector, trusted bridge, or CDP endpoint')
      continue
    }
    if (check.kind === 'command-available') {
      const executable = Bun.which(check.value ?? '')
      if (executable) evidence.push(`${check.value} available at ${executable}`)
      else failures.push(`${check.value} is not available in PATH`)
      continue
    }
    if (check.kind === 'workspace-path') {
      try {
        const target = resolveWorkspacePath(check.value ?? '', cwd)
        if (isPathWithinWorkspace(target, cwd)) evidence.push(`workspace target accepted: ${target}`)
        else failures.push('file target escapes the active workspace')
      } catch {
        failures.push('file target escapes the active workspace or crosses a symlink boundary')
      }
      continue
    }
  }
  return { ok: failures.length === 0, phase: 'precondition', failures, evidence, nextAction: failures.length > 0 ? 'Fix the missing environment or ask the user to take over; do not retry blindly.' : undefined }
}

export function evaluatePostconditions(contract: ActionContract, result: string, cwd: string): ContractEvaluation {
  const failures: string[] = []
  const evidence: string[] = []
  for (const check of contract.postconditions) {
    if (check.kind === 'shell-exit-zero') {
      const timedOut = /^timed out after /i.test(result.trim())
      const exitCode = /^exit code:\s*(-?\d+)/im.exec(result)?.[1]
      if (!timedOut && exitCode === '0') evidence.push('command returned exit code 0')
      else failures.push(timedOut ? 'command timed out' : `command did not return exit code 0${exitCode ? ` (exit code ${exitCode})` : ''}`)
      continue
    }
    if (check.kind === 'result-contains') {
      if (result.toLocaleLowerCase().includes((check.value ?? '').toLocaleLowerCase())) evidence.push(`result contains expected text: ${check.value}`)
      else failures.push(check.description)
      continue
    }
    if (check.kind === 'result-url-prefix') {
      const url = extractUrl(result)
      if (url && (url === check.value || url.startsWith(check.value ?? ''))) evidence.push(`observed expected URL: ${url}`)
      else failures.push(`${check.description}${url ? ` (observed ${url})` : ' (no URL evidence returned)'}`)
      continue
    }
    if (check.kind === 'workspace-path') {
      try {
        const target = resolveWorkspacePath(check.value ?? '', cwd)
        if (existsSync(target) && statSync(target).isFile()) evidence.push(`artifact exists: ${target}`)
        else failures.push(`expected file artifact does not exist inside the active workspace: ${target}`)
      } catch {
        failures.push(`could not inspect expected file artifact inside the active workspace: ${check.value ?? '(unknown)'}`)
      }
    }
  }
  return { ok: failures.length === 0, phase: 'postcondition', failures, evidence, nextAction: failures.length > 0 ? 'Inspect the evidence, repair only when the action is idempotent, otherwise escalate for human review.' : undefined }
}

function extractUrl(result: string): string | undefined {
  const parsed = /["']url["']\s*:\s*["']([^"']+)["']/i.exec(result)
  if (parsed?.[1]) return parsed[1]
  const bare = /https?:\/\/[^\s"'}]+/i.exec(result)
  return bare?.[0]
}
