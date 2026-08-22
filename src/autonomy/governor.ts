import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, relative } from 'node:path'
import type { ToolEvent } from '../agentLoop.ts'
import { currentAgent } from './context.ts'

export type ActionRisk = 'safe' | 'review' | 'critical'
export type ActionDecision = 'allow' | 'approve' | 'block'
export type GovernanceMode = 'supervised' | 'unattended'

export interface ActionRequest {
  name: string
  input: Record<string, unknown>
}

export interface ActionAssessment {
  risk: ActionRisk
  decision: ActionDecision
  reason: string
  intent: string
  resources: string[]
  reversible: boolean
}

export interface ActionGateResult {
  allowed: boolean
  message?: string
  assessment: ActionAssessment
}

export type ActionApproval = (assessment: ActionAssessment, request: ActionRequest) => Promise<boolean>

export interface ActionGovernor {
  check(request: ActionRequest): Promise<ActionGateResult>
}

const CRITICAL_COMMAND = /\b(rm\s+-rf|rm\s+--no-preserve-root|mkfs|dd\s+if=|shutdown|reboot|poweroff|drop\s+(database|table)|truncate\s+table|git\s+(push|reset\s+--hard|clean\s+-fd)|force[- ]push|sudo\b|chmod\s+777|chown\s+-R|kill\s+-9|kubectl\s+(apply|delete|rollout|scale)|helm\s+(install|upgrade|uninstall)|docker\s+(push|rm|system\s+prune)|terraform\s+(apply|destroy)|prisma\s+migrate\s+(deploy|reset)|alembic\s+upgrade|drizzle-kit\s+push|npm\s+publish|pnpm\s+publish|bun\s+publish|vercel\s+.*--prod|fly\s+deploy|railway\s+up|gcloud\s+.*\bdeploy\b|aws\s+(cloudformation|ecs|rds|lambda)|curl[^\n|]*\|\s*(sh|bash)|wget[^\n|]*\|\s*(sh|bash)|deploy\s+(to\s+)?prod(uction)?|send\s+.*(email|message)|publish\b|tweet\b|buy\b|purchase\b|checkout\b|transfer\b|wire\b)\b/i
const REVIEW_COMMAND = /\b(git\s+commit|npm\s+install|pnpm\s+install|yarn\s+add|bun\s+(add|install)|pip\s+install|docker\s+build|docker\s+run|curl\b|wget\b|ssh\b|scp\b|gh\s+pr|deploy\b)\b/i
const SECRET_KEY = /(password|passwd|token|secret|api[-_]?key|authorization|cookie|credential)/i
const SENSITIVE_READ_COMMAND = /\b(cat|less|head|tail|sed|awk|grep|printenv|env|set)\b[^\n]*(\.env|id_rsa|\.ssh|credentials?|secret|token|password|shadow)\b/i
const EXTERNAL_WRITE_COMMAND = /\b(curl|wget)\b[^\n]*(--data(?:-raw)?|\s-d\s|\s-X\s*(POST|PUT|PATCH|DELETE)|--upload-file|--form)\b/i
const INTERNAL_SAFE_TOOLS = new Set(['flag_risk', 'submit_route', 'submit_proposal', 'submit_verdict', 'submit_lessons', 'delegate_tasks'])

export function assessAction(request: ActionRequest, cwd = currentAgent().cwd ?? process.cwd()): ActionAssessment {
  const { name, input } = request
  if (INTERNAL_SAFE_TOOLS.has(name)) return assessment('safe', 'allow', `${name} records structured control-flow metadata`, name, [], true)
  const values = Object.values(input).filter((value): value is string => typeof value === 'string')
  const joined = values.join(' ')
  const resources = values.filter((value) => /[\\/]|https?:\/\//i.test(value)).slice(0, 4)

  if (name === 'run_command') return assessCommand(joined, cwd)

  if (name === 'presentation') {
    return assessment('review', 'approve', 'presentation generation creates a derived document artifact', 'presentation.from_workbook', resources, true)
  }

  if (name === 'production_readiness') {
    return assessment('safe', 'allow', 'production readiness is a repository-only, read-only evidence audit', 'production_readiness', resources, true)
  }

  if (name === 'environment') {
    return assessment('safe', 'allow', 'environment discovery is a local, read-only capability snapshot', 'environment.inspect', resources, true)
  }

  if (name === 'finance') {
    return assessment('safe', 'allow', 'finance calculations are deterministic and do not mutate external state', 'finance.analysis', resources, true)
  }

  if (name === 'data_science') {
    const path = typeof input.path === 'string' ? input.path : ''
    return path && isOutside(path, cwd)
      ? assessment('review', 'approve', 'data-science analysis may access data outside the active workspace', 'data_science', [path], true)
      : assessment('safe', 'allow', 'data-science analysis is read-only and does not mutate the dataset', 'data_science', resources, true)
  }

  if (name === 'spreadsheet') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    if (action === 'write') return assessment('review', 'approve', 'spreadsheet write changes a workbook and creates an output artifact', 'spreadsheet.write', resources, true)
    return assessment('safe', 'allow', `spreadsheet ${action} is read-only analysis or audit`, `spreadsheet.${action}`, resources, true)
  }

  if (name === 'communication') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    if (action === 'send') return assessment('critical', 'approve', 'communication send creates an external message or event', 'communication.send', resources, false)
    if (action === 'verify') return assessment('review', 'approve', 'communication verification reads external delivery state', 'communication.verify', resources, true)
    return assessment('safe', 'allow', `communication ${action} only manages a durable draft locally`, `communication.${action}`, resources, true)
  }

  if (name === 'browser') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    if (['status', 'navigate', 'refresh', 'back', 'forward', 'snapshot', 'extract', 'scroll', 'wait', 'wait_for'].includes(action)) {
      return assessment('safe', 'allow', `browser ${action} is observational or navigation-only`, `browser.${action}`, resources, true)
    }
    return assessment('critical', 'approve', `browser ${action} changes page state and needs an authorization record`, `browser.${action}`, resources, false)
  }

  if (name === 'write_file' || name === 'edit_file') {
    const path = typeof input.path === 'string' ? input.path : ''
    const outside = path.length > 0 && isOutside(path, cwd)
    return outside
      ? assessment('critical', 'approve', `${name} targets a path outside the active workspace`, name, path ? [path] : [], false)
      : assessment('safe', 'allow', `${name} is workspace-scoped and checkpointable`, name, path ? [path] : [], true)
  }

  if (name === 'read_file' || name === 'list_files' || name === 'grep' || name === 'recall' || name === 'board_read' || name === 'board_post') {
    const path = typeof input.path === 'string' ? input.path : ''
    return path && isOutside(path, cwd)
      ? assessment('review', 'approve', `${name} may access data outside the active workspace`, name, [path], true)
      : assessment('safe', 'allow', `${name} is read-only or coordination-only`, name, resources, true)
  }

  if (name === 'preview' || name === 'task') {
    return assessment('review', 'approve', `${name} can create an external process or delegate work`, name, resources, true)
  }

  return assessment('critical', 'approve', `unknown tool ${name} has no declared safety contract`, name, resources, false)
}

export function createActionGovernor(options: { mode?: GovernanceMode; approve?: ActionApproval; cwd?: string } = {}): ActionGovernor {
  const mode = options.mode ?? 'unattended'
  let approvalQueue = Promise.resolve()

  return {
    async check(request) {
      const assessment = assessAction(request, options.cwd)
      if (assessment.decision === 'allow') return { allowed: true, assessment }

      // In unattended mode, reversible review actions proceed. This preserves the
      // speed of autonomous coding while keeping irreversible actions gated.
      if (assessment.risk === 'review' && mode === 'unattended') {
        return { allowed: true, assessment: { ...assessment, decision: 'allow' } }
      }

      if (!options.approve) {
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: `Action blocked by Elia’s autonomy governor: ${assessment.reason}. No approval channel is available for this run.`,
        }
      }

      // Terminal prompts must never interleave when several workers request an
      // approval at once. Queue the decision without serialising the work itself.
      const previous = approvalQueue
      let release!: () => void
      approvalQueue = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        const approved = await options.approve(assessment, request)
        if (approved) return { allowed: true, assessment: { ...assessment, decision: 'allow' } }
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: `Action denied by the user: ${assessment.reason}`,
        }
      } finally {
        release()
      }
    },
  }
}

const governorStorage = new AsyncLocalStorage<ActionGovernor>()
const defaultGovernor = createActionGovernor({ mode: 'unattended' })

export function withActionGovernor<T>(governor: ActionGovernor, fn: () => Promise<T>): Promise<T> {
  return governorStorage.run(governor, fn)
}

export function activeActionGovernor(): ActionGovernor {
  return governorStorage.getStore() ?? defaultGovernor
}

export function auditActionEvent(event: ToolEvent, governor?: ActionAssessment): void {
  // Kept as a small adapter so callers can use the same event shape for live UI,
  // the append-only action ledger, and autonomous run journals.
  void governor
  void event
}

function assessCommand(command: string, cwd: string): ActionAssessment {
  if (SENSITIVE_READ_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command may read credentials or protected system data', 'shell.sensitive-read', [], false)
  }
  if (EXTERNAL_WRITE_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command may transmit data to an external system', 'shell.external-write', [], false)
  }
  if (CRITICAL_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command may cause an irreversible or external side effect', 'shell', [], false)
  }
  if (REVIEW_COMMAND.test(command)) {
    return assessment('review', 'approve', 'shell command changes dependencies, reaches a remote system, or creates a durable artifact', 'shell', [], true)
  }
  return assessment('safe', 'allow', 'shell command is exploratory, local, or verification-oriented', 'shell', [], true)
}

function assessment(
  risk: ActionRisk,
  decision: ActionDecision,
  reason: string,
  intent: string,
  resources: string[],
  reversible: boolean,
): ActionAssessment {
  return { risk, decision, reason, intent, resources, reversible }
}

function isOutside(path: string, cwd: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(cwd, path)
  return rel === '..' || rel.startsWith(`..${path.includes('\\') ? '\\' : '/'}`)
}

export function redactActionInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key) || (tool === 'browser' && input.action === 'type' && key === 'text') || (tool === 'communication' && ['body', 'recipient', 'cc', 'bcc', 'attachments'].includes(key))) {
      output[key] = '[REDACTED]'
      continue
    }
    if (typeof value === 'string') output[key] = value.length > 2000 ? `${value.slice(0, 2000)}…` : value
    else if (Array.isArray(value)) output[key] = value.slice(0, 20)
    else output[key] = value
  }
  return output
}
