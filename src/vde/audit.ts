import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { purgeArtifact, readLibrary, recordCheck, registerArtifact } from './library.ts'

/**
 * The auditor of §5.3, for tools: re-check what was admitted, purge what no
 * longer holds.
 *
 * Repair is what lets a library live near its error threshold at all — an
 * audit that catches half of the unsound artifacts is worth doubling σ. For
 * lessons the audit is the randomized trial, folded in by `retireLessons`. For
 * synthesized tools it is simpler and stronger: run each tool's own test again.
 * A tool that passed when it was built can stop passing when the project, the
 * machine or elia around it changes, and a tool that no longer does what its
 * test says is exactly the "junk that still looks certified" Theorem 1 warns
 * fills a library near its threshold.
 *
 * The re-run is an audit check of its own family (`audit`), so it counts
 * toward the slip-rate estimate whichever way it lands.
 */

export interface SkillAuditDeps {
  skillsDir: string
  /** Runs one skill's test; true when it passed. */
  runTest: (testFile: string) => Promise<boolean>
  /** The tool name a skill file exports, or undefined when it no longer loads. */
  toolName: (skillFile: string) => Promise<string | undefined>
  libraryFile?: string
}

export interface SkillAuditResult {
  audited: number
  kept: string[]
  purged: string[]
}

export async function auditSkills(deps: SkillAuditDeps): Promise<SkillAuditResult> {
  const result: SkillAuditResult = { audited: 0, kept: [], purged: [] }
  if (!existsSync(deps.skillsDir)) return result
  const library = deps.libraryFile ? [deps.libraryFile] : []
  const known = readLibrary(...library)
  for (const entry of readdirSync(deps.skillsDir)) {
    if (!entry.endsWith('.skill.ts')) continue
    const skillFile = join(deps.skillsDir, entry)
    const testFile = skillFile.replace(/\.skill\.ts$/, '.skill.test.ts')
    const name = await deps.toolName(skillFile)
    const id = `skill:${name ?? entry.replace(/\.skill\.ts$/, '')}`
    if (known.get(id)?.status === 'purged') continue
    if (!known.has(id)) registerArtifact({ id, kind: 'skill', summary: `tool in ${entry}`, source: 'skill-synthesis' }, ...library)
    const loads = name !== undefined
    const passes = loads && existsSync(testFile) ? await deps.runTest(testFile) : loads
    result.audited += 1
    recordCheck(id, { verifier: existsSync(testFile) ? 'audit: re-ran its test' : 'audit: still loads', tier: 'exact', family: 'audit', passed: passes, at: Date.now() }, ...library)
    if (passes) result.kept.push(id)
    else {
      purgeArtifact(id, loads ? 'its own test no longer passes' : 'it no longer loads', { audit: true, ...(deps.libraryFile ? { path: deps.libraryFile } : {}) })
      result.purged.push(id)
    }
  }
  return result
}
