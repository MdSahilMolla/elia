import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isPathTrusted, trustPath, untrustPath } from '../autonomy/projectTrust.ts'
import { SKILL_SUFFIX } from './paths.ts'

/**
 * Per-project trust decision for `.elia/skills/*.skill.ts`.
 *
 * Project-local skills live inside the repository being opened, not a
 * user-owned directory — `git clone` + `elia` must never be enough to run
 * someone else's code. The decision is therefore recorded in the per-user,
 * HMAC-signed trust record (`autonomy/projectTrust.ts`, under `~/.config/elia`)
 * and bound to a hash of the skill files that were reviewed: a repo cannot ship
 * its own "trusted" flag, and changing or adding a skill file revokes the trust
 * until the person runs `elia skills trust` again.
 */

/**
 * The pre-hardening trust flag sat next to the skills folder, inside the repo —
 * so a repo could ship `{"trusted": true}` and skip the prompt. It is ignored
 * as trust evidence now; the path is kept only so `elia skills status` can say
 * a stale file was found.
 */
export function skillsTrustPath(projectSkillsDir: string): string {
  return join(dirname(projectSkillsDir), 'skills-trust.json')
}

/** True when a leftover in-repo trust flag exists (it is ignored). */
export function hasIgnoredRepoTrustFile(projectSkillsDir: string): boolean {
  return existsSync(skillsTrustPath(projectSkillsDir))
}

/**
 * True once a human has explicitly trusted these exact skill files — via
 * `elia skills trust` (persisted in the user-level record) or the
 * `ELIA_SKILLS_TRUST_PROJECT=on` escape hatch for non-interactive contexts (CI,
 * a container image built from a repo already known to be trusted) where the
 * interactive command can't be run first. The escape hatch is honoured only
 * from the real environment: bootstrapEnv.ts drops it when it came from the
 * project's own `.env`.
 */
export function isProjectSkillsTrusted(projectSkillsDir: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if ((environment.ELIA_SKILLS_TRUST_PROJECT ?? '').toLowerCase() === 'on') return true
  return isPathTrusted(projectSkillsDir, SKILL_SUFFIX)
}

/** Persists the "yes, load these project skills" decision. Returns false when there are no skill files to trust. */
export function trustProjectSkills(projectSkillsDir: string): boolean {
  return trustPath(projectSkillsDir, SKILL_SUFFIX)
}

/** Revokes a prior trust decision. Test seam / explicit opt-out. */
export function untrustProjectSkills(projectSkillsDir: string): void {
  untrustPath(projectSkillsDir)
}
