import { plugin } from 'bun'
import { writeFileSync } from 'node:fs'

/**
 * Preloaded into every benchmark child so the run records which source files it
 * loaded. See `reach.ts` for why that list is worth having.
 *
 * It has to be a loader plugin rather than a read of some registry, because Bun
 * does not expose the modules it has evaluated. `onLoad` fires once per module,
 * before evaluation, which is exactly the hook — the handler hands the file's
 * own text straight back, so the module graph is unchanged and only the
 * bookkeeping is added.
 *
 * Two deliberate limits. It installs itself *only* when the parent asks for a
 * recording, so an ordinary run pays nothing. And it is loaded from the parent's
 * tree, never the candidate's: a generation may rewrite elia's loop, but it must
 * not be able to rewrite the thing that watches which of its files ran.
 */

// Spelled out rather than imported: this file is preloaded before anything
// else, and pulling in reach.ts would drag the state paths and the persistence
// helpers into every benchmark child for the sake of one string. `reach.ts`
// exports the same name as REACH_OUT_ENV, and reach.test.ts holds them equal.
const out = process.env.ELIA_REACH_OUT

if (out) {
  const seen = new Set<string>()

  plugin({
    name: 'elia-reach-recorder',
    setup(build) {
      build.onLoad({ filter: /\.(ts|tsx)$/ }, async (args) => {
        seen.add(args.path)
        // Bun requires a handler that matched to return the contents; passing the
        // file straight through keeps the module identical to what it would have
        // been, at the cost of one extra read per module.
        return { contents: await Bun.file(args.path).text(), loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
      })
    },
  })

  // The benchmark child calls process.exit() on its own to print one JSON line,
  // so 'exit' is the only hook guaranteed to run. Writing must be synchronous
  // for the same reason.
  process.on('exit', () => {
    try {
      writeFileSync(out, [...seen].join('\n'))
    } catch {
      // A lost recording costs the next candidate some pruning, nothing else.
    }
  })
}
