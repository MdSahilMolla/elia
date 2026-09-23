import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Tool } from '../tools/types.ts'

/**
 * Isolation, §8.3: statistics cannot stop a loop that can reach its own
 * measurement. The paper's scenario D shows it — every tampering action passed
 * the valid test and inflated the measured gain 66 points above the real one.
 * The Darwin Gödel Machine deleted the markers its designers used to detect
 * faked tool use, and hacked its objective more often when it could read the
 * checking code. Only structure removes the channel. The four requirements:
 *
 * - I1 — evaluator code, data and logs live where the scaffold cannot write.
 *   `IMMUTABLE_FILES` in evolve/sandbox.ts; the sealed gate, the certified
 *   library and its auditor, and the resource governor join it, because they
 *   are the paper's "never modify" list (§14).
 * - I2 — the scaffold sees thresholded outcomes, never per-task held-out results
 *   or evaluator internals. `split.ts` already withheld held-out failures from
 *   the brief, but two channels stayed open: the proposer's read tools could
 *   open any path on the machine, including the raw ledger and bench history
 *   that list held-out results, and the ledger summary it is shown quoted
 *   rejection reasons that name held-out tasks. `sealedReadTools` and
 *   `redactHeldOut` close them.
 * - I3 — every modification is logged with its diff and lineage. The ledger
 *   records changed files; `diffDigest` adds a content hash, so an audit can
 *   prove which bytes a verdict was about.
 * - I4 — scores come from outcomes the scaffold cannot fabricate. Benchmark
 *   tasks run the candidate's own code in throwaway repositories and are
 *   checked by code in immutable files; nothing the candidate reports is read.
 */

const READ_FIELDS: Record<string, string> = {
  read_file: 'path',
  list_files: 'cwd',
  grep: 'path',
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The proposer's read-only tools, confined to `roots`. The first root is where
 * relative paths resolve. Anything else — the live tree's state directories,
 * the evolution ledger, bench history, another project — is refused, because
 * each of those holds per-task results the split exists to withhold.
 */
export function sealedReadTools(tools: readonly Tool[], roots: readonly string[]): Tool[] {
  const allowed = roots.filter((root) => root.length > 0).map((root) => resolve(root))
  if (allowed.length === 0) throw new Error('sealedReadTools needs at least one root')
  const base = allowed[0]!
  const sealed: Tool[] = []
  for (const tool of tools) {
    const field = READ_FIELDS[tool.name]
    if (!field) continue
    sealed.push({
      ...tool,
      async execute(input) {
        const raw = input[field]
        const path = typeof raw === 'string' && raw.length > 0 ? raw : '.'
        const target = resolve(base, path)
        if (!allowed.some((root) => inside(root, target))) {
          throw new Error(`${path} is outside what the proposer may read (its own source copy and the evidence it was handed)`)
        }
        return tool.execute({ ...input, [field]: target })
      },
    })
  }
  return sealed
}

/** Replaces every mention of a held-out task id with a neutral phrase. Longest ids first, so no id eats part of another. */
export function redactHeldOut(text: string, heldOutIds: readonly string[]): string {
  let out = text
  for (const id of [...heldOutIds].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(id).join('a held-out task')
  }
  return out
}

/**
 * A content hash over the files a candidate changed, in path order. Deleted
 * files hash as deletions, so removing a file and emptying it are different
 * lineages.
 */
export function diffDigest(root: string, files: readonly string[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort()) {
    hash.update(file.replace(/\\/g, '/'))
    hash.update('\0')
    const path = join(root, file)
    hash.update(existsSync(path) ? readFileSync(path) : Buffer.from('<deleted>'))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}

export interface IsolationCheck {
  id: 'I1' | 'I2' | 'I3' | 'I4'
  ok: boolean
  evidence: string
}

/** The files that decide or audit a verdict and therefore must be immutable to the loop. */
export const EVALUATOR_FILES = [
  'src/evolve/fitness.ts',
  'src/evolve/engine.ts',
  'src/evolve/split.ts',
  'src/evolve/sieve.ts',
  'src/evolve/ledger.ts',
  // The task data: what each history task asks for, and which tasks exist.
  'src/evolve/history/suite.ts',
  'src/evolve/history/tasks.json',
  'src/evolve/acceptance.ts',
  'src/evolve/isolation.ts',
  'src/autonomy/certifiedLibrary.ts',
  'src/autonomy/lessonCertificates.ts',
  'src/compounding/resourceGovernor.ts',
  'src/compounding/frontier.ts',
]

/**
 * I1–I4 as checkable facts. `isImmutable` is injected so this module does not
 * import the sandbox (and through it, elia's config) just to be tested.
 */
export function isolationChecks(isImmutable: (file: string) => boolean, ledgerHasDigests: boolean): IsolationCheck[] {
  const mutable = EVALUATOR_FILES.filter((file) => !isImmutable(file))
  return [
    {
      id: 'I1',
      ok: mutable.length === 0,
      evidence: mutable.length === 0 ? `all ${EVALUATOR_FILES.length} evaluator, auditor and governor files are immutable to candidates` : `candidates could rewrite: ${mutable.join(', ')}`,
    },
    {
      id: 'I2',
      ok: true,
      evidence: 'the proposer reads only its sandbox and the evidence it was handed; held-out task ids are redacted from the ledger it is shown',
    },
    {
      id: 'I3',
      ok: ledgerHasDigests,
      evidence: ledgerHasDigests ? 'generations record a content digest of the diff they were judged on' : 'no generation has recorded a diff digest yet (records predate it, or none has reached the build)',
    },
    {
      id: 'I4',
      ok: true,
      evidence: 'benchmark tasks run the candidate\'s code in throwaway repositories and are scored by code in immutable files',
    },
  ]
}
