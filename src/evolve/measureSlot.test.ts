import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claimMeasureSlot, describeHolder, MAX_HOLD_MS, measuringNow, type SlotHolder } from './measureSlot.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function slotPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-measure-slot-'))
  dirs.push(dir)
  return join(dir, 'bench', 'measuring.json')
}

function recordHolder(path: string, holder: Partial<SlotHolder>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid: 4242, command: 'elia bench --all', startedAt: Date.now(), host: hostname(), ...holder }))
}

test('the first measurement claims the checkout and a second is refused while it runs', () => {
  const path = slotPath()
  const first = claimMeasureSlot('elia bench --all', path)
  expect(first.ok).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid, command: 'elia bench --all' })

  const second = claimMeasureSlot('elia evolve -n 3', path)
  expect(second.ok).toBe(false)
  if (!second.ok) expect(second.holder.command).toBe('elia bench --all')
  expect(measuringNow(path)?.command).toBe('elia bench --all')

  if (first.ok) first.release()
  expect(existsSync(path)).toBe(false)
  expect(measuringNow(path)).toBeUndefined()
  expect(claimMeasureSlot('elia evolve -n 3', path).ok).toBe(true)
})

test('a holder that died — finished, crashed, or killed with the laptop asleep — is taken over', () => {
  const path = slotPath()
  recordHolder(path, { pid: 4242 })
  const claim = claimMeasureSlot('elia evolve -n 3', path, { alive: () => false })
  expect(claim.ok).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8')).command).toBe('elia evolve -n 3')
})

test('a holder older than any sweep is a reused pid, not a measurement', () => {
  const path = slotPath()
  recordHolder(path, { startedAt: Date.now() - MAX_HOLD_MS - 1 })
  expect(measuringNow(path, { alive: () => true })).toBeUndefined()
  expect(claimMeasureSlot('elia bench', path, { alive: () => true }).ok).toBe(true)
})

test('a holder on another machine cannot be checked, so it is trusted until it ages out', () => {
  const path = slotPath()
  recordHolder(path, { host: 'some-other-host', pid: 1 })
  expect(claimMeasureSlot('elia bench', path, { alive: () => false }).ok).toBe(false)
})

test('release clears only its own claim, never one that took the slot over', () => {
  const path = slotPath()
  const mine = claimMeasureSlot('elia bench', path)
  expect(mine.ok).toBe(true)
  // Judged gone and taken over by someone else in the meantime.
  writeFileSync(path, JSON.stringify({ pid: 4242, command: 'elia evolve', startedAt: Date.now(), host: hostname() }))
  if (mine.ok) mine.release()
  expect(JSON.parse(readFileSync(path, 'utf8')).command).toBe('elia evolve')
})

test('a half-written or foreign slot file reads as no holder', () => {
  const path = slotPath()
  recordHolder(path, {})
  writeFileSync(path, '{"pid": ')
  expect(measuringNow(path)).toBeUndefined()
  expect(claimMeasureSlot('elia bench', path).ok).toBe(true)
})

test('the refusal says who is measuring, for how long, and why waiting matters', () => {
  const line = describeHolder({ pid: 53864, command: 'elia bench --all', startedAt: 0, host: 'h' }, 25 * 60_000)
  expect(line).toContain('`elia bench --all` (pid 53864) has been measuring in this checkout for 25 minute(s)')
  expect(line).toContain('split the provider')
})

test('a measurement stopped with SIGTERM gives the slot back through the shared shutdown path', async () => {
  const path = slotPath()
  // What `elia bench` / `elia evolve` do: index.ts installs the shutdown
  // handlers, then the command claims the slot and measures for a long time.
  const script = [
    `import { installShutdownHandlers } from ${JSON.stringify(join(import.meta.dir, '..', 'ui', 'shutdown.ts'))}`,
    `import { claimMeasureSlot } from ${JSON.stringify(join(import.meta.dir, 'measureSlot.ts'))}`,
    'installShutdownHandlers()',
    `const slot = claimMeasureSlot('elia bench --all', ${JSON.stringify(path)})`,
    "console.log(slot.ok ? 'claimed' : 'refused')",
    'setInterval(() => {}, 1000)',
  ].join('\n')
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const reader = child.stdout.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(first.trim()).toBe('claimed')
  expect(measuringNow(path)?.pid).toBe(child.pid)

  child.kill('SIGTERM')
  await child.exited
  expect(existsSync(path)).toBe(false)
})
