import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../config.ts'
import { redactSecrets } from './redact.ts'

const COMMUNICATION_ID = /^[a-zA-Z0-9_-]{8,100}$/
const BODY_EXCERPT = 400

/**
 * What a communication send would deliver, so the card shows who gets what rather than "send".
 * The send input names only a draft id; the draft itself is read from the draft store at the
 * moment the card is built. Everything shown is redacted.
 */
function communicationPreviewLines(input: Record<string, unknown>): string[] | undefined {
  const action = typeof input.action === 'string' ? input.action : ''
  if (action !== 'send' && action !== 'verify' && action !== 'draft') return undefined
  let source: Record<string, unknown> = input
  if (action !== 'draft') {
    const id = typeof input.draftId === 'string' ? input.draftId : ''
    if (!COMMUNICATION_ID.test(id)) return undefined
    const file = join(paths.state, 'communications', `${id}.json`)
    if (!existsSync(file)) return ['  (draft not found — nothing to preview)']
    try {
      source = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      return ['  (draft unreadable — nothing to preview)']
    }
  }
  const text = (value: unknown): string => (typeof value === 'string' ? redactSecrets(value.replace(/\s+/g, ' ').trim()) : '')
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => redactSecrets(item)) : [])
  const cc = list(source.cc)
  const bcc = list(source.bcc)
  const attachments = list(source.attachments)
  const body = text(source.body)
  return [
    `  channel: ${text(source.channel) || '(none)'}`,
    `  to: ${text(source.recipient) || '(none)'}`,
    ...(cc.length ? [`  cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`  bcc: ${bcc.join(', ')}`] : []),
    ...(text(source.subject) ? [`  subject: ${text(source.subject)}`] : []),
    ...(attachments.length ? [`  attachments: ${attachments.join(', ')}`] : []),
    `  body: ${body.length > BODY_EXCERPT ? `${body.slice(0, BODY_EXCERPT)}… (${body.length} chars)` : body || '(empty)'}`,
  ]
}

/**
 * A compact preview of what an about-to-be-approved action would do, so the
 * approval card carries the actual change instead of just its name. Diff-style
 * (`-` / `+`) lines are colored by the Confirm component; other lines render
 * muted.
 */
export function approvalPreviewLines(name: string, input: Record<string, unknown>): string[] | undefined {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')

  if (name === 'edit_file') {
    const path = str(input.path)
    const before = str(input.old_string)
    const after = str(input.new_string)
    if (!before && !after) return undefined
    return [
      ...(path ? [`  ${path}`] : []),
      ...(input.replace_all === true ? ['  (every occurrence)'] : []),
      ...before.split('\n').map((line) => `- ${line}`),
      ...after.split('\n').map((line) => `+ ${line}`),
    ]
  }

  if (name === 'write_file') {
    const path = str(input.path)
    const lines = str(input.content).split('\n')
    return [
      ...(path ? [`  ${path}  (${lines.length} line${lines.length === 1 ? '' : 's'})`] : []),
      ...lines.slice(0, 30).map((line) => `+ ${line}`),
    ]
  }

  if (name === 'run_command' || (name === 'process' && input.action === 'start')) {
    const command = str(input.command)
    if (!command) return undefined
    return [`  $ ${command}`, ...(str(input.cwd) ? [`  in ${str(input.cwd)}`] : [])]
  }

  if (name === 'communication') return communicationPreviewLines(input)

  if (name === 'run_program') {
    const program = str(input.program).trim()
    const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : []
    if (!program) return undefined
    return [`  $ ${[program, ...args.map((arg) => JSON.stringify(arg))].join(' ')}`, ...(str(input.cwd) ? [`  in ${str(input.cwd)}`] : [])]
  }

  return undefined
}
