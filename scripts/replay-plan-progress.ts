// Replays recorded sessions through the plan-progress tracker
// (src/autonomy/planProgress.ts) and scores its ticks against the model's own
// todo_write completions — the check for any change to what counts as proof.
//
//   bun run scripts/replay-plan-progress.ts [sessions-dir] [-v] [-m] [-l]
//
//   -v  print every tick and reminder as it would reach the model
//   -m  list steps the model marked done that elia never ticked
//   -l  list ticks that came 8+ tool calls before the model's own
//
// "eliaLater" must stay 0 and every "elia ticked, model never did" line must be
// real work; those are the false ticks this script exists to catch.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTodoList, type TodoItem } from '../src/autonomy/todoList.ts'
import { createPlanProgressTracker, stepAnchors } from '../src/autonomy/planProgress.ts'

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const dir = args.find((arg) => !arg.startsWith('-')) ?? join(process.cwd(), '.elia', 'sessions')
if (!existsSync(dir)) {
  console.error(`No recorded sessions at ${dir}`)
  process.exit(1)
}

const key = (text: string): string => text.replace(/[`'"*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
const anchorsOf = (content: string): string => JSON.stringify(stepAnchors(content).map((anchor) => `${anchor.kind}:${anchor.key}`))

interface RecordedTool {
  kind: 'tool'
  turn: number
  name: string
  input?: Record<string, unknown>
  status?: string
  result?: string
  actor?: string
}

const totals = { plans: 0, steps: 0, anchored: 0, modelDone: 0, eliaTicked: 0, both: 0, eliaOnly: 0, modelOnly: 0, eliaLater: 0, notes: 0, nudges: 0 }
let leadSum = 0
const eliaOnly: string[] = []
const modelOnly: string[] = []
const bigLeads: string[] = []

for (const file of readdirSync(dir).filter((name) => name.endsWith('.json') && !name.includes('checkpoints')).sort()) {
  let session: { recording?: { items?: Array<Record<string, unknown>> } }
  try {
    session = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  } catch {
    continue
  }
  const items = session.recording?.items ?? []
  const turns = new Map<number, Array<Record<string, unknown>>>()
  for (const item of items) {
    const turn = Number(item.turn)
    if (!turns.has(turn)) turns.set(turn, [])
    turns.get(turn)!.push(item)
  }

  for (const [turn, list] of turns) {
    // Only the lead's calls: a sub-agent works under its own list.
    const tools = list.filter((item): item is RecordedTool & Record<string, unknown> => item.kind === 'tool' && (!item.actor || item.actor === 'lead'))
    const isPlanWrite = (tool: RecordedTool): boolean => tool.name === 'todo_write' && tool.status !== 'error' && Array.isArray(tool.input?.items)
    const planNotice = list.find((item) => item.kind === 'notice' && /\nPlan:\n1\./.test(String(item.text ?? '')))
    let initial: TodoItem[] | undefined
    let startAt = 0
    if (planNotice) {
      initial = String(planNotice.text).split('\nPlan:\n')[1]!.split('\n')
        .flatMap((line) => /^\d+\.\s+(.*)$/.exec(line)?.slice(1, 2) ?? [])
        .map((content, index) => ({ content, status: index === 0 ? 'in_progress' : 'pending' }))
    } else {
      const first = tools.findIndex(isPlanWrite)
      if (first >= 0) {
        initial = tools[first]!.input!.items as TodoItem[]
        startAt = first + 1
      }
    }
    if (!initial || initial.length < 2) continue
    totals.plans += 1

    const todo = createTodoList()
    todo.write(initial)
    const tracker = createPlanProgressTracker({ list: () => todo, root: process.cwd(), owned: () => true })
    const eliaAt = new Map<string, number>()
    const modelAt = new Map<string, number>()
    const wording = new Map<string, string>()
    // A step first written already done is retroactive; only steps that were ever open are scored.
    const everOpen = new Set<string>()
    for (const item of initial) {
      wording.set(key(item.content), item.content)
      if (item.status === 'completed') modelAt.set(key(item.content), -1)
      else everOpen.add(key(item.content))
    }

    for (let index = startAt; index < tools.length; index += 1) {
      const tool = tools[index]!
      // Recordings redact tool-input paths; the live ToolEvent has them. A write's
      // result still says where it landed ("… at D:\…").
      const input: Record<string, unknown> = { ...tool.input }
      if (typeof input.path === 'string' && input.path.includes('[REDACTED]')) {
        const landed = / at ([A-Za-z]:[\\/][^\s`]+)/.exec(String(tool.result ?? ''))
        if (landed) input.path = landed[1]
        else delete input.path
      }
      if (typeof input.cwd === 'string' && input.cwd.includes('[REDACTED]')) delete input.cwd
      if (isPlanWrite(tool)) {
        const written = tool.input!.items as TodoItem[]
        todo.write(written)
        for (const item of written) {
          const k = key(item.content)
          if (!wording.has(k)) wording.set(k, item.content)
          if (item.status !== 'completed') everOpen.add(k)
          if (item.status === 'completed' && !modelAt.has(k)) modelAt.set(k, index)
        }
      }
      const result = tracker.observe([{ name: tool.name, input, result: String(tool.result ?? ''), isError: tool.status === 'error' }])
      if (result.update) {
        totals.notes += 1
        for (const content of result.update.ticked) if (!eliaAt.has(key(content))) eliaAt.set(key(content), index)
      }
      if (result.nudge) totals.nudges += 1
      if (flag('-v') && (result.note || result.nudge)) console.log(`  [${file} t${turn} #${index}] ${result.note ?? result.nudge}`)
    }

    for (const [k, content] of wording) {
      if (!everOpen.has(k)) continue
      totals.steps += 1
      if (stepAnchors(content).length > 0) totals.anchored += 1
      const elia = eliaAt.get(k)
      const model = modelAt.get(k)
      if (model !== undefined) totals.modelDone += 1
      if (elia !== undefined) totals.eliaTicked += 1
      if (elia !== undefined && model !== undefined) {
        totals.both += 1
        if (elia <= model) leadSum += model - elia
        else totals.eliaLater += 1
        if (model - elia >= 8) bigLeads.push(`${model - elia} calls early: "${content.slice(0, 100)}" ticked by ${tools[elia]?.name}`)
      } else if (elia !== undefined) {
        totals.eliaOnly += 1
        const tool = tools[elia]
        eliaOnly.push(`${file} t${turn}: "${content.slice(0, 110)}" ${anchorsOf(content)} ← ${tool?.name} ${JSON.stringify(tool?.input ?? {}).slice(0, 100)}`)
      } else if (model !== undefined) {
        totals.modelOnly += 1
        modelOnly.push(`"${content.slice(0, 110)}" ${anchorsOf(content)}`)
      }
    }
  }
}

const matched = totals.both - totals.eliaLater
console.log({ ...totals, avgLeadCalls: matched > 0 ? +(leadSum / matched).toFixed(1) : 0 })
console.log('\n--- elia ticked, the model never marked done (each must be real work):')
for (const line of eliaOnly) console.log(line)
if (flag('-m')) {
  console.log('\n--- the model marked done, elia never ticked:')
  for (const line of modelOnly) console.log(line)
}
if (flag('-l')) {
  console.log('\n--- ticks well ahead of the model:')
  for (const line of bigLeads) console.log(line)
}
