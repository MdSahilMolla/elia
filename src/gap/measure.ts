/**
 * Computes one `GapVector` in a child process and prints it as a single line of
 * JSON on stdout.
 *
 * The point is the same one `src/evolve/benchTask.ts` makes: the parent invokes
 * this file *from the tree being measured*. Run it from an evolution sandbox and
 * `ELIA_ROOT` resolves to that sandbox, so `promptForRole('critic')` picks up the
 * candidate's `fragments.generated.json` and the critic rung measures the
 * candidate's verifier rather than the live one.
 *
 * That distinction is the whole fix. `src/distill/gate.ts` used to call
 * `computeGapVector()` in-process, which measured the live installation no matter
 * what was in the sandbox — so the Verifier-Leads check compared the live tree
 * against a stored vector of the live tree and passed unconditionally.
 *
 * Anything on stdout other than the JSON line is a bug.
 */
import { computeGapVector } from './scoreboard.ts'

const args = process.argv.slice(2)
const withCritic = args.includes('--critic')

try {
  const vector = await computeGapVector({ critic: withCritic })
  process.stdout.write(`${JSON.stringify(vector)}\n`)
  process.exit(0)
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
}
