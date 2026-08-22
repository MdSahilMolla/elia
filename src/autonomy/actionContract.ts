import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { runShell } from '../shell.ts'
import type { ActionRequest } from './governor.ts'

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
const MAX_CHECK_TIMEOUT_MS = 10_000

export function contractForAction(request: ActionRequest, cwd: string, idempotencyKey: string): ActionContract {
  const preconditions: ContractCheck[] = []
  const postconditions: ContractCheck[] = []
  let requiresUserTakeover = false
  let failureDisposition: ContractFailureDisposition = 'retryable'

  if (request.name === 'run_command') {
    const command = typeof request.input.command === 'string' ? request.input.command.trim() : ''
    const executable = SHELL_COMMAND.exec(command)?.[1]
    if (executable && /^[A-Za-z0-9_./-]+$/.test(executable)) {
      preconditions.push({ kind: 'command-available', value: executable, description: `${executable} must be available before the command runs` })
    }
    postconditions.push({ kind: 'shell-exit-zero', description: 'the command must return exit code 0 and not time out' })
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
    const target = rawPath ? resolve(cwd, rawPath) : ''
    const rel = target ? relative(cwd, target) : ''
    const outside = !target || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)
    if (!outside) {
      preconditions.push({ kind: 'workspace-path', value: target, description: 'the file target must remain inside the active workspace' })
      postconditions.push({ kind: 'workspace-path', value: target, description: `${basename(target)} must exist after the write` })
    }
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

export async function evaluatePreconditions(contract: ActionContract, cwd: string, signal?: AbortSignal): Promise<ContractEvaluation> {
  const failures: string[] = []
  const evidence: string[] = []
  for (const check of contract.preconditions) {
    if (check.kind === 'browser-transport') {
      const configured = Boolean(process.env.ELIA_BROWSER_MCP_SERVER || process.env.ELIA_BROWSER_BRIDGE_COMMAND || process.env.ELIA_BROWSER_CDP_URL)
      if (configured) evidence.push('browser transport configured; login, reachability, and authorization remain unverified')
      else failures.push('no browser transport configured; configure an enabled user-Chrome connector, trusted bridge, or CDP endpoint')
      continue
    }
    if (check.kind === 'command-available') {
      const result = await runShell(`command -v -- ${shellQuote(check.value ?? '')}`, MAX_CHECK_TIMEOUT_MS, cwd, signal)
      if (result.exitCode === 0 && !result.timedOut) evidence.push(`${check.value} available at ${result.stdout.trim().split(/\r?\n/)[0] ?? 'PATH'}`)
      else failures.push(`${check.value} is not available in PATH`)
      continue
    }
    if (check.kind === 'workspace-path') {
      const target = check.value ?? ''
      const rel = target ? relative(cwd, target) : '..'
      if (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)) evidence.push(`workspace target accepted: ${rel || '.'}`)
      else failures.push('file target escapes the active workspace')
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
        const target = resolve(cwd, check.value ?? '')
        if (existsSync(target) && statSync(target).isFile()) evidence.push(`artifact exists: ${relative(cwd, target)}`)
        else failures.push(`expected file artifact does not exist: ${relative(cwd, target)}`)
      } catch {
        failures.push(`could not inspect expected file artifact: ${check.value ?? '(unknown)'}`)
      }
    }
  }
  return { ok: failures.length === 0, phase: 'postcondition', failures, evidence, nextAction: failures.length > 0 ? 'Inspect the evidence, repair only when the action is idempotent, otherwise escalate for human review.' : undefined }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function extractUrl(result: string): string | undefined {
  const parsed = /["']url["']\s*:\s*["']([^"']+)["']/i.exec(result)
  if (parsed?.[1]) return parsed[1]
  const bare = /https?:\/\/[^\s"'}]+/i.exec(result)
  return bare?.[0]
}
