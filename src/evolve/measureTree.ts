import { join, resolve } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { readBoundedOutput, terminateProcessGroup } from '../shell.ts'
import { noteHostRun } from './containment.ts'
import type { GapVector } from '../gap/types.ts'
import type { ValueProbeRun } from '../values/probes.ts'
import { isPrefixSizes, type PrefixSizes } from '../world/probe.ts'

/**
 * Measuring a property of a source tree by running *that tree's own* code.
 *
 * Every self-improvement gate has the same trap in it, and both of elia's fell
 * into it: the check runs in-process, so it measures the live installation no
 * matter what the candidate contains, and therefore cannot fail. `measureFitness`
 * got this right from the start by spawning `<sourceRoot>/src/evolve/benchTask.ts`;
 * the gap check and the value probes did not. This is that same idea, factored
 * out so both of the remaining gates can use it.
 *
 * `cwd` is pinned to the live root deliberately. The scoreboard reads this
 * project's calibration log and defect history from the working directory, and
 * those have to be held constant across the A/B — the only thing that may differ
 * between the two calls is which tree does the verifying.
 *
 * Every function here returns `undefined` rather than throwing on failure, and
 * every caller treats that as a rejection: a gate that cannot measure must not
 * promote.
 */

/** Model calls make these slow; a hung child must not hold a gate open forever. */
const MEASURE_TIMEOUT_MS = 900_000

/** The generator–verifier gap as `root`'s own verifier scores it, critic rung included. */
export async function gapVectorIn(root: string, signal?: AbortSignal): Promise<GapVector | undefined> {
  return spawnJson<GapVector>(join(root, 'src', 'gap', 'measure.ts'), ['--critic'], signal, root)
}

/**
 * The value probes as `root`'s own prompts answer them.
 *
 * `subjectPrompt` overrides what the subject is put under — the distillation gate
 * passes a role's full prompt, since a distilled fragment changes a role suffix
 * and probing the untouched base prompt would compare a subject to itself.
 */
export async function valueProbesIn(
  root: string,
  options: { subjectPrompt?: string; signal?: AbortSignal } = {},
): Promise<ValueProbeRun | undefined> {
  const args = options.subjectPrompt ? ['--subject-prompt', options.subjectPrompt] : []
  return spawnJson<ValueProbeRun>(join(root, 'src', 'values', 'measure.ts'), args, options.signal, root)
}

/** The names of the tools `root`'s own registry gives its agent (toolSurface.ts). */
export async function toolNamesIn(root: string, signal?: AbortSignal): Promise<string[] | undefined> {
  const surface = await spawnJson<{ tools?: unknown }>(join(root, 'src', 'evolve', 'toolSurface.ts'), [], signal, root)
  return Array.isArray(surface?.tools) && surface.tools.every((name) => typeof name === 'string') ? (surface.tools as string[]) : undefined
}

/** What `root`'s own prompt and tool definitions cost every call (world/probe.ts). */
export async function prefixIn(root: string, signal?: AbortSignal): Promise<PrefixSizes | undefined> {
  const sizes = await spawnJson<unknown>(join(root, 'src', 'world', 'probe.ts'), [], signal, root)
  return isPrefixSizes(sizes) ? sizes : undefined
}

async function spawnJson<T>(entry: string, args: string[], signal?: AbortSignal, root?: string): Promise<T | undefined> {
  // These probes run a tree's own entry files on the host (they call models, so they cannot be boxed);
  // for a candidate tree that is recorded so landing does not read a boxed gate as covering it.
  if (root !== undefined && resolve(root) !== resolve(ELIA_ROOT)) noteHostRun()
  const proc = Bun.spawn(['bun', 'run', entry, ...args], {
    cwd: ELIA_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
    ...(process.platform === 'win32' ? {} : { detached: true }),
  })

  const collect = (async () => {
    const [out] = await Promise.all([
      readBoundedOutput(proc.stdout, 1_000_000),
      readBoundedOutput(proc.stderr, 100_000),
    ])
    await proc.exited
    return proc.exitCode === 0 ? out : undefined
  })()

  const deadline = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => {
      terminateProcessGroup(proc)
      resolve(undefined)
    }, MEASURE_TIMEOUT_MS)
    void collect.then(() => clearTimeout(timer))
  })

  const onAbort = () => terminateProcessGroup(proc)
  signal?.addEventListener('abort', onAbort, { once: true })

  let out: string | undefined
  try {
    out = await Promise.race([collect, deadline])
  } catch {
    return undefined
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!proc.exited) terminateProcessGroup(proc)
  }

  if (!out) return undefined
  // The entries print one JSON line; take the last one so a stray warning from a
  // dependency on stdout does not break the parse.
  const line = out
    .split('\n')
    .reverse()
    .find((l) => l.trim().startsWith('{'))
  if (!line) return undefined
  try {
    return JSON.parse(line) as T
  } catch {
    return undefined
  }
}
