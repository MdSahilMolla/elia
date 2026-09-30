/**
 * `elia autopilot` — no goal given. elia works out what the repository is,
 * where it stands and what to do next, then does it, unattended.
 *
 *   elia autopilot                     survey, understand, and work up to 5 goals
 *   elia autopilot --plan-only         survey, measure, understand and plan; change nothing
 *   elia autopilot --resume            continue the last pilot in this repository
 *   elia autopilot status | report     where the last pilot stands / its full report
 *   elia autopilot watch add "<what>"  react to events: github ci|issues|prs, file <path>, url <https>, every <1h>
 *   elia autopilot --watch             keep going: each event is a goal; idle waits instead of stopping
 *   elia autopilot --scopes a,b        limit what goal runs may do (see autopilot/scopes.ts)
 *   elia autopilot install|uninstall|service   run --watch in the background, from log-in on
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeError, writeNotice } from '../ui/stream.ts'
import { registerShutdownCleanup } from '../ui/shutdown.ts'
import { flagValue, hasFlag, positionals, strictInteger } from './argv.ts'
import { ensureFirstRunProviderSetup } from './providerSetup.ts'
import { loadRuntimeSkills } from './runtime.ts'

function positiveNumber(flag: string, raw: string | undefined, integer: boolean): number | undefined | null {
  if (raw === undefined) return undefined
  const value = integer ? strictInteger(raw) : Number(raw)
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    writeError(`${flag} must be a positive ${integer ? 'integer' : 'number'}, got "${raw}"`)
    process.exitCode = 1
    return null
  }
  return value
}

export async function runAutopilotCommand(): Promise<void> {
  const root = process.cwd()
  const [sub, ...subArgs] = positionals(['--max-goals', '--goal-minutes', '--hours', '--profile', '--scopes', '--env-file'])
  const { loadPilotState, reportPath } = await import('../autopilot/store.ts')

  if (sub === 'watch') return runWatchCommand(root, subArgs)
  if (sub === 'install' || sub === 'uninstall' || sub === 'service') {
    const { installPilotService, pilotLogTail, pilotServiceInstalled, pilotServicePlan, uninstallPilotService } = await import('../autopilot/service.ts')
    const envFileRaw = flagValue('--env-file')
    const envFile = envFileRaw ? (await import('node:path')).resolve(envFileRaw) : undefined
    if (envFile && !existsSync(envFile)) {
      writeError(`--env-file: ${envFile} does not exist`)
      process.exitCode = 1
      return
    }
    const plan = pilotServicePlan({ workspace: root, runtime: process.execPath, entry: process.argv[1] ?? '', envFile })
    try {
      if (sub === 'install') {
        const { loadWatchers } = await import('../autopilot/watch.ts')
        if (loadWatchers(root).length === 0) {
          writeError('Nothing to watch yet, so a background autopilot would have nothing to react to. Add a watcher first: elia autopilot watch add "github ci"')
          process.exitCode = 1
          return
        }
        writeNotice(await installPilotService(plan))
      } else if (sub === 'uninstall') writeNotice(await uninstallPilotService(plan))
      else {
        writeNotice(`${plan.label}: ${pilotServiceInstalled(plan) ? 'installed' : 'not installed'}`)
        const tail = pilotLogTail(plan)
        if (tail.length > 0) writeNotice(`log (${plan.logPath}):\n${tail.join('\n')}`)
      }
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
    return
  }

  if (sub === 'status' || sub === 'report') {
    const state = loadPilotState(root)
    if (!state) {
      writeNotice('No autopilot has run in this repository yet. Start one with: elia autopilot')
      return
    }
    if (sub === 'status') {
      const { statusText } = await import('../autopilot/report.ts')
      console.log(statusText(state))
      console.log(`report: ${reportPath(root)}`)
      return
    }
    const path = reportPath(root)
    if (existsSync(path)) console.log(readFileSync(path, 'utf8'))
    else {
      const { renderReport } = await import('../autopilot/report.ts')
      console.log(renderReport(state))
    }
    return
  }
  if (sub !== undefined) {
    writeError(`Unknown autopilot subcommand "${sub}". Use: elia autopilot [--plan-only|--resume|--watch] | status | report | watch | install | uninstall | service`)
    process.exitCode = 1
    return
  }

  const maxGoals = positiveNumber('--max-goals', flagValue('--max-goals'), true)
  const goalMinutes = positiveNumber('--goal-minutes', flagValue('--goal-minutes'), false)
  const maxHours = positiveNumber('--hours', flagValue('--hours'), false)
  if (maxGoals === null || goalMinutes === null || maxHours === null) return
  const profileRaw = flagValue('--profile')
  if (profileRaw !== undefined && !['fast', 'balanced', 'thorough'].includes(profileRaw)) {
    writeError('--profile must be fast, balanced or thorough')
    process.exitCode = 1
    return
  }

  const watch = hasFlag('--watch')
  let scopes: import('../autonomy/capabilityContract.ts').CapabilityScope[] | undefined
  const scopesRaw = flagValue('--scopes')
  if (scopesRaw !== undefined) {
    try {
      scopes = (await import('../autopilot/scopes.ts')).parseScopes(scopesRaw)
    } catch (error) {
      writeError(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      return
    }
  }

  if (watch && (await import('../autopilot/watch.ts')).loadWatchers(root).length === 0) {
    writeError('autopilot: there is nothing to watch yet. Add a watcher first, e.g.: elia autopilot watch add "github ci"  (see: elia autopilot watch)')
    process.exitCode = 1
    return
  }

  if (!(await ensureFirstRunProviderSetup())) return
  await loadRuntimeSkills()
  const { runPilot, PilotError } = await import('../autopilot/pilot.ts')
  const controller = new AbortController()
  const unregister = registerShutdownCleanup(() => controller.abort())
  const planOnly = hasFlag('--plan-only', '--plan')
  writeNotice(planOnly
    ? 'autopilot (plan only): surveying, measuring and planning — nothing will be changed.'
    : `autopilot: unattended${watch ? ', watching' : ''}. ${watch && !maxGoals ? 'Goals as events arrive' : `Up to ${maxGoals ?? 5} goal(s)`}${maxHours ? `, ${maxHours}h at most` : ''}; each goal on elia's own branch, rolled back if it breaks a passing check. Irreversible or outside-world actions are refused and listed for you, never waited on.${scopes ? ` Limited to: ${scopes.join(', ')}.` : ''}`)
  try {
    const result = await runPilot({
      root,
      planOnly,
      // A watcher picks up where the last pilot stood (it is what the background service restarts).
      resume: hasFlag('--resume') || (watch && loadPilotState(root) !== undefined),
      watch,
      scopes,
      maxGoals: maxGoals ?? undefined,
      goalMinutes: goalMinutes ?? undefined,
      maxHours: maxHours ?? undefined,
      profile: (profileRaw as 'fast' | 'balanced' | 'thorough' | undefined) ?? 'balanced',
      signal: controller.signal,
      log: (line) => console.log(line),
    })
    const { statusText } = await import('../autopilot/report.ts')
    console.log(`\n${statusText(result.state)}`)
    console.log(`full report: ${result.reportPath}`)
    if (result.state.branch) console.log(`review: git log --oneline ${result.state.baseBranch}..${result.state.branch}`)
  } catch (error) {
    writeError(error instanceof PilotError ? `autopilot: ${error.message}` : `autopilot failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  } finally {
    unregister()
  }
}

/** What `/autopilot …` inside a session asked for. */
export type AutopilotSlashRequest = { planOnly: boolean; resume: boolean; maxGoals: number } | { status: true } | { text: string }

export function parseAutopilotSlash(args: string): AutopilotSlashRequest {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [first] = words
  if (first === 'status' || first === 'report') return { status: true }
  if (first === 'help') {
    return { text: '/autopilot [N] — work up to N goals (default 3) unattended on its own branch · /autopilot plan — survey and plan only · /autopilot resume · /autopilot status' }
  }
  const planOnly = words.includes('plan') || words.includes('--plan-only')
  const resume = words.includes('resume') || words.includes('--resume')
  const count = words.map((word) => strictInteger(word)).find((value): value is number => value !== undefined)
  const unknown = words.filter((word) => !['plan', '--plan-only', 'resume', '--resume'].includes(word) && strictInteger(word) === undefined)
  if (unknown.length > 0) return { text: `Unknown /autopilot argument(s): ${unknown.join(' ')}. Try /autopilot help.` }
  return { planOnly, resume, maxGoals: Math.max(1, Math.min(count ?? 3, 50)) }
}

export async function autopilotStatusText(root = process.cwd()): Promise<string> {
  const [{ loadPilotState, reportPath }, { statusText }] = await Promise.all([import('../autopilot/store.ts'), import('../autopilot/report.ts')])
  const state = loadPilotState(root)
  if (!state) return 'No autopilot has run in this repository yet. Start one with /autopilot (or /autopilot plan to only plan).'
  return `${statusText(state)}\nreport: ${reportPath(root)}`
}

/**
 * Runs the pilot as a turn of an interactive session. Its narration streams
 * as the turn's text; directions the live lane passes on (steering) reach the
 * pilot between goals; Esc aborts it.
 */
export async function runAutopilotTurn(
  request: { planOnly: boolean; resume: boolean; maxGoals: number },
  hooks: {
    onText?(delta: string): void
    onActivity?(activity: import('../providers/types.ts').ProviderActivity): void
    signal?: AbortSignal
    drainSteering?(): string[]
  } = {},
): Promise<void> {
  const { runPilot, PilotError } = await import('../autopilot/pilot.ts')
  const { statusText } = await import('../autopilot/report.ts')
  // In a session each narration line is an activity: one transcript line
  // apiece (markdown text would run them into a paragraph), and a phase that
  // is starting ("◆ …", "▶ …") also names the working line.
  const say = (line: string) => {
    const text = line.trim()
    if (!hooks.onActivity) {
      console.log(line)
      return
    }
    if (!text) return
    if (/^[◆▶]/.test(text)) hooks.onActivity({ kind: 'status', title: text.replace(/^[◆▶]\s*/, ''), status: 'started' })
    hooks.onActivity({ kind: 'status', title: text, status: 'completed' })
  }
  const summarize = (text: string) => (hooks.onText ? hooks.onText(`\n\`\`\`\n${text}\n\`\`\`\n`) : console.log(`\n${text}`))
  try {
    const result = await runPilot({
      root: process.cwd(),
      planOnly: request.planOnly,
      resume: request.resume,
      maxGoals: request.maxGoals,
      signal: hooks.signal,
      drainDirections: hooks.drainSteering,
      log: say,
    })
    summarize(`${statusText(result.state)}\nreport: ${result.reportPath}`)
  } catch (error) {
    if (error instanceof PilotError) summarize(`autopilot: ${error.message}`)
    else throw error
  }
}

async function runWatchCommand(root: string, args: string[]): Promise<void> {
  const { addWatcher, describeTrigger, loadWatchers, parseTrigger, removeWatcher } = await import('../autopilot/watch.ts')
  const [action = 'list', ...rest] = args
  try {
    if (action === 'list') {
      const watchers = loadWatchers(root)
      if (watchers.length === 0) {
        writeNotice('The autopilot watches nothing yet. Add a watcher, for example:\n  elia autopilot watch add "github ci"\n  elia autopilot watch add "github issues label:bug"\n  elia autopilot watch add "file docs/feedback"\n  elia autopilot watch add "every 6h"\nthen run: elia autopilot --watch (or elia autopilot install)')
        return
      }
      for (const watcher of watchers) writeNotice(`${watcher.id}  ${describeTrigger(watcher.spec)}${watcher.lastError ? `  — last check failed: ${watcher.lastError}` : ''}`)
      return
    }
    if (action === 'add') {
      const spec = parseTrigger(rest.join(' '))
      const watcher = addWatcher(root, spec)
      writeNotice(`Watching ${describeTrigger(spec)} (${watcher.id}). The first check records where things stand; only what happens after it becomes a goal. Start with: elia autopilot --watch`)
      return
    }
    if (action === 'remove' && rest[0]) {
      if (removeWatcher(root, rest[0])) writeNotice(`Stopped watching ${rest[0]}.`)
      else {
        writeError(`No watcher ${rest[0]}; see elia autopilot watch list`)
        process.exitCode = 1
      }
      return
    }
    writeError('Usage: elia autopilot watch [list] | add "<github ci|github issues [owner/repo] [label:x]|github prs|file <path>|url <https://…>|every <1h>>" | remove <id>')
    process.exitCode = 1
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
