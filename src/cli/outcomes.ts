import { flagValue, positionals } from './argv.ts'
import { writeError, writeNotice, writeUsageLine } from '../ui/stream.ts'
import { table } from '../ui/layout.ts'
import { OutcomeStore, formatOutcomeDelay, parseOutcomeDelay, type OutcomeProbe } from '../autonomy/outcomesClosure.ts'

const VALUE_FLAGS = ['--after', '--file', '--contains', '--title', '--run']

export async function runOutcomes(): Promise<void> {
  const action = positionals(VALUE_FLAGS)[0] ?? 'list'
  const store = OutcomeStore.open()

  if (action === 'list') {
    const records = store.list()
    if (records.length === 0) {
      writeNotice('No delayed outcome checks. Add one with: elia outcomes add --after 5m --file path/to/artifact')
      return
    }
    for (const line of table(
      [{ header: 'id' }, { header: 'status' }, { header: 'due' }, { header: 'attempts', align: 'right' }, { header: 'title' }, { header: 'probe' }],
      records.map((record) => [record.id, record.status, new Date(record.dueAt).toISOString(), String(record.attempts), record.title.slice(0, 50), describeProbe(record.probe)]),
    )) writeUsageLine(`  ${line}`)
    return
  }

  const id = positionals(VALUE_FLAGS)[1]
  if (action === 'show') {
    if (!id) {
      writeError('Usage: elia outcomes show <id>')
      process.exitCode = 1
      return
    }
    const record = store.get(id)
    if (!record) {
      writeError(`Unknown outcome check: ${id}`)
      process.exitCode = 1
      return
    }
    writeUsageLine(JSON.stringify(record, null, 2))
    return
  }

  if (action === 'check') {
    const checked = store.checkDue()
    if (checked.length === 0) {
      writeNotice('No due outcome checks.')
      return
    }
    for (const record of checked) writeUsageLine(`${record.status.toUpperCase()} ${record.id}: ${record.title}${record.failure ? ` — ${record.failure}` : ''}`)
    return
  }

  if (action !== 'add') {
    writeError(`Unknown outcomes action "${action}". Use: add, list, show, or check.`)
    process.exitCode = 1
    return
  }

  const after = flagValue('--after')
  const file = flagValue('--file')
  const contains = flagValue('--contains')
  if (!after || !file || (contains !== undefined && !contains)) {
    writeError('Usage: elia outcomes add --after 5m --file path/to/artifact [--contains "expected text"] [--title "Title"] [--run run-id]')
    process.exitCode = 1
    return
  }
  let delayMs: number
  try {
    delayMs = parseOutcomeDelay(after)
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const probe: OutcomeProbe = contains === undefined ? { kind: 'file-exists', path: file } : { kind: 'file-contains', path: file, text: contains }
  try {
    const record = store.add({ title: flagValue('--title') || 'Delayed outcome check', delayMs, probe, runId: flagValue('--run') || undefined })
    writeNotice(`Tracking ${record.title} (${record.id}); first check due in ${formatOutcomeDelay(delayMs)} at ${new Date(record.dueAt).toISOString()}.`)
    writeNotice('Run `elia outcomes check` or `elia daemon --once` to resolve due checks.')
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function describeProbe(probe: OutcomeProbe): string {
  return probe.kind === 'file-exists' ? `file exists: ${probe.path}` : `file contains: ${probe.path} / ${probe.text.slice(0, 40)}`
}
