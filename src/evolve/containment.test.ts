import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { ContainmentRequired, attest, describeAttestation, evolveBoxMode, hostRunCount, noteHostRun, runGate } from './containment.ts'
import { findBoxBinary, recentBoxReceipts, resetBoxReceiptsForTests, type BoxReceipt } from '../sandbox/box.ts'

const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
  resetBoxReceiptsForTests()
})

const REPO = resolve(import.meta.dir, '..', '..')

function receipt(over: { exit?: Partial<BoxReceipt['exit']>; network?: BoxReceipt['network'] } = {}): BoxReceipt {
  const { exit, ...rest } = over
  return {
    schema: 'elia-box.receipt/1',
    id: 'id',
    backend: 'seatbelt',
    argv: [],
    policyHash: 'p',
    exit: { code: 0, signal: null, timedOut: false, interrupted: false, limitHit: null, stragglersKilled: false, ...exit },
    usage: { wallMs: 1, cpuUserMs: 1, cpuSysMs: 1, maxRssKb: 1, peakTreeRssKb: 1, peakProcs: 1 },
    output: { stdoutBytes: 0, stderrBytes: 0, stdoutSha256: '', stderrSha256: '', truncated: false },
    workspace: { path: '/w', mode: 'inplace', forked: false, copyOnWrite: false, forkPath: null, snapshot: null },
    network: { mode: 'none', allow: [], broker: null },
    containment: { enforced: [], notEnforced: [] },
    receiptHash: `h${Math.random()}`,
    ...rest,
  }
}

describe('ELIA_EVOLVE_BOX', () => {
  test('off unless asked; require is its own level', () => {
    delete process.env.ELIA_EVOLVE_BOX
    expect(evolveBoxMode()).toBe('off')
    for (const [v, want] of [['1', 'on'], ['on', 'on'], ['TRUE', 'on'], ['require', 'require'], ['REQUIRE', 'require'], ['maybe', 'off']] as const) {
      process.env.ELIA_EVOLVE_BOX = v
      expect(evolveBoxMode()).toBe(want)
    }
  })
})

describe('attestation', () => {
  test('counts only receipts after the mark, and says what they were held to', () => {
    const all = [receipt(), receipt({ network: { mode: 'open', allow: [], broker: null } }), receipt({ exit: { limitHit: 'memory' } })]
    const a = attest(1, all)
    expect(a.boxed).toBe(2)
    expect(a.networks.sort()).toEqual(['none', 'open'].sort())
    expect(a.cutShort).toBe(1)
    expect(a.receiptHashes).toHaveLength(2)
  })

  test('an unboxed gate is described as uncontained, never as attested', () => {
    expect(describeAttestation(attest(0, []))).toContain('uncontained')
    expect(describeAttestation(attest(0, [receipt()]))).toContain('1 sealed receipt')
  })
})

describe('host runs of candidate code', () => {
  test('a boxed receipt beside host runs is reported as partial containment, not as containment', () => {
    const since = hostRunCount()
    noteHostRun()
    const a = attest(0, [receipt()], since)
    expect(a.boxed).toBe(1)
    expect(a.unboxed).toBe(1)
    expect(describeAttestation(a)).toContain('only part')
    expect(attest(0, [receipt()], hostRunCount()).unboxed).toBe(0)
  })

  test('a gate that falls back to the host is counted as a host run', async () => {
    process.env.ELIA_EVOLVE_BOX = 'on'
    process.env.ELIA_BOX_BIN = '/nonexistent/elia-box'
    const since = hostRunCount()
    await runGate('echo fallback', 10_000, tmpdir(), REPO)
    expect(attest(0, [receipt()], since).unboxed).toBe(1)
  })
})

describe('gate routing', () => {
  test('off: runs on the host and records nothing', async () => {
    delete process.env.ELIA_EVOLVE_BOX
    const r = await runGate('echo host', 10_000, tmpdir(), REPO)
    expect(r.stdout.trim()).toBe('host')
    expect(recentBoxReceipts()).toHaveLength(0)
  })

  test('require: fails closed when the box cannot run', async () => {
    process.env.ELIA_EVOLVE_BOX = 'require'
    process.env.ELIA_BOX_BIN = '/nonexistent/elia-box'
    await expect(runGate('echo x', 10_000, tmpdir(), REPO)).rejects.toBeInstanceOf(ContainmentRequired)
  })

  test('on: falls back to the host when the box cannot run', async () => {
    process.env.ELIA_EVOLVE_BOX = 'on'
    process.env.ELIA_BOX_BIN = '/nonexistent/elia-box'
    const r = await runGate('echo fallback', 10_000, tmpdir(), REPO)
    expect(r.stdout.trim()).toBe('fallback')
  })
})

const live = findBoxBinary() && process.platform === 'darwin' ? test : test.skip
live('live: a gate command really runs in the box and leaves a receipt', async () => {
  process.env.ELIA_EVOLVE_BOX = 'require'
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'eb-gate-')))
  try {
    const r = await runGate('echo boxed; test -z "$ANTHROPIC_API_KEY" && echo clean-env', 20_000, dir, REPO)
    expect(r.stdout).toContain('boxed')
    expect(r.stdout).toContain('clean-env')
    expect(recentBoxReceipts()).toHaveLength(1)
    expect(attest(0).networks).toEqual(['none'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
