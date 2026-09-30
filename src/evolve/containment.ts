import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { boxPolicyFor, recentBoxReceipts, runInBox, shellResultFromBox, BoxUnavailable, type BoxReceipt } from '../sandbox/box.ts'
import { runShell, type ShellResult } from '../shell.ts'

/**
 * Where an evolve candidate's gate commands run.
 *
 * A candidate is code an agent wrote, and the gate (`bun run typecheck`,
 * `bun test`) executes it. Copying the source tree into `.evolution/gen-N`
 * isolates the *files*; nothing bounds what the executed code can read, write
 * or reach. `ELIA_EVOLVE_BOX` puts those commands in elia-box:
 *
 *   off      (default) the gate runs as it always has
 *   on       gate commands run in the box; if the box cannot run, they run as before
 *   require  gate commands run in the box or the generation is refused. A candidate
 *            that has not been contained is never promoted.
 *
 * Either way the receipts of the boxed runs are what `attestation` reports, so a
 * verdict can say what its evidence was held to.
 */
export type EvolveBoxMode = 'off' | 'on' | 'require'

export function evolveBoxMode(): EvolveBoxMode {
  const v = (process.env.ELIA_EVOLVE_BOX ?? '').trim().toLowerCase()
  return v === 'require' ? 'require' : v === '1' || v === 'on' || v === 'true' ? 'on' : 'off'
}

export class ContainmentRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContainmentRequired'
  }
}

/** A gate command, in the box when asked to be. */
export async function runGate(command: string, timeoutMs: number, cwd: string, liveRoot: string, signal?: AbortSignal): Promise<ShellResult> {
  const mode = evolveBoxMode()
  if (mode === 'off') return runShell(command, timeoutMs, cwd, signal)
  const policy = boxPolicyFor(cwd, timeoutMs, { NO_COLOR: '1' })
  // The candidate tree has no node_modules of its own; resolution walks up to the live tree's.
  policy.readPaths = [...(policy.readPaths ?? []), realpathSync(join(liveRoot, 'node_modules'))]
  policy.limits = { ...policy.limits, memoryMb: 6000, pids: 2000 }
  policy.snapshot = false
  try {
    return shellResultFromBox(command, await runInBox(policy, ['/bin/sh', '-c', command], { signal, timeoutMs }))
  } catch (err) {
    if (err instanceof BoxUnavailable && mode === 'on') return runShell(command, timeoutMs, cwd, signal)
    if (err instanceof BoxUnavailable) throw new ContainmentRequired(`ELIA_EVOLVE_BOX=require but elia-box cannot run: ${err.message}`)
    throw err
  }
}

export interface Attestation {
  boxed: number
  backends: string[]
  networks: string[]
  /** Runs cut short by a limit, the wall clock, or an interrupt. */
  cutShort: number
  receiptHashes: string[]
}

/** What the boxed runs since `sinceIndex` (a value of `recentBoxReceipts().length`) were held to. */
export function attest(sinceIndex = 0, receipts: readonly BoxReceipt[] = recentBoxReceipts()): Attestation {
  const mine = receipts.slice(sinceIndex)
  return {
    boxed: mine.length,
    backends: [...new Set(mine.map((r) => r.backend))],
    networks: [...new Set(mine.map((r) => r.network.mode))],
    cutShort: mine.filter((r) => r.exit.timedOut || r.exit.limitHit !== null || r.exit.interrupted).length,
    receiptHashes: mine.map((r) => r.receiptHash),
  }
}

export function describeAttestation(a: Attestation): string {
  if (a.boxed === 0) return 'the gate ran on the host, uncontained'
  const cut = a.cutShort ? `, ${a.cutShort} cut short by a limit` : ''
  return `the gate ran in elia-box (${a.backends.join('+')}; network ${a.networks.join('+')}; ${a.boxed} sealed receipt${a.boxed === 1 ? '' : 's'}${cut})`
}
