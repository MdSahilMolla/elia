import { createInterface } from 'node:readline/promises'
import { flagValue, hasFlag, positionals, strictInteger } from '../cli/argv.ts'
import { writeError, writeUsageLine } from '../ui/stream.ts'

/**
 * `elia si …` — the operator's view of the organization record, run by a person rather
 * than a model: the board, one initiative, the reviews, the journal, artifact integrity,
 * and the two things only a person may do — sign off a gate, and give a review of their
 * own. Those two need a real terminal and a typed confirmation, so a model driving a
 * shell cannot perform them on the person's behalf.
 */

const USAGE = `Usage: elia si <command>        (elia sysintel … is the same)

  board                              Every initiative, its stage, owner, and open gates (default)
  show <SI-n>                        One initiative in full, gates evaluated now
  report <view> [--days N]           priorities · week · quarter · flywheel · dependencies · risks · knowledge · digest
  journal [--limit 50]               The append-only log of every change to the record
  verify                             Recheck every artifact against its recorded hash
  org | structure | lifecycles [id] | template <kind> | reviews | cadence
                                     The organization model: hats, the org chart, lifecycles, templates, reviews, rhythms
  signoff <SI-n> <gate> [--note ".."] Sign off a gate yourself (direction, release, production, accept-risk)
  review <SI-n> <kind> <approve|changes-requested|reject> --note ".." [--finding ".."]
                                     Record your own review (it counts as independent)

  Work itself runs through the agent: elia --sysintel "<goal>" (or /mode sysintel).`

export async function runSysintel(): Promise<void> {
  const args = positionals(['--days', '--limit', '--note', '--finding'])
  const command = args[0] ?? 'board'
  if (command === 'help') {
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

function requireTerminal(what: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${what} must be given by a person at an interactive terminal — it cannot be scripted or piped. Nothing was recorded.`)
}

async function confirm(expected: string, what: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${what}\nType ${expected} to confirm: `)).trim()
    if (answer.toUpperCase() !== expected.toUpperCase()) throw new Error('not confirmed — nothing was recorded')
  } finally {
    rl.close()
  }
}

function allFlagValues(flag: string): string[] {
  const values: string[] = []
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1] !== undefined) values.push(argv[index + 1]!)
    else if (argv[index]?.startsWith(`${flag}=`)) values.push(argv[index]!.slice(flag.length + 1))
  }
  return values
}

async function dispatch(command: string, rest: string[]): Promise<void> {
  const { operatorContext, runAction, recordSignoff } = await import('./engine.ts')
  const operator = operatorContext()
  const run = async (tool: 'si_org' | 'si_work' | 'si_artifact' | 'si_record', input: Record<string, unknown>): Promise<void> => writeUsageLine(await runAction(tool, input, { by: operator.by }))
  switch (command) {
    case 'board':
      return run('si_work', { action: 'list' })
    case 'show':
      if (!rest[0]) throw new Error('Usage: elia si show <SI-n>')
      return run('si_work', { action: 'show', id: rest[0] })
    case 'report': {
      const view = rest[0] ?? 'week'
      const days = strictInteger(flagValue('--days'))
      return run('si_work', { action: 'report', view, ...(days ? { days } : {}) })
    }
    case 'journal': {
      const limit = strictInteger(flagValue('--limit')) ?? 50
      const entries = operator.store.journal(limit)
      if (!entries.length) return writeUsageLine('The journal is empty.')
      for (const entry of entries) writeUsageLine(`${entry.at.slice(0, 19)}  ${entry.initiative.padEnd(6)} ${entry.event.padEnd(12)} ${entry.by.name.padEnd(12)} ${entry.detail ?? ''}`)
      return
    }
    case 'verify': {
      let bad = 0
      let total = 0
      for (const initiative of operator.store.list()) {
        for (const artifact of initiative.artifacts) {
          total += 1
          const status = operator.store.artifactIntact(artifact)
          if (status !== 'ok') bad += 1
          if (status !== 'ok' || hasFlag('--all')) writeUsageLine(`${status.padEnd(8)} ${initiative.id} ${artifact.id} ${artifact.path}`)
        }
      }
      writeUsageLine(total ? (bad ? `${bad} of ${total} artifact version(s) are missing or changed since they were recorded.` : `All ${total} artifact version(s) match their recorded hashes.`) : 'No artifacts recorded.')
      if (bad) process.exitCode = 1
      return
    }
    case 'org':
    case 'roles':
      return run('si_org', { action: 'ownership' })
    case 'lifecycles':
      return rest[0] ? run('si_org', { action: 'lifecycle', lifecycle: rest[0] }) : run('si_org', { action: 'lifecycles' })
    case 'template':
    case 'templates':
      if (!rest[0]) {
        const { ARTIFACT_TEMPLATES } = await import('./artifacts.ts')
        for (const template of ARTIFACT_TEMPLATES) writeUsageLine(`${template.kind.padEnd(22)} ${template.title} — ${template.purpose}`)
        return
      }
      return run('si_artifact', { action: 'template', artifact: rest[0] })
    case 'reviews':
      return run('si_org', { action: 'reviews' })
    case 'structure':
    case 'teams':
      return run('si_org', { action: 'structure' })
    case 'cadence':
      return run('si_org', { action: 'cadence' })
    case 'signoff': {
      const [id, gate] = rest
      if (!id || !gate) throw new Error('Usage: elia si signoff <SI-n> <direction|release|production|accept-risk> [--note "..."]')
      const { SIGNOFF_GATES, isSignoffGate } = await import('./org.ts')
      if (!isSignoffGate(gate)) throw new Error(`gate must be one of ${Object.keys(SIGNOFF_GATES).join(', ')}`)
      requireTerminal('A sign-off')
      const initiative = operator.store.read(id)
      writeUsageLine(await runAction('si_work', { action: 'gate', id: initiative.id }, { by: operator.by }))
      await confirm(initiative.id, `\nYou are signing off: ${SIGNOFF_GATES[gate]}\nInitiative ${initiative.id} — ${initiative.title}`)
      return writeUsageLine(recordSignoff(operator, initiative.id, gate, flagValue('--note') ?? 'signed off at the terminal', 'operator-cli'))
    }
    case 'review': {
      const [id, kind, verdict] = rest
      const note = flagValue('--note')
      if (!id || !kind || !verdict || !note) throw new Error('Usage: elia si review <SI-n> <kind> <approve|changes-requested|reject> --note "what you reviewed" [--finding "..."]')
      requireTerminal('Your own review')
      const initiative = operator.store.read(id)
      await confirm(initiative.id, `\nYou are recording your own ${kind} (${verdict}) for ${initiative.id} — ${initiative.title}`)
      return run('si_record', { action: 'review', id: initiative.id, kind, verdict, summary: note, findings: allFlagValues('--finding') })
    }
    default:
      throw new Error(`Unknown command "${command}".\n${USAGE}`)
  }
}
