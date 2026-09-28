import { markdownSections } from './artifacts.ts'
import { currentStage, evaluateStage, latestArtifact, type GateContext } from './gates.ts'
import { ORG_ROLES, TEAMS } from './org.ts'
import { renderBoardLine } from './render.ts'
import type { Initiative, SysintelStore } from './store.ts'

/**
 * The organization's rhythms, computed from the record rather than recollected: the board,
 * the Friday review (shipped, learned, failed, next), the quarterly metrics, the flywheel
 * lineage, the TPM's dependency view, the risk register, the knowledge index, and a digest
 * for keeping people informed. Every number here is counted from recorded events.
 */

export const REPORT_VIEWS = ['board', 'priorities', 'week', 'quarter', 'flywheel', 'dependencies', 'risks', 'knowledge', 'digest'] as const
export type ReportView = (typeof REPORT_VIEWS)[number]

const DAY = 24 * 60 * 60 * 1000

function within(at: string | undefined, days: number, now: number): boolean {
  return at !== undefined && now - Date.parse(at) <= days * DAY
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function days(ms: number): string {
  return ms < DAY ? `${(ms / 3_600_000).toFixed(1)}h` : `${(ms / DAY).toFixed(1)}d`
}

/** Supported / refuted / inconclusive, read from the latest experiment-results conclusion. */
export function researchVerdict(initiative: Initiative, store: SysintelStore): 'supported' | 'refuted' | 'inconclusive' | undefined {
  const results = latestArtifact(initiative, 'experiment-results')
  if (!results?.valid) return undefined
  const conclusion = markdownSections(store.readArtifactFile(results) ?? '').get('conclusion') ?? ''
  if (/\b(refuted|rejected)\b/i.test(conclusion)) return 'refuted'
  if (/\binconclusive\b/i.test(conclusion)) return 'inconclusive'
  if (/\b(supported|confirmed)\b/i.test(conclusion)) return 'supported'
  return undefined
}

function board(all: Initiative[], context: GateContext): string {
  if (!all.length) return 'No initiatives yet. Start one with si_work intake.'
  const groups: [string, Initiative[]][] = [
    ['Active', all.filter((i) => i.status === 'active')],
    ['Blocked', all.filter((i) => i.status === 'blocked')],
    ['Done', all.filter((i) => i.status === 'done').slice(-10)],
    ['Abandoned', all.filter((i) => i.status === 'abandoned').slice(-5)],
  ]
  return groups.filter(([, list]) => list.length).map(([label, list]) => `${label}:\n${list.map((i) => `  ${renderBoardLine(i, context)}`).join('\n')}`).join('\n\n')
}

const SCALE_WEIGHT = { strategic: 5, large: 4, medium: 3, small: 2, trivial: 1 } as const

/** Monday: what matters this week — the open work in the order it should get attention. */
function priorities(all: Initiative[], context: GateContext): string {
  const open = all.filter((i) => i.status === 'active' || i.status === 'blocked')
  if (!open.length) return 'Nothing open. Start with si_work intake.'
  const byId = new Map(all.map((i) => [i.id, i]))
  const score = (i: Initiative): number => {
    const incident = i.lifecycle === 'incident' || i.lifecycle === 'vulnerability' ? 100 : 0
    const p0 = i.items.filter((item) => item.priority === 'P0' && item.status !== 'done' && item.status !== 'dropped').length * 10
    const unblocks = all.filter((other) => other.dependsOn.includes(i.id) && other.status !== 'done').length * 5
    return incident + p0 + unblocks + SCALE_WEIGHT[i.scale] - (i.status === 'blocked' ? 50 : 0)
  }
  const lines = ['This week, in order (incidents and vulnerabilities first, then P0 work, then what unblocks others):']
  for (const [index, initiative] of [...open].sort((a, b) => score(b) - score(a)).entries()) {
    const stage = currentStage(initiative)
    const gates = stage ? evaluateStage(initiative, stage, context).filter((s) => !s.met) : []
    const team = initiative.team ? TEAMS.find((t) => t.id === initiative.team)?.name : undefined
    const waiting = initiative.dependsOn.filter((id) => byId.get(id)?.status !== 'done')
    lines.push(`  ${index + 1}. ${initiative.id} ${initiative.title} — ${initiative.lifecycle}/${initiative.scale}${team ? `, ${team}` : ''}`)
    lines.push(`     ${initiative.status === 'blocked' ? `BLOCKED: ${initiative.blockedReason}` : `${stage?.id ?? '—'} (${stage ? ORG_ROLES[stage.owner].title : ''}): ${gates.length ? gates.map((s) => s.hint ?? s.detail).slice(0, 2).join(' / ') : 'ready to advance'}`}`.slice(0, 260))
    const urgent = initiative.items.filter((item) => (item.priority === 'P0' || item.priority === 'P1') && item.status !== 'done' && item.status !== 'dropped')
    if (urgent.length) lines.push(`     open ${urgent.map((item) => `${item.priority} ${item.id} ${item.title}`).join('; ')}`.slice(0, 260))
    if (waiting.length) lines.push(`     waiting on ${waiting.join(', ')}`)
  }
  const signoffs = open.flatMap((i) => {
    const stage = currentStage(i)
    return stage ? evaluateStage(i, stage, context).filter((s) => !s.met && s.requirement.type === 'signoff').map((s) => `${i.id} ${s.requirement.gate}`) : []
  })
  if (signoffs.length) lines.push('', `Waiting on your sign-off: ${signoffs.join(', ')}`)
  return lines.join('\n')
}

function week(all: Initiative[], store: SysintelStore, context: GateContext, span: number, now: number): string {
  const shipped = all.filter((i) => (i.status === 'done' && within(i.completedAt, span, now)) || i.evidence.some((e) => e.kind === 'signoff' && (e.gate === 'release' || e.gate === 'production') && within(e.at, span, now)))
  const learned: string[] = []
  const failed: string[] = []
  for (const initiative of all) {
    const verdict = initiative.lifecycle === 'research' ? researchVerdict(initiative, store) : undefined
    const results = latestArtifact(initiative, 'experiment-results')
    if (verdict && within(results?.at, span, now)) (verdict === 'refuted' ? failed : learned).push(`${initiative.id} hypothesis ${verdict} — ${initiative.title}`)
    const postmortem = latestArtifact(initiative, 'postmortem')
    if (postmortem?.valid && within(postmortem.at, span, now)) learned.push(`${initiative.id} postmortem — ${initiative.title}`)
    for (const decision of initiative.decisions.filter((d) => within(d.at, span, now))) learned.push(`${initiative.id} decided: ${decision.title} — ${decision.decision}`.slice(0, 200))
    for (const review of initiative.reviews.filter((r) => r.independent && r.verdict !== 'approve' && within(r.at, span, now))) failed.push(`${initiative.id} ${review.kind} ${review.verdict}: ${review.findings[0] ?? review.summary}`.slice(0, 200))
    const failedChecks = initiative.evidence.filter((e) => e.kind === 'check' && !e.passed && within(e.at, span, now)).length
    if (failedChecks) failed.push(`${initiative.id} ${failedChecks} failing check run(s)`)
    if (initiative.status === 'abandoned' && within(initiative.updatedAt, span, now)) failed.push(`${initiative.id} abandoned — ${initiative.outcome ?? ''}`)
  }
  const next = all.filter((i) => i.status === 'active' || i.status === 'blocked').map((i) => {
    const stage = currentStage(i)
    const open = stage ? evaluateStage(i, stage, context).filter((s) => !s.met) : []
    return `${i.id} ${stage?.id ?? '—'} (${stage ? ORG_ROLES[stage.owner].title : ''}): ${i.status === 'blocked' ? `BLOCKED — ${i.blockedReason}` : open.length ? open.map((s) => s.hint ?? s.detail).slice(0, 2).join(' / ') : 'ready to advance'}`.slice(0, 240)
  })
  const section = (title: string, items: string[]): string => `${title}:\n${items.length ? items.map((item) => `  - ${item}`).join('\n') : '  (none)'}`
  return [`Review of the last ${span} day(s)`, section('Shipped', shipped.map((i) => `${i.id} ${i.title}`)), section('Learned', learned), section('Failed', failed), section('Next', next)].join('\n\n')
}

function quarter(all: Initiative[], store: SysintelStore, span: number, now: number): string {
  const opened = all.filter((i) => within(i.createdAt, span, now))
  const closed = all.filter((i) => i.status === 'done' && within(i.completedAt, span, now))
  const lead = median(closed.map((i) => Date.parse(i.completedAt!) - Date.parse(i.createdAt)))
  const deployments = all.flatMap((i) => i.evidence.filter((e) => e.kind === 'signoff' && e.gate === 'production' && within(e.at, span, now)))
  const releases = all.flatMap((i) => i.evidence.filter((e) => e.kind === 'signoff' && e.gate === 'release' && within(e.at, span, now)))
  const incidents = all.filter((i) => i.lifecycle === 'incident' && within(i.createdAt, span, now))
  const recoveries = incidents.map((i) => i.stages.find((s) => s.id === 'recovery')?.completedAt).map((at, index) => (at ? Date.parse(at) - Date.parse(incidents[index]!.createdAt) : undefined)).filter((ms): ms is number => ms !== undefined)
  const reviews = all.flatMap((i) => i.reviews.filter((r) => r.independent && within(r.at, span, now)))
  const checks = all.flatMap((i) => i.evidence.filter((e) => e.kind === 'check' && within(e.at, span, now)))
  const research = all.filter((i) => i.lifecycle === 'research').map((i) => researchVerdict(i, store)).filter(Boolean)
  const escaped = incidents.filter((i) => i.parent !== undefined).length
  const weeks = Math.max(1, span / 7)
  const okrs = all.filter((i) => latestArtifact(i, 'okrs')?.valid)
  const lines = [
    `Metrics for the last ${span} day(s) — counted from the record`,
    `  initiatives opened ${opened.length}, finished ${closed.length}${lead !== undefined ? `, median lead time ${days(lead)}` : ''}`,
    `  releases ${releases.length}, production deployments ${deployments.length} (${(deployments.length / weeks).toFixed(2)} per week)`,
    `  incidents ${incidents.length}${recoveries.length ? `, median time to recover ${days(median(recoveries)!)}` : ''}${incidents.length ? `, ${escaped} traced to an earlier initiative` : ''}`,
    `  independent reviews ${reviews.length}${reviews.length ? `, ${Math.round((100 * reviews.filter((r) => r.verdict !== 'approve').length) / reviews.length)}% sent back` : ''}`,
    `  checks run ${checks.length}${checks.length ? `, ${Math.round((100 * checks.filter((c) => c.passed).length) / checks.length)}% passing` : ''}`,
    `  hypotheses resolved ${research.length}: ${research.filter((v) => v === 'supported').length} supported, ${research.filter((v) => v === 'refuted').length} refuted, ${research.filter((v) => v === 'inconclusive').length} inconclusive`,
  ]
  if (okrs.length) lines.push('', 'Objectives on record:', ...okrs.map((i) => `  ${i.id} ${i.title} — ${i.children.length} linked project(s), ${i.children.filter((id) => store.exists(id) && store.read(id).status === 'done').length} done`))
  return lines.join('\n')
}

function flywheel(all: Initiative[]): string {
  const byId = new Map(all.map((i) => [i.id, i]))
  const roots = all.filter((i) => !i.parent || !byId.has(i.parent)).filter((i) => i.children.length)
  if (!roots.length) return 'No linked initiatives yet. Production problems, postmortem action items, and validated research become linked follow-ups (si_work intake parent:…, si_work handoff).'
  const lines: string[] = ['Research discovers → engineering builds → production generates evidence → evaluation measures → research learns → engineering improves.', '']
  const walk = (initiative: Initiative, depth: number, seen: Set<string>): void => {
    if (seen.has(initiative.id)) return
    seen.add(initiative.id)
    lines.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${initiative.id} [${initiative.origin} → ${initiative.lifecycle}, ${initiative.status}]${initiative.relation ? ` (${initiative.relation})` : ''} ${initiative.title}`)
    for (const child of initiative.children) {
      const next = byId.get(child)
      if (next) walk(next, depth + 1, seen)
    }
  }
  for (const root of roots) walk(root, 0, new Set())
  return lines.join('\n')
}

function dependencies(all: Initiative[]): string {
  const byId = new Map(all.map((i) => [i.id, i]))
  const lines: string[] = []
  for (const initiative of all.filter((i) => i.dependsOn.length && i.status !== 'done' && i.status !== 'abandoned')) {
    const waiting = initiative.dependsOn.filter((id) => byId.get(id)?.status !== 'done')
    lines.push(`${initiative.id} ${initiative.title}: depends on ${initiative.dependsOn.map((id) => `${id} [${byId.get(id)?.status ?? 'missing'}]`).join(', ')}${waiting.length ? ` — waiting on ${waiting.join(', ')}` : ' — clear'}`)
  }
  for (const initiative of all.filter((i) => i.status === 'active' || i.status === 'blocked')) {
    const items = new Map(initiative.items.map((item) => [item.id, item]))
    const blockedItems = initiative.items.filter((item) => item.status === 'todo' && item.dependsOn.some((id) => !['done', 'dropped'].includes(items.get(id)?.status ?? '')))
    if (blockedItems.length) lines.push(`${initiative.id} items waiting: ${blockedItems.map((item) => `${item.id} after ${item.dependsOn.join('+')}`).join('; ')}`)
  }
  return lines.length ? lines.join('\n') : 'No open cross-initiative or work-item dependencies.'
}

function risks(all: Initiative[]): string {
  const weight = { low: 1, medium: 2, high: 3 } as const
  const open = all.flatMap((i) => i.risks.filter((risk) => risk.status === 'open').map((risk) => ({ initiative: i, risk })))
    .sort((a, b) => weight[b.risk.likelihood] * weight[b.risk.impact] - weight[a.risk.likelihood] * weight[a.risk.impact])
  if (!open.length) return 'No open risks on record.'
  return ['Open risks (likelihood × impact):', ...open.map(({ initiative, risk }) => `  ${initiative.id}/${risk.id} [${risk.likelihood}/${risk.impact}] ${risk.title} — owner ${ORG_ROLES[risk.owner].title}; mitigation: ${risk.mitigation}`.slice(0, 260))].join('\n')
}

function knowledge(all: Initiative[], store: SysintelStore): string {
  const rows: string[] = []
  for (const initiative of all) {
    const kinds = [...new Set(initiative.artifacts.map((artifact) => artifact.kind))]
    for (const kind of kinds) {
      const latest = latestArtifact(initiative, kind)!
      const intact = store.artifactIntact(latest)
      rows.push(`${latest.id.padEnd(28)} ${latest.valid ? 'valid  ' : 'INVALID'} ${intact === 'ok' ? '' : `(${intact}) `}${latest.title} — ${latest.path}${latest.exportedTo?.length ? ` → ${latest.exportedTo.join(', ')}` : ''}`)
    }
  }
  return rows.length ? ['The organization\'s written memory:', ...rows.map((row) => `  ${row}`)].join('\n') : 'No artifacts yet. Write one with si_artifact template → si_artifact write.'
}

function digest(all: Initiative[], store: SysintelStore, context: GateContext, now: number): string {
  const recent = store.journal(500).filter((entry) => within(entry.at, 1, now))
  const active = all.filter((i) => i.status === 'active' || i.status === 'blocked')
  const needsPerson = active.flatMap((i) => {
    const stage = currentStage(i)
    if (!stage) return []
    return evaluateStage(i, stage, context).filter((s) => !s.met && s.requirement.type === 'signoff').map((s) => `${i.id} ${s.requirement.gate} sign-off — ${i.title}`)
  })
  const section = (title: string, items: string[]): string => `${title}:\n${items.length ? items.map((item) => `  - ${item}`).join('\n') : '  (none)'}`
  return [
    section('Since yesterday', recent.map((entry) => `${entry.initiative} ${entry.event}${entry.detail ? ` — ${entry.detail}` : ''}`.slice(0, 200)).slice(-15)),
    section('In progress', active.filter((i) => i.status === 'active').map((i) => `${i.id} ${currentStage(i)?.id ?? ''} — ${i.title}`)),
    section('Blocked', active.filter((i) => i.status === 'blocked').map((i) => `${i.id} ${i.blockedReason ?? ''} — ${i.title}`)),
    section('Decisions needed from you', needsPerson),
  ].join('\n\n')
}

export function report(view: ReportView, store: SysintelStore, context: GateContext, span?: number, now = Date.now()): string {
  const all = store.list()
  switch (view) {
    case 'board': return board(all, context)
    case 'priorities': return priorities(all, context)
    case 'week': return week(all, store, context, span ?? 7, now)
    case 'quarter': return quarter(all, store, span ?? 90, now)
    case 'flywheel': return flywheel(all)
    case 'dependencies': return dependencies(all)
    case 'risks': return risks(all)
    case 'knowledge': return knowledge(all, store)
    case 'digest': return digest(all, store, context, now)
  }
}
