import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { auditDeliverable } from '../autonomy/hygiene.ts'
import { lastPreflightSkipReason, preflightStructuralCheck } from '../native/parseCheck.ts'
import type { LadderResult, LadderRung, PlantedDefect } from './types.ts'

/**
 * The deterministic verification ladder, run against one planted defect.
 *
 * This is only the rungs that need no model: structural pre-flight, the
 * project's own typecheck, its tests, and the hygiene audit. Reproducible and
 * cheap by construction — the adversarial-critic rung is a separate, opt-in
 * pass because it is neither.
 */

const RUNG_TIMEOUT_MS = 60_000

const TSC_BIN = join(ELIA_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.exe' : 'tsc')

export async function runLadder(defect: PlantedDefect): Promise<LadderResult> {
  const caughtBy: LadderRung[] = []
  const skipped: LadderRung[] = []
  const notes: string[] = []
  let falsePositiveOnClean = false

  // --- structural ---------------------------------------------------------
  {
    let firedOnDefective = false
    let firedOnClean = false
    let ranAtAll = false
    for (const path of Object.keys(defect.defective)) {
      const clean = defect.clean[path]
      const broken = defect.defective[path]!
      const rejection = await preflightStructuralCheck(path, clean, broken)
      if (lastPreflightSkipReason() === undefined) ranAtAll = true
      if (rejection) firedOnDefective = true
      if (clean !== undefined) {
        const cleanRejection = await preflightStructuralCheck(path, undefined, clean)
        if (cleanRejection) firedOnClean = true
      }
    }
    if (!ranAtAll) {
      skipped.push('structural')
      notes.push(`structural: ${lastPreflightSkipReason() ?? 'no checker ran'}`)
    } else {
      if (firedOnDefective) caughtBy.push('structural')
      if (firedOnClean) falsePositiveOnClean = true
    }
  }

  // --- typecheck ---------------------------------------------------------
  if ('tsconfig.json' in defect.defective) {
    const defectiveExit = await runInFixture(defect.defective, [TSC_BIN, '-p', 'tsconfig.json'])
    const cleanExit = await runInFixture(defect.clean, [TSC_BIN, '-p', 'tsconfig.json'])
    if (defectiveExit.spawnFailed) {
      skipped.push('typecheck')
      notes.push(`typecheck: could not run tsc (${defectiveExit.detail})`)
    } else {
      if (defectiveExit.exitCode !== 0) caughtBy.push('typecheck')
      if (cleanExit.exitCode !== 0) {
        falsePositiveOnClean = true
        notes.push('typecheck: the clean control did not typecheck — fixture bug')
      }
    }
  }

  // --- test ------------------------------------------------------------
  if (defect.test) {
    const withTest = (files: Record<string, string>) => ({ ...files, ...defect.test })
    const defectiveExit = await runInFixture(withTest(defect.defective), ['bun', 'test'])
    const cleanExit = await runInFixture(withTest(defect.clean), ['bun', 'test'])
    if (defectiveExit.spawnFailed) {
      skipped.push('test')
      notes.push(`test: could not run bun test (${defectiveExit.detail})`)
    } else {
      if (defectiveExit.exitCode !== 0) caughtBy.push('test')
      if (cleanExit.exitCode !== 0) {
        falsePositiveOnClean = true
        notes.push('test: the clean control failed its own test — fixture bug')
      }
    }
  }

  // --- hygiene ---------------------------------------------------------
  {
    const defectiveIssues = auditInFixture(defect.defective)
    const cleanIssues = auditInFixture(defect.clean)
    if (defectiveIssues.length > 0) caughtBy.push('hygiene')
    if (cleanIssues.length > 0) {
      falsePositiveOnClean = true
      notes.push(`hygiene: flagged the clean control (${cleanIssues.map((i) => i.detail).join('; ')})`)
    }
  }

  return {
    defectId: defect.id,
    regime: defect.regime,
    expectedCatch: defect.expectedCatch,
    caughtBy,
    caught: caughtBy.length > 0,
    falsePositiveOnClean,
    skipped,
    notes,
  }
}

interface RunResult {
  exitCode: number
  spawnFailed: boolean
  detail: string
}

async function runInFixture(files: Record<string, string>, cmd: string[]): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'elia-gap-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, contents)
    }
    const proc = Bun.spawn(cmd, { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
    const timer = setTimeout(() => proc.kill(), RUNG_TIMEOUT_MS)
    try {
      await proc.exited
      return { exitCode: proc.exitCode ?? 1, spawnFailed: false, detail: '' }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return { exitCode: 1, spawnFailed: true, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function auditInFixture(files: Record<string, string>): { detail: string }[] {
  const dir = mkdtempSync(join(tmpdir(), 'elia-gap-hy-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, contents)
    }
    return auditDeliverable({
      cwd: dir,
      addedFiles: Object.keys(files),
      changedFiles: Object.keys(files),
    })
  } catch {
    return []
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
