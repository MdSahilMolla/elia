import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ScriptedTurn } from './scriptedProvider.ts'

/**
 * The latency corpus.
 *
 * Every scenario targets a path whose cost elia owns: streaming a turn, running
 * a batch of tool calls, reusing a speculatively-executed read, following the
 * prefetch edges out of a grep. The scripted turns below are what a competent
 * model *would* do on each prompt — fixed, so the only thing that moves between
 * runs is elia's own overhead.
 *
 * `expect` holds the structural invariants that must not regress: they are
 * fully deterministic (no timing), so CI can gate on them hard. Wall-clock is
 * reported alongside for humans to watch, not gated tightly.
 */

export interface LatencyScenario {
  id: string
  description: string
  /** Builds the starting repo in `dir`. */
  setup(dir: string): void
  /** The assistant turns the scripted provider replays, in order. */
  turns: ScriptedTurn[]
  /** The user prompt (only its shape matters — the script drives behaviour). */
  prompt: string
  expect: {
    /** Model round-trips the loop should make. */
    roundTrips: number
    /** Total tool results the loop should produce. */
    toolCalls: number
    /** Tool results that should be served from the speculative cache (mid-stream dispatch + prefetch). */
    cachedToolCalls: number
  }
}

function write(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

const MODULE_SOURCE = (name: string): string =>
  `export function ${name}(value: number): number {\n  return value * 2\n}\n\nexport const ${name}_LABEL = '${name}'\n`

export const LATENCY_SCENARIOS: LatencyScenario[] = [
  {
    id: 'pure-text',
    description: 'One turn, streamed text, no tools — the floor cost of a turn.',
    prompt: 'Explain what this project does in two sentences.',
    setup() {},
    turns: [{ text: 'This is a benchmark fixture. It exists only to measure the fixed cost of a single streamed assistant turn with no tool calls.' }],
    expect: { roundTrips: 1, toolCalls: 0, cachedToolCalls: 0 },
  },

  {
    id: 'parallel-reads',
    description: 'Six independent reads in one turn — tests batch concurrency and mid-stream speculative dispatch.',
    prompt: 'Read every module under src/ and summarise them.',
    setup(dir) {
      for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
        write(dir, `src/${name}.ts`, MODULE_SOURCE(name))
      }
    },
    turns: [
      {
        text: 'Reading the modules.',
        toolCalls: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((name) => ({
          name: 'read_file',
          input: { path: `src/${name}.ts` },
        })),
      },
      { text: 'All six modules double their input.' },
    ],
    // Every read is emitted mid-stream, so every read should be a speculative hit.
    expect: { roundTrips: 2, toolCalls: 6, cachedToolCalls: 6 },
  },

  {
    id: 'read-then-edit',
    description: 'Two reads, then an edit — mid-stream dispatch on the reads, repo-lock on the write.',
    prompt: 'Change alpha() to triple its input instead of doubling it.',
    setup(dir) {
      write(dir, 'src/alpha.ts', MODULE_SOURCE('alpha'))
      write(dir, 'src/beta.ts', MODULE_SOURCE('beta'))
    },
    turns: [
      {
        text: 'Checking both modules first.',
        toolCalls: [
          { name: 'read_file', input: { path: 'src/alpha.ts' } },
          { name: 'read_file', input: { path: 'src/beta.ts' } },
        ],
      },
      {
        text: 'Applying the change.',
        toolCalls: [{ name: 'edit_file', input: { path: 'src/alpha.ts', old_string: 'return value * 2', new_string: 'return value * 3' } }],
      },
      { text: 'Done — alpha() now triples its input.' },
    ],
    expect: { roundTrips: 3, toolCalls: 3, cachedToolCalls: 2 },
  },

  {
    id: 'grep-chain',
    description: 'grep, then open a hit — tests the prefetcher following grep output into reads.',
    prompt: 'Where is DOUBLE_FACTOR defined? Read that file.',
    setup(dir) {
      write(dir, 'src/config.ts', `export const DOUBLE_FACTOR = 2\nexport const TRIPLE_FACTOR = 3\n`)
      write(dir, 'src/math.ts', `import { DOUBLE_FACTOR } from './config.ts'\n\nexport const double = (n: number) => n * DOUBLE_FACTOR\n`)
      write(dir, 'src/unrelated.ts', MODULE_SOURCE('unrelated'))
    },
    turns: [
      { text: 'Searching.', toolCalls: [{ name: 'grep', input: { pattern: 'DOUBLE_FACTOR' } }] },
      { text: 'Opening the definition.', toolCalls: [{ name: 'read_file', input: { path: 'src/config.ts' } }] },
      { text: 'DOUBLE_FACTOR is 2, defined in src/config.ts.' },
    ],
    // Both calls are pre-run: grep is speculated mid-stream as its block lands in
    // turn 1, and src/config.ts is already in the cache by the time turn 2 asks
    // for it (the prefetcher pre-read it from the grep output, and mid-stream
    // dispatch would have too). Neither should ever block.
    expect: { roundTrips: 3, toolCalls: 2, cachedToolCalls: 2 },
  },
]

export function scenarioById(id: string): LatencyScenario | undefined {
  return LATENCY_SCENARIOS.find((scenario) => scenario.id === id)
}
