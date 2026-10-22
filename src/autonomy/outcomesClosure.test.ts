import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { formatOutcomeDelay, OutcomeStore, parseOutcomeDelay } from './outcomesClosure.ts'

describe('delayed outcome closure', () => {
  test('parses bounded delays without coupling them to schedule minimums', () => {
    expect(parseOutcomeDelay('1s')).toBe(1_000)
    expect(parseOutcomeDelay('2h')).toBe(2 * 3_600_000)
    expect(formatOutcomeDelay(86_400_000)).toBe('1d')
    expect(() => parseOutcomeDelay('31d')).toThrow('between 1s and 30d')
    expect(() => parseOutcomeDelay('later')).toThrow('must look like')
  })

  test('keeps an outcome pending until its observation window, then verifies a file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-outcome-'))
    const state = join(cwd, '.elia', 'outcomes.json')
    const target = join(cwd, 'release-marker.txt')
    const store = OutcomeStore.open(state, cwd)
    const created = store.add({ title: 'Release marker', delayMs: 1_000, probe: { kind: 'file-exists', path: 'release-marker.txt' }, now: 1_000 })

    expect(store.checkDue(1_999)).toEqual([])
    mkdirSync(join(cwd, '.elia'), { recursive: true })
    writeFileSync(target, 'deployed')
    const checked = store.checkDue(2_000)
    expect(checked).toHaveLength(1)
    expect(checked[0]).toMatchObject({ id: created.id, status: 'verified', attempts: 1 })
    expect(checked[0]?.evidence?.[0]).toContain('file exists')
    expect(OutcomeStore.open(state, cwd).get(created.id)?.status).toBe('verified')
  })

  test('records a failed content postcondition and never turns it into success by repetition', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-outcome-'))
    const state = join(cwd, '.elia', 'outcomes.json')
    writeFileSync(join(cwd, 'health.txt'), 'status: degraded')
    const store = OutcomeStore.open(state, cwd)
    const created = store.add({ title: 'Healthy service', delayMs: 1_000, probe: { kind: 'file-contains', path: 'health.txt', text: 'status: healthy' }, now: 1_000 })

    const checked = store.checkDue(2_000)
    expect(checked[0]).toMatchObject({ id: created.id, status: 'failed', attempts: 1 })
    expect(checked[0]?.failure).toContain('does not contain expected text')
    expect(store.checkDue(3_000)).toEqual([])
  })

  test('rejects probes that escape the active workspace', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-outcome-'))
    const state = join(cwd, '.elia', 'outcomes.json')
    const store = OutcomeStore.open(state, cwd)
    expect(() => store.add({ title: 'Escape', delayMs: 1_000, probe: { kind: 'file-exists', path: '../outside.txt' } })).toThrow()
  })
})
