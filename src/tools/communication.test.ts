import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { communicationTool } from './communication.ts'
import { redactActionInput } from '../autonomy/governor.ts'

// Adapters are small script files run as `bun <relative path>`: an inline
// `bun -e "..."` survives neither cmd.exe's quoting nor its stdin piping, and a
// relative path keeps a space-containing temp dir out of the command line.
const ADAPTER_DIR = join('.elia', 'test-communication-adapters')
mkdirSync(join(process.cwd(), ADAPTER_DIR), { recursive: true })
afterAll(() => rmSync(join(process.cwd(), ADAPTER_DIR), { recursive: true, force: true }))

function adapter(name: string, source: string): string {
  writeFileSync(join(process.cwd(), ADAPTER_DIR, `${name}.ts`), source)
  return `bun ${ADAPTER_DIR.replaceAll('\\', '/')}/${name}.ts`
}

const ECHO_ADAPTER = adapter('echo', 'process.stdout.write(await Bun.stdin.text())\n')

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

test('send runs directly and records a connector receipt — approval is the action governor\'s job, not this tool\'s', async () => {
  const previous = process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
  process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = ECHO_ADAPTER
  const created = await communicationTool.execute({ action: 'draft', channel: 'message', recipient: '@cofounder', body: 'Please review the release.' })
  const draftId = draftIdFrom(created)
  try {
    const sent = await communicationTool.execute({ action: 'send', draftId })
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

test('verify rescues an in-flight draft stuck as sending through the connector', async () => {
  const previous = process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
  process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = ECHO_ADAPTER
  const created = await communicationTool.execute({ action: 'draft', channel: 'message', recipient: '@ops', body: 'Check the release gate.' })
  const draftId = draftIdFrom(created)
  try {
    const draftPath = join(process.cwd(), '.elia', 'communications', `${draftId}.json`)
    const stored = JSON.parse(readFileSync(draftPath, 'utf8')) as { status: string }
    expect(stored.status).toBe('draft')
    writeFileSync(draftPath, JSON.stringify({ ...JSON.parse(readFileSync(draftPath, 'utf8')), status: 'sending' }))
    const verified = await communicationTool.execute({ action: 'verify', draftId })
    expect(verified).toContain('Delivery verification succeeded')
    const updated = JSON.parse(readFileSync(draftPath, 'utf8')) as { status: string }
    expect(updated.status).toBe('verified')
  } finally {
    if (previous === undefined) delete process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
    else process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = previous
    rmSync(`${process.cwd()}/.elia/communications/${draftId}.json`, { force: true })
  }
})

async function sendWithAdapter(command: string): Promise<{ sent: string; stored: { status: string; error?: string } }> {
  const previous = process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
  process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = command
  const created = await communicationTool.execute({ action: 'draft', channel: 'message', recipient: '@ops', body: 'hello' })
  const draftId = draftIdFrom(created)
  const draftPath = join(process.cwd(), '.elia', 'communications', `${draftId}.json`)
  try {
    const sent = await communicationTool.execute({ action: 'send', draftId })
    return { sent, stored: JSON.parse(readFileSync(draftPath, 'utf8')) as { status: string; error?: string } }
  } finally {
    if (previous === undefined) delete process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND
    else process.env.ELIA_COMMUNICATION_BRIDGE_COMMAND = previous
    rmSync(draftPath, { force: true })
  }
}

test('an adapter that exits 0 without a JSON receipt is not recorded as a delivery', async () => {
  for (const command of [
    adapter('plain-text', "await Bun.stdin.text(); console.log('queued maybe')\n"),
    adapter('silent', 'await Bun.stdin.text()\n'),
    adapter('json-array', "await Bun.stdin.text(); console.log('[1,2]')\n"),
  ]) {
    const { sent, stored } = await sendWithAdapter(command)
    expect(sent).toContain('was not confirmed as sent')
    expect(stored.status).toBe('send_failed')
  }
})

test('adapter stderr is redacted before it is persisted or returned', async () => {
  const secret = 'sk-live-0123456789abcdefghijklmnopqrstuvwx'
  const { sent, stored } = await sendWithAdapter(adapter('leaky', `await Bun.stdin.text(); console.error('auth failed: Authorization: Bearer ${secret}'); process.exit(3)\n`))
  expect(sent).toContain('exited with code 3')
  expect(sent).not.toContain(secret)
  expect(stored.error ?? '').not.toContain(secret)
  expect(stored.error ?? '').toContain('[REDACTED]')
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
