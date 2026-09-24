import { withAgentIdentity } from '../autonomy/context.ts'
import { flagValue, hasFlag, positionals } from '../cli/argv.ts'
import { writeError, writeNotice, writeUsageLine } from '../ui/stream.ts'
import { FEED_NAMES, fetchFeed, normalizeFeedRequest } from './feeds.ts'
import { runMonitorPass } from './monitor.ts'
import { PLAYBOOKS, describeRequest, seedPlaybook } from './playbooks.ts'
import { executeBattmannStoreAction, listFeedSubscriptions, recordFeedResult, voidRuleQuestion } from './store.ts'

/**
 * `elia battmann …` — the operator's side of Battmann, run by a person rather than a model. Nothing here passes
 * through a model, so the classification boundary does not apply: the dashboard written here shows every record.
 */

type Row = Record<string, unknown>
const VALUE_FLAGS = ['--store', '--out', '--every', '--base', '--start', '--end', '--from', '--partner', '--flow', '--periods', '--days', '--by', '--years']
const DEFAULT_DASHBOARD = '.elia/artifacts/battmann-dashboard.html'

const USAGE = `Usage: elia battmann <command>

  seed <playbook>               Subscribe a playbook's feeds and open its certified questions (no model)
  brief <playbook>              Seed if needed, then run the Battmann agent to write the brief
  pull <feed> <args…>           Fetch a feed by code, record it with provenance, and subscribe to it
      fx <QUOTE…> [--base USD] [--start YYYY-MM-DD]
      worldbank <COUNTRY> <INDICATOR> [--from YEAR]
      imf <COUNTRY> <INDICATOR>
      comtrade <REPORTER> <HS> [--partner ALL|WLD|ISO3] [--flow import|export] [--periods 2024,2025]
      gdelt "<query>" [--days 30]
      commodity <CODE…> [--start YYYY-MM] [--index]       IMF codes: POILAPSP, PCOPP, PTIN, PALUM, PNGASJP…
      tariff <REPORTER> <HS6…> [--partner WLD] [--years 2022,2023]
  refresh                       One monitoring pass: refresh feeds, resolve due questions, update baselines, rebuild the dashboard
  watch --every 6h              Repeat refresh on an interval while this process runs
  record                        The certified track record: resolved-by-code questions, Battmann vs the baseline
  feeds                         Feed subscriptions and their last run
  dashboard [--out path]        Write the dashboard (HTML, JSON, Markdown)
  void <questionId> "<reason>"  Void a certified question (a person only; the model cannot)

  Playbooks: ${Object.keys(PLAYBOOKS).join(', ')}
  --store <path>                Store file (default .elia/battmann.sqlite)`

function storeInput(): Row {
  const store = flagValue('--store')
  return store ? { storePath: store } : {}
}

function asOperator<T>(fn: () => Promise<T>): Promise<T> {
  return withAgentIdentity({ name: process.env.USER || 'operator', role: 'lead', cwd: process.cwd() }, fn)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function runBattmann(): Promise<void> {
  const args = positionals(VALUE_FLAGS)
  const command = args[0]
  if (!command || command === 'help') {
    writeUsageLine(USAGE)
    return
  }
  try {
    await asOperator(() => dispatch(command, args.slice(1)))
  } catch (error) {
    writeError(errorText(error))
    process.exitCode = 1
  }
}

async function dispatch(command: string, rest: string[]): Promise<void> {
  const input = storeInput()
  if (command === 'seed' || command === 'brief') {
    const playbook = PLAYBOOKS[rest[0] ?? '']
    if (!playbook) throw new Error(`Unknown playbook "${rest[0] ?? ''}". Available: ${Object.keys(PLAYBOOKS).join(', ')}`)
    const seededQuestions = (JSON.parse(executeBattmannStoreAction({ ...input, action: 'list_questions' })) as { questions: { tags: string[] }[] }).questions.filter((question) => question.tags.includes(playbook.id)).length
    if (command === 'seed' || seededQuestions === 0) {
      writeNotice(`Seeding "${playbook.title}" — every figure below is fetched by code from its source.`)
      const result = await seedPlaybook(playbook, input, (line) => writeUsageLine(line))
      const questions = result.questions as Row[]
      const failedFeeds = (result.feeds as Row[]).filter((feed) => !feed.ok)
      writeNotice(`${(result.feeds as Row[]).length - failedFeeds.length}/${(result.feeds as Row[]).length} feeds recorded; ${questions.filter((question) => question.status === 'opened').length} certified question(s) opened, ${questions.filter((question) => question.status === 'already open').length} already open.`)
      for (const feed of failedFeeds) writeUsageLine(`  unreachable now: ${feed.feed} — ${String(feed.error)}`)
      await writeDashboard(input)
    }
    if (command === 'brief') await runBrief(playbook.brief)
    return
  }
  if (command === 'pull') {
    const request = normalizeFeedRequest(pullRequest(rest))
    writeNotice(`Pulling ${describeRequest(request)}…`)
    const result = await fetchFeed(request)
    const recorded = recordFeedResult(input, result, { subscribe: true }) as { evidenceId: string; series: { indicatorId: string; newReadings: number; upstreamRevisionCount: number; latest: { period: string; value: number } | null }[] }
    writeUsageLine(`${result.publisher} — ${result.title}`)
    writeUsageLine(`source ${result.sourceUrls[0]}  ·  sha256 ${result.responseSha256.slice(0, 16)}…  ·  evidence ${recorded.evidenceId}`)
    for (const series of recorded.series) writeUsageLine(`  ${series.indicatorId}: ${series.newReadings} new${series.upstreamRevisionCount ? `, ${series.upstreamRevisionCount} revised upstream (kept as recorded)` : ''}${series.latest ? `; latest ${series.latest.period} = ${series.latest.value}` : ''}`)
    for (const note of result.notes) writeUsageLine(`  note: ${note}`)
    return
  }
  if (command === 'refresh') {
    await refreshOnce(input)
    return
  }
  if (command === 'watch') {
    const every = flagValue('--every') ?? '6h'
    const { parseScheduleInterval } = await import('../autonomy/scheduler.ts')
    const intervalMs = parseScheduleInterval(every)
    writeNotice(`Watching: a monitoring pass every ${every} for as long as this process runs (Ctrl+C to stop). This is not hosted monitoring; for unattended runs, schedule \`elia battmann refresh\` with cron or launchd.`)
    for (;;) {
      try {
        await refreshOnce(input)
      } catch (error) {
        writeError(`pass failed: ${errorText(error)}`)
      }
      writeUsageLine(`next pass at ${new Date(Date.now() + intervalMs).toISOString()}`)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  if (command === 'record') {
    const score = JSON.parse(executeBattmannStoreAction({ ...input, action: 'scorecard' })) as { sampleSize: number; brierScore: number | null; certified: Row }
    const certified = score.certified as { openRuleQuestions: number; system: Row; baseline: Row; matchedQuestions: number; skillVsBaseline: number | null; skillNote?: string; definition: string }
    writeUsageLine(`Certified track record — ${certified.definition}`)
    writeUsageLine(`  open certified questions: ${certified.openRuleQuestions}`)
    writeUsageLine(`  resolved: ${String(certified.system.sampleSize ?? 0)}  ·  Battmann Brier ${String(certified.system.brierScore ?? '—')}  ·  baseline Brier ${String(certified.baseline.brierScore ?? '—')}`)
    writeUsageLine(`  skill vs baseline on ${certified.matchedQuestions} matched question(s): ${certified.skillVsBaseline ?? '—'} (above 0 means Battmann beat the baseline)`)
    if (certified.skillNote) writeUsageLine(`  ${certified.skillNote}`)
    writeUsageLine(`All resolved questions (including ones resolved by a person or agent): ${score.sampleSize}, Brier ${score.brierScore ?? '—'}`)
    return
  }
  if (command === 'feeds') {
    const { subscriptions } = listFeedSubscriptions(input) as { subscriptions: { id: string; feed: string; request: Row; lastRunAt: string | null; lastStatus: string | null; lastDetail: string | null }[] }
    if (!subscriptions.length) {
      writeNotice('No feed subscriptions yet. Try: elia battmann seed india-semiconductors, or elia battmann pull fx INR')
      return
    }
    for (const subscription of subscriptions) writeUsageLine(`${subscription.id}  ${subscription.feed.padEnd(9)}  ${(subscription.lastStatus ?? 'never run').padEnd(6)}  ${subscription.lastRunAt ?? '—'}  ${describeRequest(normalizeFeedRequest(subscription.request))}${subscription.lastStatus === 'error' ? `  — ${subscription.lastDetail ?? ''}` : ''}`)
    return
  }
  if (command === 'dashboard') {
    await writeDashboard(input, flagValue('--out') ?? DEFAULT_DASHBOARD)
    return
  }
  if (command === 'void') {
    const [questionId, ...reason] = rest
    if (!questionId || !reason.length) throw new Error('Usage: elia battmann void <questionId> "<reason>"')
    const result = voidRuleQuestion(input, questionId, reason.join(' '), flagValue('--by') ?? process.env.USER ?? 'operator')
    writeNotice(`Voided ${questionId}; it no longer counts toward any track record (resolution ${String(result.resolutionId)}).`)
    return
  }
  throw new Error(`Unknown battmann command "${command}".\n${USAGE}`)
}

function pullRequest(rest: string[]): Row {
  const [feed, ...values] = rest
  if (!feed || !(FEED_NAMES as readonly string[]).includes(feed)) throw new Error(`pull needs a feed: ${FEED_NAMES.join(', ')}`)
  if (feed === 'fx') return { feed, base: flagValue('--base') ?? 'USD', quotes: values, ...(flagValue('--start') ? { start: flagValue('--start') } : {}) }
  if (feed === 'worldbank') return { feed, country: values[0], indicator: values[1], ...(flagValue('--from') ? { startYear: Number(flagValue('--from')) } : {}) }
  if (feed === 'imf') return { feed, country: values[0], indicator: values[1] }
  if (feed === 'comtrade') return { feed, reporter: values[0], hs: values[1], partner: flagValue('--partner') ?? 'ALL', flow: flagValue('--flow') ?? 'import', ...(flagValue('--periods') ? { periods: flagValue('--periods')!.split(','), frequency: flagValue('--periods')!.split(',')[0]!.length === 6 ? 'monthly' : 'annual' } : {}) }
  if (feed === 'commodity') return { feed, commodities: values, unit: hasFlag('--index') ? 'IX' : 'USD', ...(flagValue('--start') ? { start: flagValue('--start') } : {}) }
  if (feed === 'tariff') return { feed, reporter: values[0], products: values.slice(1), partner: flagValue('--partner') ?? 'WLD', ...(flagValue('--years') ? { years: flagValue('--years')!.split(',').map(Number) } : {}) }
  const days = Number(flagValue('--days') ?? 30)
  return { feed, query: values.join(' '), start: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) }
}

async function refreshOnce(input: Row): Promise<void> {
  writeNotice('Monitoring pass: feeds → resolutions → baselines (no model involved)…')
  const pass = await runMonitorPass(input) as { feeds: { refreshed: Row[]; failed: Row[] }; resolutions: { resolved: Row[]; pending: Row[]; errors: Row[] }; baselines: Row[] }
  for (const feed of pass.feeds.refreshed) writeUsageLine(`  feed ${String(feed.feed)}: ${String(feed.title)} — ${String(feed.newReadings)} new${Number(feed.upstreamRevisions) ? `, ${String(feed.upstreamRevisions)} revised upstream` : ''}`)
  for (const feed of pass.feeds.failed) writeUsageLine(`  feed ${String(feed.feed)} failed: ${String(feed.error)}`)
  for (const item of pass.resolutions.resolved) writeUsageLine(`  RESOLVED ${String(item.questionId)}: ${item.outcome ? 'YES' : 'NO'} (${String(item.detail)}; observed ${String(item.observedValue)})`)
  for (const item of pass.resolutions.errors) writeUsageLine(`  could not check ${String(item.questionId)}: ${String(item.error)}`)
  const updatedBaselines = pass.baselines.filter((item) => item.recorded).length
  writeUsageLine(`  ${pass.resolutions.resolved.length} resolved, ${pass.resolutions.pending.length} still pending, ${updatedBaselines} baseline(s) updated`)
  await writeDashboard(input)
}

async function writeDashboard(input: Row, outputPath = DEFAULT_DASHBOARD): Promise<void> {
  const { createDashboard } = await import('../tools/battmann.ts')
  const result = JSON.parse(await createDashboard({ ...input, outputPath })) as { dashboardPath: string; alerts: number; openQuestions: number; indicators: number }
  writeNotice(`Dashboard: ${result.dashboardPath} (${result.openQuestions} open question(s), ${result.indicators} indicator(s), ${result.alerts} alert(s))`)
}

async function runBrief(prompt: string): Promise<void> {
  writeNotice('Starting the Battmann agent to write the brief. It uses the configured model; file writes and anything outward-facing still ask for approval.')
  const entry = process.argv[1]
  if (!entry) throw new Error('cannot locate the elia entry point to start the agent')
  const child = Bun.spawn([process.execPath, entry, '--battmann', ...(hasFlag('--yolo', '-y') ? ['--yolo'] : []), prompt], { stdio: ['inherit', 'inherit', 'inherit'], env: process.env })
  const code = await child.exited
  if (code !== 0) process.exitCode = code
}
