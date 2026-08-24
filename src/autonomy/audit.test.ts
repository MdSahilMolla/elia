import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendActionAudit, readActionLedger, writeRunReceipt } from './audit.ts'
import type { ToolEvent } from '../agentLoop.ts'

const runId = `audit-test-${Date.now().toString(36)}`
const runDir = join(process.cwd(), '.elia', 'runs', runId)

describe('autonomy audit ledger and receipt', () => {
  test('writes a redacted action record and a human-readable receipt', async () => {
    const event: ToolEvent = {
      name: 'browser',
      input: { action: 'type', text: 'secret password' },
      result: 'typed into the page',
      isError: false,
      durationMs: 12,
      cached: false,
      assessment: {
        risk: 'critical',
        decision: 'block',
        reason: 'browser type changes page state',
        intent: 'browser.type',
        resources: [],
        reversible: false,
      },
    }

    appendActionAudit(event, runId)
    const actions = readActionLedger(runId)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.input.text).toBe('[REDACTED]')
    expect(actions[0]?.decision).toBe('block')

    writeRunReceipt({
      runId,
      goal: 'test governed execution',
      outcome: 'needs-attention',
      lessons: ['critical browser actions stay blocked without approval'],
      actionBudget: { maxActions: 2, consumed: 2, exhausted: true, blockedByBudget: 1 },
      events: [
        { seq: 1, at: Date.now(), kind: 'verify', data: { passed: false, command: 'bun test' } },
      ],
    })

    const receipt = Bun.file(join(runDir, 'receipt.json'))
    expect(await receipt.exists()).toBe(true)
    const parsed = (await receipt.json()) as { actions: { total: number; blocked: number }; actionBudget: { maxActions: number; consumed: number; exhausted: boolean; blockedByBudget: number }; outcome: string }
    expect(parsed.outcome).toBe('needs-attention')
    expect(parsed.actions.total).toBe(1)
    expect(parsed.actions.blocked).toBe(1)
    expect(parsed.actionBudget).toEqual({ maxActions: 2, consumed: 2, exhausted: true, blockedByBudget: 1 })
    expect(await Bun.file(join(runDir, 'receipt.md')).text()).toContain('**Action budget:** 2/2 consumed (exhausted)')
  })

  afterAll(() => {
    rmSync(runDir, { recursive: true, force: true })
  })
})
