// Headless smoke of the real /quickchat fast-tier path. This is the one thing
// that cannot be proven in the test suite: a REAL provider round-trip. It boots
// a real session bus, runs one /quickchat ask through the real
// resolveFastResponder (config -> runAgentLoop -> provider), and prints the
// answer plus which tier was used.
//
//   ANTHROPIC_API_KEY=... bun run scripts/quickchat-smoke.ts ["question"]
//
// Exit 0 = a real model answered the question.
// Exit 1 = no usable answer (missing/bad key, network, provider misconfiguration),
// or the run crashed.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../src/autonomy/context.ts'
import { config } from '../src/config.ts'
import { fastTierNote, runQuickchat, selectFastTier } from '../src/quickchat/quickchat.ts'
import { createSessionBus } from '../src/session/bus.ts'
import { makeSessionName } from '../src/session/types.ts'

const question = process.argv[2] ?? 'In one short paragraph: is anything in this session currently broken or risky?'

const bus = createSessionBus()
const session = bus.create(makeSessionName('quickchat-smoke'))
bus.setActiveSession(session.id)

const logDir = mkdtempSync(join(tmpdir(), 'quickchat-smoke-'))

function quickchatFailed(answer: string): boolean {
  return (
    answer.length === 0 ||
    answer.startsWith('quickchat failed') ||
    answer.startsWith('quickchat timed out') ||
    answer === 'quickchat cancelled'
  )
}

async function main(): Promise<number> {
  const tier = selectFastTier(config)
  const note = fastTierNote(config)
  console.log(`[quickchat-smoke] fast tier: ${tier.providerName}/${tier.model}${note ? ' (aliased to the deep tier)' : ''}`)

  const outcome = await withAgentIdentity({ name: 'quickchat-smoke', role: 'lead', cwd: process.cwd() }, () =>
    runQuickchat({ sessionRef: session.id, question, bus, logDir }),
  )

  console.log('\n--- answer ---')
  console.log(outcome.answer)

  if (quickchatFailed(outcome.answer)) {
    console.error('\n[quickchat-smoke] no usable answer — check your provider key, network, and fast-tier config.')
    return 1
  }

  console.log(`\n[quickchat-smoke] ok — ${tier.label} answered; overlay closed.`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[quickchat-smoke] error:', error instanceof Error ? error.message : error)
    process.exit(1)
  })