import { rmSync } from 'node:fs'
import { expect, test } from 'bun:test'
import { communicationTool } from './communication.ts'
import { redactActionInput } from '../autonomy/governor.ts'

function draftIdFrom(result: string): string {
  const id = result.match(/comm_[a-z0-9]+/)?.[0]
  if (!id) throw new Error(`missing draft id in: ${result}`)
  return id
}

test('communication drafts persist and remain unsent until explicitly approved', async () => {
  const created = await communicationTool.execute({ action: 'draft', channel: 'email', recipient: 'cofounder@example.com', subject: 'Launch update', body: 'The launch checklist is ready.' })
  const draftId = draftIdFrom(created)
  try {
    const inspected = await communicationTool.execute({ action: 'inspect', draftId })
    expect(inspected).toContain('cofounder@example.com')
    expect(inspected).toContain('The launch checklist is ready.')
    const noAdapter = await communicationTool.execute({ action: 'send', draftId })
    expect(noAdapter).toContain('no communication connector is configured')
  } finally {
    rmSync(`${process.cwd()}/.elia/communications/${draftId}.json`, { force: true })
  }
})

test('send requires an exact token and records a connector receipt', async () => {
  const previous = process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
  process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = 'cat'
  const created = await communicationTool.execute({ action: 'draft', channel: 'message', recipient: '@cofounder', body: 'Please review the release.' })
  const draftId = draftIdFrom(created)
  try {
    const pending = await communicationTool.execute({ action: 'send', draftId })
    const token = pending.match(/confirmationToken=(communication_approval_[^\. ]+)/)?.[1]
    expect(token).toBeDefined()
    const changed = await communicationTool.execute({ action: 'send', draftId, confirmationToken: `${token}changed` })
    expect(changed).toContain('Approval required')
    const sent = await communicationTool.execute({ action: 'send', draftId, confirmationToken: token })
    expect(sent).toContain('sent through message')
    const verified = await communicationTool.execute({ action: 'verify', draftId })
    expect(verified).toContain('Delivery verification succeeded')
    const repeated = await communicationTool.execute({ action: 'send', draftId })
    expect(repeated).toContain('already sent')
  } finally {
    if (previous === undefined) delete process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
    else process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = previous
    rmSync(`${process.cwd()}/.elia/communications/${draftId}.json`, { force: true })
  }
})

test('communication audit input redacts message contents and recipients', () => {
  const redacted = redactActionInput('communication', {
    action: 'send',
    recipient: 'person@example.com',
    body: 'private message',
    subject: 'Public subject',
  })
  expect(redacted.recipient).toBe('[REDACTED]')
  expect(redacted.body).toBe('[REDACTED]')
  expect(redacted.subject).toBe('Public subject')
})


test('communication status reports configured capabilities honestly', async () => {
  const previousBridge = process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
  delete process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
  try {
    const status = JSON.parse(await communicationTool.execute({ action: 'status' })) as { drafting: string; sending: string; adapter: string }
    expect(status.drafting).toBe('available locally')
    expect(status.sending).toBe('not configured')
    expect(status.adapter).toBe('none')
  } finally {
    if (previousBridge === undefined) delete process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
    else process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = previousBridge
  }
})
