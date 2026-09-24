import { config, type TierConfig } from '../config.ts'
import { tryResolveProvider } from '../providers/registry.ts'

/**
 * The model the improver runs on, when it should differ from the model under test.
 *
 * `elia evolve` has two kinds of model call. The benchmark children run the
 * candidate on the configured model, because that model is what the score is a
 * score *of*. The proposer, the builder and the strategy writer run in the
 * parent, and their only job is to find a change worth measuring. Tying them to
 * the model under test made the search exactly as good as the weakest model elia
 * is benchmarked on: every generation on `mercury-2.5` proposed a small edit to a
 * tool description, and the ledger could not tell a timid proposer from a
 * harness with nothing left to find.
 *
 * `ELIA_EVOLVE_PROVIDER` / `ELIA_EVOLVE_MODEL` (with `ELIA_EVOLVE_BASE_URL` and
 * `ELIA_EVOLVE_API_KEY` as for any role) move the improver alone. Only this
 * parent process reads them, and nothing reaches a benchmark child except
 * through the environment it already had, so the verdict still measures the
 * configured model.
 *
 * Unlike a role override, which falls back silently so a session keeps working,
 * a route that was asked for and cannot be stood up is an error: a run that
 * quietly fell back to the model under test would record its proposals as the
 * stronger model's.
 */
export function improverRoute(): TierConfig | undefined {
  const providerName = process.env.ELIA_EVOLVE_PROVIDER
  const model = process.env.ELIA_EVOLVE_MODEL
  if (!providerName && !model) return undefined

  const resolved = tryResolveProvider({
    providerName: providerName ?? config.providerName,
    model,
    baseURL: process.env.ELIA_EVOLVE_BASE_URL,
    apiKeyEnv: process.env.ELIA_EVOLVE_API_KEY ? 'ELIA_EVOLVE_API_KEY' : undefined,
    ignoreAmbient: true,
  })
  if ('error' in resolved) {
    throw new Error(`ELIA_EVOLVE_PROVIDER/ELIA_EVOLVE_MODEL could not be used: ${resolved.error}`)
  }
  return {
    provider: resolved.provider,
    providerName: resolved.providerName,
    model: resolved.model,
    label: `${resolved.providerName} (${resolved.model})`,
  }
}

/** The loop options that put one agent loop on the improver's route. Empty without one. */
export function improverLoopRoute(route: TierConfig | undefined): { provider?: TierConfig['provider']; providerName?: string; model?: string } {
  return route ? { provider: route.provider, providerName: route.providerName, model: route.model } : {}
}

/**
 * Runs `fn` with the builder role on the improver's route, then puts it back.
 *
 * A sub-agent picks its model from `config.roleOverrides` when it starts, and
 * the builder inside evolve is an ordinary sub-agent. Setting the override in
 * this process, rather than exporting `ELIA_BUILDER_PROVIDER`, is what keeps it
 * out of the benchmark children: their own agents delegate to builders too, and
 * those must stay on the model under test.
 */
export async function withImproverBuilder<T>(route: TierConfig | undefined, fn: () => Promise<T>): Promise<T> {
  if (!route) return fn()
  const had = Object.prototype.hasOwnProperty.call(config.roleOverrides, 'builder')
  const previous = config.roleOverrides.builder
  config.roleOverrides.builder = route
  try {
    return await fn()
  } finally {
    if (had) config.roleOverrides.builder = previous
    else delete config.roleOverrides.builder
  }
}
