import { flagValue, hasFlag, positionals, strictInteger } from '../cli/argv.ts'
import { writeError, writeUsageLine } from '../ui/stream.ts'
import { DATASCIENCE_TOOLS, EFFECTS } from './effects.ts'

/**
 * `elia ds …` — the operator's view of the data-science workspace, run by a person rather
 * than a model: what the engine can do, what has been loaded, what ran and whether it
 * validated, and whether the delivered artifacts still match their recorded hashes.
 */

const USAGE = `Usage: elia ds <command>        (elia datascience … is the same)

  capabilities [--json]          Every ds_* action, what it does, and how it touches the world
  datasets [--json]              Registered datasets: version, rows, source or derivation
  runs [--limit 20] [--json]     Recent execution records and their validation status
  record <runId>                 One execution record in full (inputs, code, checks, outputs)
  verify [--json]                Recheck every recorded artifact against its SHA-256
  python                         The Python interpreter and data packages the engine can use

  Analysis itself runs through the agent: elia --datascience "<question>" (or /mode datascience).`

export async function runDataScience(): Promise<void> {
  const args = positionals(['--limit'])
  const command = args[0]
  if (!command || command === 'help') {
    writeUsageLine(USAGE)
    return
  }
  try {
    await dispatch(command, args.slice(1))
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

async function dispatch(command: string, rest: string[]): Promise<void> {
  const json = hasFlag('--json')
  if (command === 'capabilities') {
    await import('./capabilities/index.ts')
    const { capabilitiesFor } = await import('./engine.ts')
    const rows = DATASCIENCE_TOOLS.flatMap((tool) => capabilitiesFor(tool).map((capability) => ({ tool, action: capability.action, effect: typeof EFFECTS[`${tool}.${capability.action}`] === 'function' ? 'depends on the call' : String(EFFECTS[`${tool}.${capability.action}`]), summary: capability.summary })))
    if (json) return writeUsageLine(JSON.stringify(rows, null, 1))
    for (const tool of DATASCIENCE_TOOLS) {
      writeUsageLine(tool)
      for (const row of rows.filter((r) => r.tool === tool)) writeUsageLine(`  ${row.action.padEnd(18)} ${row.effect.padEnd(22)} ${row.summary.length > 110 ? `${row.summary.slice(0, 107)}…` : row.summary}`)
    }
    return
  }
  const { Workspace, refOf } = await import('./workspace.ts')
  const workspace = new Workspace()
  if (command === 'datasets') {
    const datasets = workspace.datasets()
    if (json) return writeUsageLine(JSON.stringify(datasets.map(({ name, version, rows, columns, kind, fingerprint, createdAt, source, derivation, grain }) => ({ ref: refOf({ name, version }), rows, columns: columns.length, kind, fingerprint, createdAt, grain, source: source ? { kind: source.kind, path: source.path, url: source.url, table: source.table } : undefined, derivedFrom: derivation?.inputs })), null, 1))
    if (!datasets.length) return writeUsageLine('No datasets yet. Load one through the agent: elia --datascience "load data/orders.csv and profile it"')
    for (const d of datasets) writeUsageLine(`${refOf(d).padEnd(28)} ${String(d.rows).padStart(9)} rows × ${String(d.columns.length).padStart(3)} cols  ${d.kind === 'source' ? `from ${d.source?.path ?? d.source?.url ?? d.source?.table ?? d.source?.kind ?? '?'}` : `derived from ${d.derivation?.inputs.join(', ') ?? '?'} (${d.derivation?.operation ?? '?'})`}`)
    return
  }
  if (command === 'runs') {
    const limit = strictInteger(flagValue('--limit')) ?? 20
    const runs = workspace.listRecords(limit).map(({ record }) => record)
    if (json) return writeUsageLine(JSON.stringify(runs.map((r) => ({ id: r.id, tool: r.tool, action: r.action, status: r.status, startedAt: r.startedAt, durationMs: r.durationMs, error: r.error })), null, 1))
    if (!runs.length) return writeUsageLine('No execution records yet.')
    for (const r of runs) writeUsageLine(`${String(r.startedAt).slice(0, 19)}  ${String(r.id).padEnd(26)} ${`${String(r.tool)}.${String(r.action)}`.padEnd(28)} ${String(r.status)}${r.error ? ` — ${String(r.error).split('\n')[0]}` : ''}`)
    return
  }
  if (command === 'record') {
    const id = rest[0]
    if (!id) throw new Error('Usage: elia ds record <runId>')
    return writeUsageLine(JSON.stringify(workspace.readRecord(id), null, 1))
  }
  if (command === 'verify') {
    const artifacts = workspace.verifyArtifacts()
    if (json) return writeUsageLine(JSON.stringify(artifacts, null, 1))
    if (!artifacts.length) return writeUsageLine('No recorded artifacts.')
    for (const a of artifacts) writeUsageLine(`${a.status.padEnd(9)} ${a.path}`)
    const bad = artifacts.filter((a) => a.status !== 'ok').length
    writeUsageLine(bad ? `${bad} of ${artifacts.length} artifact(s) are missing or changed since they were recorded.` : `All ${artifacts.length} artifact(s) match their recorded hashes.`)
    if (bad) process.exitCode = 1
    return
  }
  if (command === 'python') {
    const { detectPython, KNOWN_PACKAGES } = await import('./python.ts')
    const runtime = await detectPython({ refresh: true })
    if (!runtime) return writeUsageLine(`No Python 3.9+ found. The TypeScript engine needs none; Python adds ${KNOWN_PACKAGES.slice(0, 6).join(', ')}, … when installed.`)
    writeUsageLine(`${runtime.executable} (Python ${runtime.version})${runtime.managed ? ' — managed environment .elia/datascience/venv' : ''}`)
    const installed = Object.entries(runtime.packages).filter(([, version]) => version)
    writeUsageLine(`installed: ${installed.length ? installed.map(([name, version]) => `${name} ${version}`).join(', ') : 'none of the known data packages'}`)
    return
  }
  throw new Error(`Unknown command "${command}".\n${USAGE}`)
}
