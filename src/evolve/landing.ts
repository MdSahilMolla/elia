import { spawnSync } from 'node:child_process'
import type { Attestation } from './containment.ts'

/**
 * Letting elia keep what it proved, and only that.
 *
 * An unattended run promotes to its own `evolve/gen-N` branch and leaves the
 * checkout alone — the right default, and the reason a proven change can sit
 * there for days while every later generation starts from source that lacks it
 * (see `landedOnLive`). Landing closes that gap for the changes that earn it:
 * with `ELIA_COMPOUND_LAND=on`, a branch promotion is fast-forwarded into the
 * checkout, and elia builds the next generation on what the last one won.
 *
 * "Earns it" is a short list, all of which has to hold:
 *
 *   - the gate ran *contained*: every command that ran the candidate's code
 *     went through elia-box and none was cut short (`Attestation`). A change
 *     proven on the bare host has not been proven safe to run;
 *   - the checkout is exactly where the candidate was cut from (its parent is
 *     HEAD), so what lands is what was measured, byte for byte;
 *   - nothing local touches the files it changes;
 *   - afterwards the tree still type-checks, and if it does not the landing is
 *     reverted with a new commit — never a reset, which would destroy whatever
 *     else is uncommitted.
 *
 * It never pushes, never rewrites history, and never touches a branch other
 * than the one checked out. Off by default: writing to the checkout on nobody's
 * say-so is a decision, and this is the switch that makes it.
 *
 * Immutable to the loop (sandbox.ts).
 */

export function landingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ['on', '1', 'true'].includes((env.ELIA_COMPOUND_LAND ?? '').trim().toLowerCase())
}

export interface LandingOptions {
  liveRoot: string
  commit: string
  attestation: Pick<Attestation, 'boxed' | 'cutShort'> | undefined
  /** Type-checks the live tree after the landing. */
  verify: () => Promise<boolean>
  /** Injection seam for tests. */
  git?: (args: string[]) => { status: number | null; stdout: string }
}

export type Landing = { landed: true; previousHead: string } | { landed: false; reason: string; reverted?: boolean }

export async function land(options: LandingOptions): Promise<Landing> {
  const run =
    options.git ??
    ((args: string[]) => {
      const result = spawnSync('git', ['-C', options.liveRoot, ...args], { encoding: 'utf8', windowsHide: true })
      return { status: result.status, stdout: (result.stdout ?? '').trim() }
    })
  const refuse = (reason: string): Landing => ({ landed: false, reason })

  const attested = options.attestation
  if (!attested || attested.boxed === 0) return refuse('the gate ran on the bare host, not in elia-box, so the change has not been proven safe to run (ELIA_EVOLVE_BOX=on)')
  if (attested.cutShort > 0) return refuse(`${attested.cutShort} of the boxed runs were cut short by a limit, so the evidence is incomplete`)

  const head = run(['rev-parse', 'HEAD'])
  const parent = run(['rev-parse', `${options.commit}^`])
  if (head.status !== 0 || parent.status !== 0) return refuse('could not read the checkout or the candidate commit')
  if (head.stdout !== parent.stdout) return refuse('the checkout has moved on since the candidate was cut, so what would land is not what was measured')
  if (run(['symbolic-ref', '-q', 'HEAD']).status !== 0) return refuse('the checkout is on a detached HEAD, which is not somewhere to land onto')

  const touched = run(['diff-tree', '--no-commit-id', '--name-only', '-r', options.commit])
  const files = touched.stdout.split('\n').filter(Boolean)
  if (touched.status !== 0 || files.length === 0) return refuse('the candidate commit changes no files')
  const dirty = run(['status', '--porcelain=v1', '--untracked-files=all', '--', ...files])
  if (dirty.stdout) return refuse(`uncommitted work touches the files it changes (${dirty.stdout.split('\n').map((line) => line.slice(3)).join(', ')})`)

  const merged = run(['merge', '--ff-only', options.commit])
  if (merged.status !== 0) return refuse('git would not fast-forward onto the candidate')

  if (!(await options.verify())) {
    // A new commit that undoes it: history keeps what happened, and nothing else in the tree is lost.
    const reverted = run(['revert', '--no-edit', options.commit])
    return { landed: false, reason: 'the tree no longer type-checks with the change landed', reverted: reverted.status === 0 }
  }
  return { landed: true, previousHead: head.stdout }
}
