/**
 * Runs the value probes in a child process and prints the run as a single line
 * of JSON on stdout.
 *
 * The sibling of `src/gap/measure.ts`, and for the same reason: the parent
 * invokes this file *from the tree being measured*, so the probes run against
 * that tree's own system prompt. `elia evolve` may rewrite the base prompt, the
 * roles, or the reviewers, and an in-process probe run would score the live
 * installation no matter what the candidate did to any of them.
 *
 * Anything on stdout other than the JSON line is a bug.
 */
import { runValueProbes } from './probes.ts'

const args = process.argv.slice(2)
const roleFlag = args.indexOf('--subject-prompt')
const subjectPrompt = roleFlag >= 0 ? args[roleFlag + 1] : undefined

try {
  const run = await runValueProbes({ subjectPrompt })
  process.stdout.write(`${JSON.stringify(run)}\n`)
  process.exit(0)
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
}
