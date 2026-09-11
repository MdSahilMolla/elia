import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Per-project trust decision for `.elia/skills/*.skill.ts`.
 *
 * Project-local skills live inside the repository being opened, not a
 * user-owned directory — `git clone` + `elia` must never be enough to run
 * someone else's code. This mirrors `autonomy/allowStore.ts`'s "record a
 * human's explicit yes, stop asking" pattern: one small JSON file, versioned
 * with the repo, that the loader consults before it will `import()` anything
 * out of the project's skills folder.
 */

export interface SkillsTrustFile {
  trusted: boolean
  trustedAt?: string
}

/** The trust file sits next to the skills folder it governs: `<dir>/skills` → `<dir>/skills-trust.json`. */
export function skillsTrustPath(projectSkillsDir: string): string {
  return join(dirname(projectSkillsDir), 'skills-trust.json')
}

/**
 * True once a human has explicitly trusted this project's local skills — via
 * `elia skills trust` (persisted) or the `ELIA_SKILLS_TRUST_PROJECT=on`
 * escape hatch for non-interactive contexts (CI, a container image built
 * from a repo already known to be trusted) where the interactive command
 * can't be run first.
 */
export function isProjectSkillsTrusted(projectSkillsDir: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if ((environment.ELIA_SKILLS_TRUST_PROJECT ?? '').toLowerCase() === 'on') return true
  const path = skillsTrustPath(projectSkillsDir)
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Boolean(parsed && typeof parsed === 'object' && (parsed as SkillsTrustFile).trusted === true)
  } catch {
    // A malformed trust file trusts nothing — same fail-closed posture as a missing one.
    return false
  }
}

/** Persists the "yes, load this project's local skills" decision so it isn't asked again every run. */
export function trustProjectSkills(projectSkillsDir: string): void {
  const path = skillsTrustPath(projectSkillsDir)
  mkdirSync(dirname(path), { recursive: true })
  const file: SkillsTrustFile = { trusted: true, trustedAt: new Date().toISOString() }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
}

/** Revokes a prior trust decision. Test seam / explicit opt-out. */
export function untrustProjectSkills(projectSkillsDir: string): void {
  const path = skillsTrustPath(projectSkillsDir)
  if (existsSync(path)) writeFileSync(path, `${JSON.stringify({ trusted: false }, null, 2)}\n`)
}
