import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySteppingStone, archiveNearMiss, areaOf, elites, readArchive, renderSteppingStones, targetOf, type NearMiss } from './archive.ts'

let dir: string
let evolution: string
let sandbox: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-archive-'))
  evolution = join(dir, '.evolution')
  sandbox = join(dir, 'gen-7')
  mkdirSync(join(sandbox, 'src', 'autonomy'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function miss(overrides: Partial<NearMiss> = {}): NearMiss {
  writeFileSync(join(sandbox, 'src', 'autonomy', 'loop.ts'), 'improved loop')
  return {
    generation: 7,
    hypothesis: 'retry the gate once before giving up',
    verdict: 'rejected',
    reason: 'no task improved by more than run-to-run noise',
    sandboxRoot: sandbox,
    changedFiles: ['src/autonomy/loop.ts'],
    base: new Map([['src/autonomy/loop.ts', 'h1']]),
    shownQuality: 0.04,
    gainedShown: ['hist-12'],
    ...overrides,
  }
}

test('descriptors: where a change lives and what it moved', () => {
  expect(areaOf(['src/autonomy/loop.ts', 'src/autonomy/verify.ts'])).toBe('autonomy')
  expect(areaOf(['src/agentLoop.ts'])).toBe('agentLoop')
  expect(areaOf(['src/tools/a.ts', 'src/autonomy/b.ts'])).toBe('cross-cutting')
  expect(targetOf(['hist-1', 'hist-2'])).toBe('hist')
  expect(targetOf(['precise-edit'])).toBe('synthetic')
  expect(targetOf(['hist-1', 'hard-2'])).toBe('mixed')
  expect(targetOf([])).toBe('none')
})

test('only candidates that moved the shown tasks the right way are kept', () => {
  expect(archiveNearMiss(miss({ shownQuality: 0 }), evolution)).toBeUndefined()
  expect(archiveNearMiss(miss({ shownQuality: -0.1 }), evolution)).toBeUndefined()
  const stone = archiveNearMiss(miss(), evolution)!
  expect(stone.area).toBe('autonomy')
  expect(stone.target).toBe('hist')
  expect(readArchive(evolution)).toHaveLength(1)
  expect(readFileSync(join(evolution, 'archive', 'gen-7', 'files', 'src', 'autonomy', 'loop.ts'), 'utf8')).toBe('improved loop')
})

test('MAP-Elites keeps one elite per niche and never offers a promoted change', () => {
  archiveNearMiss(miss({ generation: 1, shownQuality: 0.02 }), evolution)
  archiveNearMiss(miss({ generation: 2, shownQuality: 0.05 }), evolution)
  archiveNearMiss(miss({ generation: 3, shownQuality: 0.03, gainedShown: ['hard-1'] }), evolution)
  archiveNearMiss(miss({ generation: 4, shownQuality: 0.2, verdict: 'promoted' }), evolution)
  const best = elites(readArchive(evolution))
  expect(best.map((entry) => entry.id)).toEqual(['gen-2', 'gen-3'])
  const brief = renderSteppingStones(best)
  expect(brief).toContain('buildOn')
  expect(brief).toContain('gen-2 [autonomy → hist]')
  expect(renderSteppingStones([])).toBe('')
})

test('a stone is laid in only where the source has not moved on', () => {
  const stone = archiveNearMiss(
    miss({ changedFiles: ['src/autonomy/loop.ts', 'src/autonomy/gone.ts'], base: new Map([['src/autonomy/loop.ts', 'h1'], ['src/autonomy/gone.ts', 'h2']]) }),
    evolution,
  )!
  const fresh = join(dir, 'gen-9')
  mkdirSync(join(fresh, 'src', 'autonomy'), { recursive: true })
  writeFileSync(join(fresh, 'src', 'autonomy', 'loop.ts'), 'current loop')
  writeFileSync(join(fresh, 'src', 'autonomy', 'gone.ts'), 'someone edited this since')

  const result = applySteppingStone(stone, evolution, fresh, new Map([['src/autonomy/loop.ts', 'h1'], ['src/autonomy/gone.ts', 'changed']]))
  expect(result.applied).toEqual(['src/autonomy/loop.ts'])
  expect(result.stale).toEqual(['src/autonomy/gone.ts'])
  expect(readFileSync(join(fresh, 'src', 'autonomy', 'loop.ts'), 'utf8')).toBe('improved loop')
  expect(existsSync(join(fresh, 'src', 'autonomy', 'gone.ts'))).toBe(true)
})
