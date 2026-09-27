// Headless smoke of the real elia_run_task path through the MCP server. This is
// the one thing the test suite cannot prove: a REAL provider round trip. Every
// test drives elia_run_task against a fake execution context, so the
// plan -> execute -> verify -> review chain, the governor, and the receipt
// writer have never run here against an actual model.
//
//   bun run mcp:smoke ["goal"]
//
// It uses whichever provider elia is already configured for -- the same
// resolution the CLI uses, not a hardcoded vendor -- so set ELIA_PROVIDER and
// the matching key as you would for any other elia command. It refuses to run
// on the local test key, and it refuses to run at all if no provider resolves.
//
// The run happens in a throwaway temp directory, writes one small file, and is
// bounded on cost, wall clock, and action count, because this spends real money.
//
// Note what this does NOT do: it does not bypass the governor. The approver
// below grants 'safe' actions and refuses 'review' and 'critical', so if the
// planner reaches for anything the governor considers risky the run stops and
// says so. That refusal is a correct outcome, not a failure of the harness.
//
// Exit 0 = a real model planned, executed, and the receipt landed.
// Exit 1 = no usable run (no provider, test key, network, provider
// misconfiguration, every action refused, or the run crashed).
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadUserConfig } from '../src/userConfig.ts'
import { paths } from '../src/statePaths.ts'
import type { ActionApproval } from '../src/autonomy/governor.ts'
import { loadEliaMcpServerConfigFromCli } from '../src/mcp/config.ts'
import { createEliaMcpServer } from '../src/mcp/server.ts'
import { isJsonRpcResponse } from '../src/mcp/protocol.ts'
import { tryResolveProvider } from '../src/providers/registry.ts'

loadUserConfig()

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function resultOf(response: unknown): unknown {
  return isJsonRpcResponse(response) && 'result' in response ? response.result : undefined
}

interface InitializeResult {
  protocolVersion: string
  serverInfo: { name: string; version: string }
}

interface RunTaskOutput {
  status?: string
  run_id?: string
  error?: string
}

const goal = process.argv[2] ?? 'Create a file named hello.txt in this project whose only content is the single word hello.'
const COST_LIMIT_USD = 0.50

function fail(message: string): never {
  console.error(`[mcp-run-task-smoke] ${message}`)
  process.exit(1)
}

// One placeholder stands in for several vendors' keys in tests, so refuse it
// wherever it is the thing that would authenticate the call.
const placeholderKeys = new Set(['test-key-for-local-tests'])
const configuredKeys = Object.entries(process.env)
  .filter(([name, value]) => name.endsWith('_API_KEY') && value !== undefined && placeholderKeys.has(value))
  .map(([name]) => name)
if (configuredKeys.length > 0) {
  fail(`${configuredKeys.join(', ')} is the local test key. A real provider key is required for a real round trip.`)
}

const resolved = tryResolveProvider()
if ('error' in resolved) {
  fail(`no usable provider: ${resolved.error}. Set ELIA_PROVIDER and that provider's API key, then retry.`)
}
console.log(`[mcp-run-task-smoke] provider ${resolved.providerName}/${resolved.model}, cost ceiling $${COST_LIMIT_USD.toFixed(2)}`)
console.log(`[mcp-run-task-smoke] goal: ${goal}`)

const cwd = join(tmpdir(), `mcp-run-task-smoke-${Date.now()}`)
mkdirSync(cwd, { recursive: true })

let granted = 0
let refused = 0
let approverCalls = 0
const approve: ActionApproval = async (assessment) => {
  approverCalls += 1
  if (assessment.risk === 'safe') {
    granted += 1
    return true
  }
  refused += 1
  console.log(`[mcp-run-task-smoke] refused a ${assessment.risk} action: ${assessment.reason}`)
  return false
}

async function main(): Promise<number> {
  const server = await createEliaMcpServer({
    cwd,
    config: loadEliaMcpServerConfigFromCli(['--transport', 'stdio', '--cost-limit-per-session-usd', String(COST_LIMIT_USD)]),
    approve,
  })

  try {
    const init = await server.handleRequest({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run-task-smoke', version: '0' } },
    })
    const negotiated = resultOf(init) as InitializeResult | undefined
    if (negotiated === undefined) fail('the handshake returned no result.')
    console.log(`[mcp-run-task-smoke] negotiated ${negotiated.protocolVersion}, server ${negotiated.serverInfo.name} ${negotiated.serverInfo.version}`)

    const call = await server.handleRequest({
      jsonrpc: '2.0',
      id: 'run',
      method: 'tools/call',
      params: {
        name: 'elia_run_task',
        arguments: {
          goal,
          mode: 'dev',
          approve_plan_automatically: true,
          // Generous enough that a real model can plan, execute, verify, and
          // still retry a failed check. The cost ceiling is the real bound;
          // this is only here to stop an unbounded turn loop.
          max_wall_clock_s: 600,
          max_actions: 60,
        },
      },
    })
    const envelope = resultOf(call) as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined
    const output = envelope?.structuredContent as RunTaskOutput | undefined
    if (envelope?.isError === true || output === undefined) {
      fail(`the tool call failed: ${JSON.stringify(envelope ?? call).slice(0, 500)}`)
    }

    console.log(`[mcp-run-task-smoke] status=${output.status} run_id=${output.run_id ?? 'none'}`)

    // Run artefacts live in the elia state dir, which is derived from the elia
    // root -- not from the temp project the run was pointed at.
    const runId = typeof output.run_id === 'string' ? output.run_id : undefined
    const runDir = runId === undefined ? undefined : join(paths.runs, runId)
    const receipt = runDir === undefined ? undefined : readJson(join(runDir, 'receipt.json'))
    const wroteFile = existsSync(join(cwd, 'hello.txt'))

    // receipt.verification is the list of `verify` events, oldest first, not a
    // single object, so the run is green only if the last one that carries a
    // verdict says it passed.
    const verifyEvents = Array.isArray(receipt?.verification) ? (receipt?.verification as Record<string, unknown>[]) : []
    const lastVerdict = verifyEvents.filter((event) => typeof event.passed === 'boolean').pop()
    const verificationPassed = lastVerdict?.passed === true

    console.log(`[mcp-run-task-smoke] run artefacts: ${runDir ?? '(no run id)'}`)
    console.log(`[mcp-run-task-smoke] wrote hello.txt: ${wroteFile}`)
    if (receipt !== undefined) {
      const usage = (receipt.usage ?? {}) as { inputTokens?: number; outputTokens?: number }
      const completion = (receipt.completion ?? {}) as { state?: string; confidence?: string }
      const budget = (receipt.actionBudget ?? {}) as { consumed?: number; maxActions?: number }
      console.log(`[mcp-run-task-smoke] receipt outcome=${String(receipt.outcome ?? 'unknown')} completion=${completion.state ?? 'unknown'}/${completion.confidence ?? 'unknown'}`)
      console.log(`[mcp-run-task-smoke] verify events: ${verifyEvents.length}, last verdict: ${lastVerdict === undefined ? 'none' : String(lastVerdict.passed)}`)
      console.log(`[mcp-run-task-smoke] actions: ${budget.consumed ?? 0}/${budget.maxActions ?? 0}; approver consulted ${approverCalls}x (${granted} granted, ${refused} refused)`)
      console.log(`[mcp-run-task-smoke] real tokens: ${usage.inputTokens ?? 0} in, ${usage.outputTokens ?? 0} out`)
    }

    if (receipt === undefined) {
      fail(`no receipt was written for run ${runId ?? '(none)'}, so the cycle did not complete. status was ${output.status}${output.error === undefined ? '' : `, error: ${output.error}`}`)
    }
    if (!verificationPassed) {
      fail(`the run produced a receipt but its verification did not pass, so this is not a green round trip. Artefacts are in ${runDir}.`)
    }
    if (!wroteFile) {
      fail('the run finished but never created hello.txt, so the model did not actually do the work.')
    }

    console.log(`\n[mcp-run-task-smoke] ok — a real model planned, executed, and passed its own verification.`)
    return 0
  } finally {
    await server.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[mcp-run-task-smoke] error:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
