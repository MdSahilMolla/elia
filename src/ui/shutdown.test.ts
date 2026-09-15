import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

// An autonomous run writes its receipt at the end of the happy path, so a run
// killed by Ctrl+C, a closed terminal or SIGTERM used to leave nothing behind —
// the signal handlers run the registered cleanups and then call process.exit,
// and the run's own cleanup only calls controller.abort(), which returns
// immediately. Whether a dying run still records what it was doing therefore
// depends on a synchronous cleanup's writes actually landing before the exit.
// That cannot be observed in-process: process.exit would take the test runner
// with it, so it takes a real child.
test('a synchronous cleanup finishes writing before the process exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-shutdown-'))
  made.push(dir)
  const receipt = join(dir, 'receipt.json')
  const script = join(dir, 'child.ts')
  const shutdownModule = pathToFileURL(join(import.meta.dir, 'shutdown.ts')).href

  writeFileSync(
    script,
    [
      `const { registerShutdownCleanup, gracefulShutdown } = await import(${JSON.stringify(shutdownModule)})`,
      // Exactly the shape of a run's finalizer: synchronous, and it writes.
      `registerShutdownCleanup(() => { require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ outcome: 'interrupted' })) })`,
      // The same call all three signal handlers make.
      `await gracefulShutdown(130)`,
    ].join('\n'),
  )

  const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' })
  const code = await child.exited

  expect(code).toBe(130)
  expect(existsSync(receipt)).toBe(true)
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ outcome: 'interrupted' })
}, 30_000)

test('a cleanup registered later runs before one registered earlier', async () => {
  // The run's abort cleanup is registered first, when the command starts; the
  // finalizer is registered later, once the run has state worth recording. That
  // ordering is what keeps the abort from racing the receipt.
  const dir = mkdtempSync(join(tmpdir(), 'elia-shutdown-order-'))
  made.push(dir)
  const order = join(dir, 'order.txt')
  const script = join(dir, 'child.ts')
  const shutdownModule = pathToFileURL(join(import.meta.dir, 'shutdown.ts')).href

  writeFileSync(
    script,
    [
      `const { registerShutdownCleanup, gracefulShutdown } = await import(${JSON.stringify(shutdownModule)})`,
      `const fs = require('node:fs')`,
      `fs.writeFileSync(${JSON.stringify(order)}, '')`,
      `registerShutdownCleanup(() => { fs.appendFileSync(${JSON.stringify(order)}, 'abort,') })`,
      `registerShutdownCleanup(() => { fs.appendFileSync(${JSON.stringify(order)}, 'finalize,') })`,
      `await gracefulShutdown(130)`,
    ].join('\n'),
  )

  await Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' }).exited
  expect(readFileSync(order, 'utf8').split(',').filter(Boolean)).toEqual(['finalize', 'abort'])
}, 30_000)
