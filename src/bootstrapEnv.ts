import { loadUserConfig } from './userConfig.ts'

/**
 * Loads ~/.elia/config.env into the environment. Imported first by index.ts,
 * as a side effect, because the order is the whole point.
 *
 * `config.ts` resolves the provider when it loads, and it loads during
 * index.ts's static imports (the REPL → agentLoop → config). Calling
 * `loadUserConfig()` in index.ts's body ran after all of those, so a provider
 * saved only in config.env — which is what `elia config set` and first-run
 * setup write — was never the one used: elia started "unconfigured" and fell
 * back to Anthropic. ES modules evaluate imports in order, so this one, listed
 * first, runs before anything that reads the provider.
 *
 * Explicit process and project `.env` values still win; this only fills gaps.
 */
loadUserConfig()
