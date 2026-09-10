/** Pilot benchmark: Go sidecar vs ripgrep vs pure-JS search on a real tree.
 *
 * Usage (from the repo root, after `just build-go`):
 *   ELIA_GO_INDEX=auto bun run scripts/bench-go-index.ts [--pattern p] [--dir src] [--repeats 5]
 *
 * Prints median wall-clock ms per backend. This is a local development
 * measurement for the promotion gate in opencode-optimization.md — not a
 * claim about any other machine.
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { searchWithJs } from '../src/tools/grep.ts'
import { goIndexEnabled, resolveGoIndexPath, searchWithGoIndex } from '../src/goindex/index.ts'

const { values } = parseArgs({
  options: {
    pattern: { type: 'string', default: 'TODO' },
    dir: { type: 'string', default: 'src' },
    repeats: { type: 'string', default: '5' },
  },
  strict: true,
})
const repeats = Math.max(1, Math.min(20, Number(values.repeats) || 5))
const dir = resolve(values.dir!)
const pattern = values.pattern!

async function timeIt(label: string, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < repeats; i++) {
    const start = performance.now()
    await fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]!
  console.log(`${label}: median ${median.toFixed(1)} ms over ${repeats} runs (samples: ${samples.map((s) => s.toFixed(0)).join(', ')})`)
  return median
}

const js = await timeIt('pure-JS ', () => searchWithJs(pattern, dir, '.', undefined, undefined))

let rg: number | undefined
const rgBin = Bun.which('rg')
if (rgBin) {
  rg = await timeIt('ripgrep ', async () => {
    const proc = Bun.spawn([rgBin, '--line-number', '--no-heading', '--color=never', '-e', pattern, '.'], {
      cwd: dir,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await proc.exited
  })
} else {
  console.log('ripgrep : not installed, skipping')
}

let go: number | undefined
if (goIndexEnabled() && resolveGoIndexPath()) {
  go = await timeIt('go-index', () => searchWithGoIndex(pattern, dir, '.', undefined, undefined))
} else {
  console.log('go-index: unavailable (need ELIA_GO_INDEX=auto and just build-go), skipping')
}

console.log(`\nbaseline pure-JS median: ${js.toFixed(1)} ms`)
if (rg !== undefined) console.log(`ripgrep speedup: ${(js / rg).toFixed(2)}x`)
if (go !== undefined) console.log(`go-index speedup: ${(js / go).toFixed(2)}x`)
