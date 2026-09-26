// Headless smoke of the real elia_run_task path through the MCP server. This is
// the one thing the test suite cannot prove: a REAL provider round trip. Every
// test drives elia_run_task against a fake execution context, so the
// plan -> execute -> verify -> review chain, the governor, and the receipt
// writer have never run here against an actual model.
//
//   ANTHROPIC_API_KEY=... bun run scripts/mcp-run-task-smoke.ts ["goal"]
//
// The run happens in a throwaway temp directory, writes one small file, and is
// bounded on wall clock and action count, because this spends real money.
//
// Note what this does NOT do: it does not bypass the governor. The approver
// below grants 'safe' actions and refuses 'review' and 'critical', so if the
// planner reaches for anything the governor considers risky the run stops and
// says so. That refusal is a correct outcome, not a failure of the harness.
//
// Exit 0 = a real model planned, executed, and the receipt landed.
// Exit 1 = no usable run (missing/bad key, network, provider misconfiguration,
// every action refused, or the run crashed).
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionApproval } from '../src/autonomy/governor.ts'
import { loadEliaMcpServerConfigFromCli } from '../src/mcp/config.ts'
import { createEliaMcpServer } from '../src/mcp/server.ts'
import { isJsonRpcResponse } from '../src/mcp/protocol.ts'

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

function fail(message: string): never {
  console.error(`[mcp-run-task-smoke] ${message}`)
  process.exit(1)
}

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? ''
if (apiKey.length === 0) fail('ANTHROPIC_API_KEY is not set. This smoke makes a real provider call and costs real money.')
if (apiKey === 'test-key-for-local-tests') fail('ANTHROPIC_API_KEY is the local test key. A real key is required for a real round trip.')

const cwd = join(tmpdir(), `mcp-run-task-smoke-${Date.now()}`)
mkdirSync(cwd, { recursive: true })

let granted = 0
let refused = 0
const approve: ActionApproval = async (assessment) => {
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
    config: loadEliaMcpServerConfigFromCli(['--transport', 'stdio', '--cost-limit-per-session-usd', '0.50']),
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
          max_wall_clock_s: 300,
          max_actions: 12,
        },
      },
    })
    const envelope = resultOf(call) as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined
    const output = envelope?.structuredContent as RunTaskOutput | undefined
    if (envelope?.isError === true || output === undefined) {
      fail(`the tool call failed: ${JSON.stringify(envelope ?? call).slice(0, 500)}`)
    }

    console.log(`[mcp-run-task-smoke] status=${output.status} run_id=${output.run_id ?? 'none'}`)
    console.log(`[mcp-run-task-smoke] actions: ${granted} approved, ${refused} refused`)

    const runId = typeof output.run_id === 'string' ? output.run_id : undefined
    const runsRoot = join(cwd, '.elia', 'runs')
    const receiptOnDisk = runId !== undefined && existsSync(join(runsRoot, runId, 'receipt.json'))
    const wroteFile = existsSync(join(cwd, 'hello.txt'))
    const actionsRecorded = runId !== undefined && existsSync(join(runsRoot, runId, 'actions.ndjson'))

    console.log(`[mcp-run-task-smoke] receipt on disk: ${receiptOnDisk}`)
    console.log(`[mcp-run-task-smoke] action ledger on disk: ${actionsRecorded}`)
    console.log(`[mcp-run-task-smoke] wrote hello.txt: ${wroteFile}`)
    if (existsSync(runsRoot)) {
      console.log(`[mcp-run-task-smoke] run ids: ${readdirSync(runsRoot).join(', ')}`)
    }

    if (!receiptOnDisk) {
      fail(`no receipt was written for run ${runId ?? '(none)'}, so the cycle did not complete. status was ${output.status}${output.error === undefined ? '' : `, error: ${output.error}`}`)
    }
    if (granted === 0) {
      fail('every governed action was refused, so the provider never actually executed anything.')
    }

    console.log(`\n[mcp-run-task-smoke] ok — a real model planned and executed under the governor, status ${output.status}.`)
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
