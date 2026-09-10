/** Public-development ARC-AGI-3 evaluation using Elia's real runAgentLoop. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadUserConfig } from '../src/userConfig.ts'
import { redactText } from '../src/ui/redact.ts'
import { describeObservation, parseAction, type Observation } from '../src/bench/arc3/protocol.ts'
import type { Provider, Usage } from '../src/providers/types.ts'
import type { Tool } from '../src/tools/types.ts'

const { values } = parseArgs({ options: {
  games: { type: 'string' }, actions: { type: 'string', default: '80' },
  calls: { type: 'string', default: '100' }, 'budget-usd': { type: 'string' },
  'minutes-per-game': { type: 'string', default: '15' }, 'smoke-only': { type: 'boolean' },
  'interval-ms': { type: 'string', default: '2000' },
}, strict: true })
function positive(raw: string | undefined, name: string, max: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`${name} must be > 0 and <= ${max}`)
  return value
}
const actionLimit = Math.floor(positive(values.actions, 'actions', 2000))
const callLimit = Math.floor(positive(values.calls, 'calls', 2000))
const minutes = positive(values['minutes-per-game'], 'minutes-per-game', 60)
const intervalMs = positive(values['interval-ms'], 'interval-ms', 60_000)
const budget = values['smoke-only'] ? 0 : positive(values['budget-usd'], 'budget-usd', 100)
loadUserConfig()
process.env.ELIA_PROVIDER = 'mercury'
process.env.ELIA_MODEL = 'mercury-2.5'
process.env.ELIA_FAST_MODEL = 'mercury-2.5'
process.env.ELIA_DEEP_MODEL = 'mercury-2.5'
process.env.ELIA_ROUTING_MODE = 'manual'
process.env.ELIA_SKILLS = 'off'
process.env.ELIA_NO_UPDATE_CHECK = '1'
const model = 'mercury-2.5'
const root = resolve(import.meta.dir, '..')
const dataRoot = join(root, '.elia', 'bench', 'arc3')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = join(dataRoot, 'runs', runId)
mkdirSync(runDir, { recursive: true })
const eventFile = join(runDir, 'events.jsonl')
function record(kind: string, data: unknown) {
  appendFileSync(eventFile, JSON.stringify({ at: new Date().toISOString(), kind, data }) + '\n')
}
const child = spawn(join(dataRoot, '.venv', 'Scripts', 'python.exe'),
  [join(root, 'scripts', 'arc3_bridge.py'), '--root', dataRoot],
  { cwd: dataRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP,
    PYTHONIOENCODING: 'utf-8', OPERATION_MODE: 'offline',
  } })
let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined
const lines = createInterface({ input: child.stdout! })
lines.on('line', line => {
  const waiting = pending
  pending = undefined
  if (!waiting) return
  try {
    const response = JSON.parse(line)
    if (!response.ok) throw new Error(response.error)
    waiting.resolve(response.result)
  } catch (error) { waiting.reject(error instanceof Error ? error : new Error(String(error))) }
})
child.on('error', error => pending?.reject(error))
child.on('exit', () => pending?.reject(new Error('ARC bridge exited')))
child.stderr!.on('data', () => { /* No third-party logs or credential-shaped strings in receipts. */ })
function rpc<T>(request: unknown): Promise<T> {
  if (pending) throw new Error('Concurrent bridge request')
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; child.kill(); reject(new Error('ARC bridge deadline exceeded')) }, 30_000)
    pending = { resolve: value => { clearTimeout(timer); resolve(value as T) }, reject: error => { clearTimeout(timer); reject(error) } }
    child.stdin!.write(JSON.stringify(request) + '\n')
  })
}

const prompt = `You are Elia, interacting with a previously unseen ARC-AGI-3 environment.
Discover its rules and objective from observations and action feedback, and complete every level efficiently.
Pixels are encoded as hexadecimal colors 0-F. Each line gives y (or an inclusive range of identical rows), followed by one character per x coordinate, starting at x=0. All returned frames are provided in order. Coordinates are zero-based, x increases rightward, y downward.
Use arc_action to interact. ACTION1-5 have unknown effects that you must discover. ACTION6 takes x,y coordinates. ACTION7, when available, is undo. RESET restarts according to the environment's rules and counts against your budget.
Prefer one action followed by observation. Every submitted action counts, including unhelpful moves and resets. Track observations and hypotheses in the conversation. Continue until WIN or the harness budget stops the run. A textual claim of success does not count. No game source, solutions, search, or external knowledge tools are available.`

const results: Record<string, unknown>[] = []
let chargedUpperEstimate = 0
let modelCalls = 0
let requestAttempts = 0
let lastRequestAt = 0
// Conservative undiscounted official rates: $0.20/M input, $0.75/M output.
// Reserve an entire 260k input + 32k output request before dispatch. Failed requests retain the reserve.
const requestReserve = (260_000 * 0.20 + 32_000 * 0.75) / 1_000_000
function cost(usage: Usage) { return ((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) * 0.20 + usage.outputTokens * 0.75) / 1_000_000 }
try {
  const discovery = await rpc<{ games: string[]; toolkit: string; engine: string }>({ op: 'list' })
  const games = values.games ? values.games.split(',').map(prefix => {
    const matches = discovery.games.filter(game => game === prefix || game.startsWith(prefix + '-'))
    if (matches.length !== 1) throw new Error(`Game ${prefix} must match exactly one installed environment`)
    return matches[0]!
  }) : discovery.games
  if (!games.length || new Set(games).size !== games.length) throw new Error('No games installed, or duplicate game selection')
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root })
  const harnessHashes: Record<string, string> = {}
  for (const file of ['scripts/bench-arc3.ts', 'scripts/arc3_bridge.py', 'src/bench/arc3/protocol.ts', 'src/agentLoop.ts', 'src/providers/openaiCompatible.ts']) {
    harnessHashes[file] = createHash('sha256').update(new Uint8Array(await Bun.file(join(root, file)).arrayBuffer())).digest('hex')
  }
  const manifest = { runId, model, provider: 'mercury', endpoint: 'https://api.inceptionlabs.ai/v1',
    agent: 'Elia runAgentLoop with ARC action adapter', split: 'public-development', officialLeaderboardSubmission: false,
    ...discovery, games, seed: 0, actionLimit, callLimit, minutes, intervalMs, budgetUsd: budget, harnessHashes,
    gitCommit: new TextDecoder().decode(git.stdout).trim(), prompt, encoding: 'lossless hexadecimal pixels with repeated-row ranges',
    memory: 'fresh per environment; conversation retained within environment', fallbackProviders: [],
    tools: ['arc_action'], costBasis: 'undiscounted input/output rates; cached input charged as uncached; failed requests reserved at maximum',
    smokeOnly: !!values['smoke-only'] }
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const { runAgentLoop } = await import('../src/agentLoop.ts')
  const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.ts')
  const { createActionGovernor, withActionGovernor } = await import('../src/autonomy/governor.ts')
  const realProvider = values['smoke-only'] ? undefined : createOpenAICompatibleProvider(process.env.INCEPTION_API_KEY ?? '', model, 'https://api.inceptionlabs.ai/v1')
  if (!values['smoke-only'] && !process.env.INCEPTION_API_KEY) throw new Error('INCEPTION_API_KEY is not configured')
  const provider: Provider = { async streamTurn(params) {
    if (chargedUpperEstimate + requestReserve > budget) throw new Error('Benchmark dollar budget exhausted')
    const wait = Math.max(0, intervalMs - (Date.now() - lastRequestAt))
    if (wait) await Bun.sleep(wait)
    if (params.signal?.aborted) throw new Error('Benchmark time budget exhausted')
    lastRequestAt = Date.now()
    requestAttempts++
    chargedUpperEstimate += requestReserve
    const started = performance.now()
    let response: Awaited<ReturnType<Provider['streamTurn']>>
    try { response = await realProvider!.streamTurn(params) }
    catch (error) {
      const failure = error as { name?: string; status?: number; code?: string; message?: string }
      record('provider_error', { name: failure.name, status: failure.status, code: failure.code,
        message: redactText(failure.message ?? 'unknown provider failure', 700), requestAttempts, chargedUpperEstimate })
      throw error
    }
    const usage = response.usage
    if (![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(n => Number.isFinite(n) && n >= 0)
      || usage.inputTokens + usage.outputTokens + usage.cacheReadTokens === 0) throw new Error('Missing usable provider usage; budget cannot be tracked')
    chargedUpperEstimate += cost(usage) - requestReserve
    modelCalls++
    record('model_call', { model, usage, elapsedMs: performance.now() - started, chargedUpperEstimate })
    return response
  } }
  for (const game of games) {
    const started = performance.now()
    const callsBefore = modelCalls
    let observation = await rpc<Observation>({ op: 'start', game })
    record('initial_observation', observation)
    let actions = 0
    let queue = Promise.resolve()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('wall-clock budget'), minutes * 60_000)
    const tool: Tool = { name: 'arc_action', description: 'Perform one available action and receive the new complete pixel observation.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'] }, x: { type: 'integer', minimum: 0, maximum: 63 }, y: { type: 'integer', minimum: 0, maximum: 63 } }, required: ['action'] },
      execute(input) {
        const operation = queue.then(async () => {
          if (observation.state === 'WIN') return 'WIN: all levels completed. Stop.'
          if (controller.signal.aborted || actions >= actionLimit) throw new Error('Action or time budget exhausted')
          const action = parseAction(input, observation.available_actions)
          observation = await rpc<Observation>({ op: 'action', ...action })
          actions++
          record('action', { game, number: actions, ...action, observation })
          console.log(`${game}: action ${actions}/${actionLimit}; levels ${observation.levels_completed}/${observation.win_levels}; ${observation.state}`)
          if (observation.state === 'WIN' || actions >= actionLimit) controller.abort('terminal game or action budget')
          return describeObservation(observation)
        })
        queue = operation.then(() => {}, () => {})
        return operation
      } }
    let loop: unknown
    let error: string | undefined
    try {
      if (values['smoke-only']) {
        const available = observation.available_actions[0]
        if (available === undefined) throw new Error('No available action')
        await tool.execute({ action: `ACTION${available}`, ...(available === 6 ? { x: 0, y: 0 } : {}) })
      } else {
        const governor = createActionGovernor({ mode: 'supervised', maxActions: actionLimit + 5,
          approve: async (_assessment, request) => request.name === 'arc_action' })
        loop = await withActionGovernor(governor, () => runAgentLoop({
          messages: [{ role: 'user', content: [{ type: 'text', text: `Play this environment. Action budget: ${actionLimit}.\n${describeObservation(observation)}` }] }],
          systemPrompt: prompt, tools: [tool], provider, providerName: 'mercury', model, fallbacks: [], maxSteps: callLimit,
          useAnimation: false, verbose: false, signal: controller.signal,
          onText: text => record('agent_text', { game, text }),
          onTool: event => { if (event.isError) record('tool_error', { game, name: event.name, result: event.result }) },
        }))
      }
    } catch (caught) {
      // Store a classification, not provider exception bodies which may contain request metadata.
      error = redactText(caught instanceof Error ? caught.message : 'Provider or harness execution failed', 700)
    } finally { clearTimeout(timer); await queue }
    const scorecard = await rpc<Record<string, unknown>>({ op: 'close' })
    const result = { game, actions, modelCalls: modelCalls - callsBefore, state: observation.state,
      levelsCompleted: observation.levels_completed, totalLevels: observation.win_levels,
      won: observation.state === 'WIN', elapsedMs: performance.now() - started, loop, error, scorecard }
    results.push(result)
    writeFileSync(join(runDir, 'results.json'), JSON.stringify({ manifest, chargedUpperEstimate, modelCalls, requestAttempts, results }, null, 2))
    console.log(JSON.stringify({ game, score: scorecard.score, levels: observation.levels_completed, actions, error }))
    if (error) process.exitCode = 1
    if (error || chargedUpperEstimate + requestReserve > budget && !values['smoke-only']) break
  }
  console.log(`Benchmark receipt: ${join(runDir, 'results.json')}`)
} finally {
  child.stdin!.end()
  lines.close()
  child.kill()
}
