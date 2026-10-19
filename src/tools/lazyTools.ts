import type { Tool } from './types.ts'

/**
 * Tools whose full definitions are sent only once the model asks for them.
 *
 * Every model call re-sends every tool definition. In dev mode that was 53
 * tools, ~67k characters (~17k tokens), three quarters of each request's fixed
 * prefix, and most of them are specialists a coding turn never touches (finance,
 * sports, federated_collab...). A provider without prompt caching (mercury, the
 * default) charges that on every step of every turn.
 *
 * So a turn sends the core tools in full and offers the rest through
 * one `load_tools` catalog: a call signature and a one-line summary each.
 * Nothing is taken away. The model calls a deferred tool directly, like any
 * other: it runs, and its definition is attached from the next step on. A
 * first call with wrong arguments gets the full schema back in its error, so
 * the retry has it. `load_tools` only shows a schema ahead of a first call.
 *
 * Loaded tools stay loaded for the rest of the session, so the tool block stops
 * changing once the session has found what it uses.
 *
 * `ELIA_LAZY_TOOLS=off` sends every definition; `=on` defers even on a
 * provider that caches the prefix (see `lazyToolsEnabled`).
 */
// preview and browser are not here: the action ledger (2026-09-30, 1317 calls)
// has them as the most used tools after the core ones, and deferring an
// everyday tool only buys a retry. Everything here was used a handful of times.
export const DEFERRED_DEV_TOOLS: ReadonlySet<string> = new Set([
  'github', 'database', 'lsp_refactor', 'environment', 'provision_environment', 'deployment',
  'production_readiness', 'dependency_audit', 'codex_delegate', 'communication', 'paper', 'knowledge', 'visualize',
  'finance', 'data_science', 'sports', 'fitness', 'federated_collab', 'codebase_memory', 'cross_project_learn',
  'arch_drift', 'causal_debug', 'causal_fix', 'causal_verify', 'adversarial_verify', 'multi_modal_review',
  'self_healing_monitor', 'spec_verify', 'predictive_impact', 'temporal_analysis',
])

/**
 * What each mode keeps in full out of that list, because its work is built on
 * it. A mode's own tools (ds_*, si_*, battmann, the security set) are never in
 * the list to begin with. Everything else is deferred in every mode: data-
 * science mode was sending ~114k characters of tool definitions per call.
 */
const MODE_KEEPS: Record<string, readonly string[]> = {
  dev: [],
  cyber: ['dependency_audit', 'knowledge'],
  battmann: ['paper', 'visualize', 'finance', 'communication'],
  datascience: ['visualize', 'finance', 'paper', 'database'],
  sysintel: ['github', 'production_readiness'],
}

/** The tools deferred in `mode`: the specialist list, less what that mode keeps. */
export function deferredToolsForMode(mode: string): ReadonlySet<string> {
  const keeps = new Set(MODE_KEEPS[mode] ?? [])
  return new Set([...DEFERRED_DEV_TOOLS].filter((name) => !keeps.has(name)))
}

export const LOAD_TOOLS_NAME = 'load_tools'

/**
 * Words in a request that say a deferred tool is about to be needed. A match
 * attaches that tool's full definition before the first call, so the first call
 * is made with the whole schema and every rule in view, exactly as if nothing
 * had been deferred. A false match costs one definition; a miss costs at most
 * one retry (the failed call is answered with the schema). A tool's own name,
 * with spaces or underscores, always counts.
 */
const TOOL_CUES: Record<string, RegExp> = {
  github: /\b(git|github|commit|push|pull request|PRs?|merge|rebase|branch(es)?)\b/i,
  database: /\b(databases?|db|sql|postgres(ql)?|psql|mysql|mariadb|sqlite|migrations?)\b/i,
  lsp_refactor: /\b(rename|refactor\w*|code actions?|quick ?fix)\b/i,
  environment: /\b(dev environment|runtimes?|toolchain)\b/i,
  provision_environment: /\b(set ?up (the )?(dev )?environment|install (the )?dependenc\w*|venv|virtualenv|docker.compose)\b/i,
  deployment: /\b(deploy\w*|vercel|netlify|ship it|container image)\b/i,
  production_readiness: /\b(production.read\w*|launch.read\w*|ready for production|go.live)\b/i,
  dependency_audit: /\b(vulnerab\w*|cves?|security audit|npm audit|outdated (packages|dependencies|deps))\b/i,
  codex_delegate: /\bcodex\b/i,
  communication: /\b(e-?mail|slack|calendar|meeting invite|send (a|the) (note|message|update))\b/i,
  paper: /\b(papers?|arxiv|literature|citations?|doi|peer.reviewed|journal)\b/i,
  // Research and general-knowledge questions, security lookups, and the
  // curated slice's own topics. "how does X work" counts only when X is not
  // "this/the/our/my …": that is a question about the code in front of elia.
  knowledge: /\b(knowledge ?base|eliabase|kb|cves?|cve-\d{4}-\d+|ghsa|exploit-?db|att&ck|mitre|ctf|wikipedia|wikidata|stack ?exchange|gutenberg|self-improv\w*|rsi|research (?:on|into|about|says|shows)|(?:the )?(?:research|scientific) literature|studies (?:on|show|about)|state of the art|sota|published (?:work|results|research)|reward hacking|world models?|agent memory|(?:llm|agent) (?:memory|planning|evaluation|benchmarks?)|tool use|chain[- ]of[- ]thought|in-context learning|rlhf|reinforcement learning|large language models?|how (?:does|do) (?!(?:this|the|that|our|my|your|it|these|those)\b)[\w -]{2,40} work)\b/i,
  visualize: /\b(charts?|diagram|plot|visuali[sz]\w*|flow ?chart)\b/i,
  finance: /\b(runway|burn rate|dcf|valuation|unit economics|ltv|cac|cash ?flow|financ\w*)\b/i,
  data_science: /\b(csv|tsv|jsonl|dataset|correlation|regression analysis|profile (the )?data)\b/i,
  sports: /\b(sports?|team stats|player stats|match results)\b/i,
  fitness: /\b(fitness|workout|training plan)\b/i,
  federated_collab: /\bfederat\w*\b/i,
  codebase_memory: /\bcodebase memory\b/i,
  cross_project_learn: /\b(cross.project|from (my|our) other projects?)\b/i,
  arch_drift: /\b(architect\w* drift|layering|circular (deps|dependencies|imports)|module boundar\w*)\b/i,
  causal_debug: /\b(regressions?|root cause|bisect|used to work|when did .{0,40} break)\b/i,
  causal_fix: /\b(root cause|regression test)\b/i,
  causal_verify: /\bverify (the|this|my) fix\b/i,
  adversarial_verify: /\b(edge cases?|adversarial|exploits?|fuzz\w*)\b/i,
  multi_modal_review: /\b(code review|review (the|this|my) (code|diff|changes?|pr))\b/i,
  self_healing_monitor: /\b(tech(nical)? debt|project health)\b/i,
  spec_verify: /\b(matches the spec|spec(ification)? (compliance|verif\w*)|acceptance criteria)\b/i,
  predictive_impact: /\b(blast radius|what (would|will) break)\b/i,
  temporal_analysis: /\b(over time|code growth|churn trends?)\b/i,
}

/** The deferred tools a request's words say it will need. */
export function toolsCuedBy(text: string, candidates: Iterable<string>): string[] {
  if (!text.trim()) return []
  return [...candidates].filter((name) => {
    const own = new RegExp(`\\b${name.replace(/_/g, '[ _]')}\\b`, 'i')
    return own.test(text) || (TOOL_CUES[name]?.test(text) ?? false)
  })
}

/**
 * Whether to defer tools for a provider. On by default, except for Anthropic:
 * its tool block is cached for an hour and read back at a tenth of the price,
 * while loading a tool changes that block and re-writes the whole cached prefix,
 * history included. There, deferring saves little and can cost more.
 */
export function lazyToolsEnabled(providerKind: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const setting = env.ELIA_LAZY_TOOLS?.trim().toLowerCase()
  if (setting === 'off' || setting === '0' || setting === 'false') return false
  if (setting === 'on' || setting === '1' || setting === 'true') return true
  return providerKind !== 'anthropic'
}

/**
 * The first sentence of a description, capped, for the catalog, plus any
 * sentence that says when to pick this tool over another ("Prefer this over
 * raw git/gh in run_command": without it the model reaches for run_command,
 * where psql and raw git are refused or governed worse) or what it must never
 * do ("Never bypass authentication").
 */
export function toolSummary(description: string, max = 110): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const sentences = flat.split(/(?<=[.!?])\s+(?=[A-Z])/)
  const cap = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text)
  const first = cap(sentences[0] ?? flat, max)
  // Which tool to reach for, and the lines never to cross: both matter before
  // the first call, which is made without the full description.
  const kept = sentences.slice(1).filter((sentence) => /\b(Prefer this|Use this instead|Never)\b/.test(sentence)).map((sentence) => cap(sentence, 150))
  return [first, ...kept].join(' ')
}

/**
 * A call signature for the catalog: required parameters, then optional ones
 * with `?`, and an `action` parameter's choices, so a direct call usually gets
 * its arguments right with no schema. Every name is listed (the widest tool has
 * 27); a call that still gets them wrong is answered with the full schema
 * (`schemaNote`).
 */
export function toolSignature(schema: Tool['input_schema'], maxParams = 40): string {
  const required = new Set(schema.required ?? [])
  const names = Object.keys(schema.properties).sort((a, b) => Number(required.has(b)) - Number(required.has(a)))
  const shown = names.slice(0, maxParams).map((name) => {
    const choices = name === 'action' ? (schema.properties[name] as { enum?: unknown[] } | undefined)?.enum : undefined
    const label = choices?.length ? `${name}: ${choices.join('|')}` : name
    return required.has(name) ? label : `${label}?`
  })
  return `(${shown.join(', ')}${names.length > maxParams ? ', …' : ''})`
}

/**
 * Which tools a session has loaded, shared by every top-level turn so the tool
 * block a session settles on stays put from one turn to the next.
 */
const sessionLoaded = new Set<string>()

export function resetLoadedToolsForTests(): void {
  sessionLoaded.clear()
}

export interface LazyToolSet {
  /** The definitions to send on the next model call. */
  definitions(): Array<{ name: string; description: string; input_schema: Tool['input_schema'] }>
  /** The load_tools tool itself, or undefined when nothing is deferred. */
  loader: Tool | undefined
  /** Marks a deferred tool as used, so its definition is sent from now on. Returns true if that changed anything. */
  markUsed(name: string): boolean
  /** The full parameter schema of a deferred tool, to append when a first direct call fails. */
  schemaNote(name: string): string
  /** Attaches the deferred tools `text` says will be needed (`toolsCuedBy`). Returns the ones newly attached. */
  preload(text: string): string[]
}

/**
 * Splits `tools` into the ones sent in full and the ones behind the catalog.
 * Only names in `deferred` that are present in `tools` are deferred; with none,
 * the definitions are exactly `tools`, and no loader is added.
 */
export function createLazyToolSet(tools: Tool[], deferred: ReadonlySet<string>, loaded: Set<string> = sessionLoaded): LazyToolSet {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const deferrable = tools.filter((tool) => deferred.has(tool.name)).map((tool) => tool.name)
  const define = (tool: Tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })
  if (deferrable.length === 0) return { definitions: () => tools.map(define), loader: undefined, markUsed: () => false, schemaNote: () => '', preload: () => [] }

  const deferrableSet = new Set(deferrable)
  const markUsed = (name: string): boolean => {
    if (!deferrableSet.has(name) || loaded.has(name)) return false
    loaded.add(name)
    return true
  }

  const catalog = deferrable.map((name) => {
    const tool = byName.get(name)!
    return `- ${name}${toolSignature(tool.input_schema)}: ${toolSummary(tool.description)}`
  }).join('\n')
  const loader: Tool = {
    name: LOAD_TOOLS_NAME,
    description: `More tools, listed here to keep every request small. Call any of them directly, like any other tool, whenever the task needs it; there is no need to load it first. If a first call's arguments are wrong, the error shows its full parameters. Use load_tools only to see a tool's full parameters before calling it.\n${catalog}`,
    input_schema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names from the list above.' } },
      required: ['names'],
    },
    async execute(input) {
      const names = Array.isArray(input.names) ? input.names.map(String) : typeof input.names === 'string' ? input.names.split(/[,\s]+/) : []
      const known = names.filter((name) => deferrableSet.has(name))
      const unknown = names.filter((name) => name && !deferrableSet.has(name) && !byName.has(name))
      for (const name of known) markUsed(name)
      const already = names.filter((name) => byName.has(name) && !deferrableSet.has(name))
      const parts = [
        known.length > 0 ? `Loaded: ${known.join(', ')}. Their full definitions are attached from your next step; call them then.` : '',
        already.length > 0 ? `Already available, no need to load: ${already.join(', ')}.` : '',
        unknown.length > 0 ? `No such tool: ${unknown.join(', ')}. Loadable: ${deferrable.join(', ')}.` : '',
      ].filter(Boolean)
      if (known.length === 0 && unknown.length > 0) throw new Error(parts.join(' '))
      return parts.join(' ') || `Pass the names to load. Loadable: ${deferrable.join(', ')}.`
    },
  }

  const core = tools.filter((tool) => !deferrableSet.has(tool.name))
  return {
    // Loaded tools follow the loader in load order, so the block only ever grows at its end.
    definitions: () => [...core, loader, ...[...loaded].filter((name) => deferrableSet.has(name)).map((name) => byName.get(name)!)].map(define),
    loader,
    markUsed,
    preload: (text) => toolsCuedBy(text, deferrable).filter(markUsed),
    schemaNote: (name) => {
      const tool = deferrableSet.has(name) ? byName.get(name) : undefined
      return tool ? `\n\n[elia: the full parameters of ${name}, now attached for your next call: ${JSON.stringify(tool.input_schema)}]` : ''
    },
  }
}
