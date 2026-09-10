import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import type { RoleName } from '../autonomy/types.ts'

/**
 * Distilled role guidance — Loop 2.
 *
 * When many verified-successful runs of the same shape all had a worker do the
 * same non-obvious thing, that behaviour is worth making a default instead of
 * something each run has to rediscover. This is the machine version of practice:
 * what took deliberation becomes standing instruction.
 *
 * The file is data, not code, and is only ever written by the distillation gate
 * after a candidate cleared the evolve benchmark, the generator–verifier gap
 * check, and the value probes. It is trivially reversible — delete an entry.
 */

interface FragmentsFile {
  _comment?: string
  fragments: Partial<Record<RoleName, string[]>>
}

const FILE_COMMENT =
  'Written only by the distillation gate (src/distill/gate.ts) after a candidate fragment passed the evolve benchmark, the generator-verifier gap check, and the value probes. Each entry is a short instruction distilled from repeated verified-successful runs. Edit by hand only to remove one.'

const FRAGMENTS_PATH = join(ELIA_ROOT, 'src', 'distill', 'fragments.generated.json')

let cache: FragmentsFile | undefined

export function learnedFragments(force = false): Partial<Record<RoleName, string[]>> {
  if (cache && !force) return cache.fragments
  try {
    const raw = JSON.parse(readFileSync(FRAGMENTS_PATH, 'utf8')) as Partial<FragmentsFile>
    cache = { fragments: raw.fragments ?? {} }
  } catch {
    cache = { fragments: {} }
  }
  return cache.fragments
}

/** The suffix appended to a role's system prompt, or '' when nothing was distilled for it. */
export function learnedSuffixFor(role: RoleName): string {
  const list = learnedFragments()[role]
  if (!list || list.length === 0) return ''
  return `\n\nLearned from past verified runs on this kind of work:\n${list.map((f) => `- ${f}`).join('\n')}`
}

/**
 * Writes a fragment into a specific copy of the file (a sandbox during gating,
 * or the live tree on promotion). Returns the repo-relative path that changed.
 */
export function addFragment(role: RoleName, fragment: string, root = ELIA_ROOT): string {
  const path = join(root, 'src', 'distill', 'fragments.generated.json')
  let fragments: Partial<Record<RoleName, string[]>> = {}
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FragmentsFile>
      fragments = raw.fragments ?? {}
    } catch {
      // start fresh
    }
  }
  const list = fragments[role] ?? []
  const clean = fragment.replace(/\s+/g, ' ').trim()
  if (!list.some((f) => f.toLowerCase() === clean.toLowerCase())) list.push(clean)
  fragments[role] = list
  const data: FragmentsFile = { _comment: FILE_COMMENT, fragments }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
  cache = undefined
  return 'src/distill/fragments.generated.json'
}

export function fragmentCount(): number {
  return Object.values(learnedFragments()).reduce((sum, list) => sum + (list?.length ?? 0), 0)
}
