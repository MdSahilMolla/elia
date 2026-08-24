import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findAvailableUpdate, renderUpdateNotice } from './updateCheck.ts'

const testDirs: string[] = []

function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-update-check-'))
  testDirs.push(dir)
  return join(dir, 'update-check.json')
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('reports and caches a newer npm version', async () => {
  const path = cachePath()
  const update = await findAvailableUpdate('0.1.0', {
    cachePath: path,
    now: 1_000,
    fetcher: async () => Response.json({ version: '0.1.1' }),
  })

  expect(update).toEqual({ currentVersion: '0.1.0', latestVersion: '0.1.1' })
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ checkedAt: 1_000, latestVersion: '0.1.1' })
  expect(renderUpdateNotice(update!)).toContain('npm install --global @mdsahilmolla/elia@latest')
})

test('uses a fresh cache without contacting npm', async () => {
  const path = cachePath()
  writeFileSync(path, JSON.stringify({ checkedAt: 1_000, latestVersion: '0.2.0' }))
  let fetched = false

  const update = await findAvailableUpdate('0.1.0', {
    cachePath: path,
    now: 1_001,
    fetcher: async () => {
      fetched = true
      return Response.json({ version: '9.9.9' })
    },
  })

  expect(fetched).toBe(false)
  expect(update?.latestVersion).toBe('0.2.0')
})

test('stays silent when current, offline, or given invalid registry data', async () => {
  const current = await findAvailableUpdate('0.1.1', {
    cachePath: cachePath(),
    fetcher: async () => Response.json({ version: '0.1.1' }),
  })
  const offline = await findAvailableUpdate('0.1.1', {
    cachePath: cachePath(),
    fetcher: async () => { throw new Error('offline') },
  })
  const invalid = await findAvailableUpdate('0.1.1', {
    cachePath: cachePath(),
    fetcher: async () => Response.json({ version: 'not-semver' }),
  })

  expect(current).toBeUndefined()
  expect(offline).toBeUndefined()
  expect(invalid).toBeUndefined()
})

test('stable releases supersede prereleases but older releases do not', async () => {
  const stable = await findAvailableUpdate('1.0.0-beta.1', {
    cachePath: cachePath(),
    fetcher: async () => Response.json({ version: '1.0.0' }),
  })
  const older = await findAvailableUpdate('1.1.0', {
    cachePath: cachePath(),
    fetcher: async () => Response.json({ version: '1.0.9' }),
  })

  expect(stable?.latestVersion).toBe('1.0.0')
  expect(older).toBeUndefined()
})
