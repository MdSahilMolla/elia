import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Keeping a Battmann workspace's monitoring loop running without anyone at the terminal: one daily
 * `elia battmann cycle <playbook>`, scheduled by the operating system's own per-user scheduler.
 *
 * - macOS: a launchd agent in ~/Library/LaunchAgents.
 * - Linux (and other Unix): a line in the user's crontab, tagged so uninstall removes exactly that line.
 * - Windows: a Task Scheduler task running a small .cmd script kept in the workspace (Task Scheduler caps a
 *   task's command at 261 characters, which a full command line with paths easily exceeds).
 *
 * Nothing here runs unless a person asks for it, and uninstall removes exactly what install created. API keys
 * are never written into the job: the cycle's model step reads the provider saved by `elia config set`
 * (~/.elia/config.env, owner-only), and without one it runs only the model-free steps.
 */

export type AutorunPlatform = 'darwin' | 'linux' | 'win32'

export interface AutorunPlan {
  platform: AutorunPlatform
  label: string
  workspace: string
  logPath: string
  runtime: string
  entry: string
  playbook: string
  hour: number
  minute: number
  /** macOS: the launchd agent file. */
  plistPath: string
  /** Windows: the script the task runs. */
  scriptPath: string
  /** The workspace is in a directory the system may clear; install refuses it. */
  temporary: boolean
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace'
}

export function currentPlatform(): AutorunPlatform {
  return process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
}

/** Directories the system clears on reboot or at will; a track record kept there can vanish. */
export function isTemporaryPath(target: string, platform: AutorunPlatform, systemTemp = tmpdir()): boolean {
  const lower = target.replaceAll('\\', '/').toLowerCase()
  const temps = [systemTemp, (() => { try { return realpathSync(systemTemp) } catch { return systemTemp } })()]
    .map((value) => value.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, ''))
  if (temps.some((prefix) => prefix && (lower === prefix || lower.startsWith(`${prefix}/`)))) return true
  if (platform === 'win32') return /\/appdata\/local\/temp(\/|$)|^[a-z]:\/windows\/temp(\/|$)/.test(lower)
  return /^\/(?:private\/)?tmp(\/|$)|^\/var\/folders\//.test(lower)
}

export function autorunPlan(options: { playbook: string; workspace?: string; at?: string; entry: string; runtime: string; platform?: AutorunPlatform; home?: string; systemTemp?: string }): AutorunPlan {
  const platform = options.platform ?? currentPlatform()
  const paths = platform === 'win32' ? path.win32 : path.posix
  const workspace = paths.resolve(options.workspace ?? process.cwd())
  const [hourText, minuteText] = (options.at ?? '22:00').split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText ?? 0)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('--at must be a local time like 22:00')
  const workspaceTail = slug(workspace.split(/[\\/]/).filter(Boolean).slice(-2).join('-'))
  const label = `ai.elia.battmann.${slug(options.playbook)}.${workspaceTail}`
  return {
    platform, label, workspace, playbook: options.playbook, runtime: options.runtime, entry: options.entry, hour, minute,
    temporary: isTemporaryPath(workspace, platform, options.systemTemp),
    logPath: paths.join(workspace, '.elia', 'battmann-autorun.log'),
    plistPath: paths.join(options.home ?? homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    scriptPath: paths.join(workspace, '.elia', 'battmann-autorun.cmd'),
  }
}

const time = (plan: AutorunPlan) => `${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')}`
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const commandArguments = (plan: AutorunPlan) => [plan.runtime, plan.entry, 'battmann', 'cycle', plan.playbook]

export function launchdPlist(plan: AutorunPlan): string {
  const searchPath = [path.posix.dirname(plan.runtime), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${commandArguments(plan).map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(plan.workspace)}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${plan.hour}</integer><key>Minute</key><integer>${plan.minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(searchPath)}</string>
    <key>ELIA_NO_UPDATE_CHECK</key><string>1</string>
    <key>NO_COLOR</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(plan.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(plan.logPath)}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`
}

/** The crontab line, tagged with the plan's label so it can be found and removed again. */
export function crontabLine(plan: AutorunPlan): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return `${plan.minute} ${plan.hour} * * * cd ${quote(plan.workspace)} && ELIA_NO_UPDATE_CHECK=1 NO_COLOR=1 ${commandArguments(plan).map(quote).join(' ')} >> ${quote(plan.logPath)} 2>&1 # elia-battmann:${plan.label}`
}

/** The Windows script the scheduled task runs. */
export function windowsScript(plan: AutorunPlan): string {
  const quote = (value: string) => `"${value.replaceAll('"', '')}"`
  return [
    '@echo off',
    `rem elia-battmann:${plan.label} — created by \`elia battmann autorun install\`; remove with \`elia battmann autorun uninstall ${plan.playbook}\`.`,
    'set ELIA_NO_UPDATE_CHECK=1',
    'set NO_COLOR=1',
    `cd /d ${quote(plan.workspace)}`,
    `${commandArguments(plan).map(quote).join(' ')} >> ${quote(plan.logPath)} 2>&1`,
    '',
  ].join('\r\n')
}

export function windowsTaskName(plan: AutorunPlan): string {
  return `elia\\battmann-${plan.label.replace(/^ai\.elia\.battmann\./, '')}`
}

async function run(command: string[], stdin?: string): Promise<{ code: number; output: string; missing: boolean }> {
  try {
    const child = Bun.spawn(command, { stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code: await child.exited, output: `${out}${err}`.trim(), missing: false }
  } catch {
    return { code: 127, output: `${command[0]} is not available`, missing: true }
  }
}

async function readCrontab(): Promise<{ lines: string[] } | { error: string }> {
  const listed = await run(['crontab', '-l'])
  if (listed.missing) return { error: 'crontab is not installed' }
  // `crontab -l` exits non-zero when the user has no crontab yet; that is an empty one, not an error.
  return { lines: listed.code === 0 ? listed.output.split('\n').filter((line) => line.length) : [] }
}

export async function installAutorun(plan: AutorunPlan): Promise<string> {
  if (plan.temporary) throw new Error(`${plan.workspace} is a temporary directory the system may clear; move the workspace somewhere durable before scheduling it`)
  mkdirSync(path.dirname(plan.logPath), { recursive: true })
  const when = `daily at ${time(plan)}`
  if (plan.platform === 'darwin') {
    mkdirSync(path.dirname(plan.plistPath), { recursive: true })
    const domain = `gui/${String(process.getuid?.() ?? '')}`
    if (existsSync(plan.plistPath)) await run(['launchctl', 'bootout', domain, plan.plistPath])
    writeFileSync(plan.plistPath, launchdPlist(plan), { mode: 0o644 })
    const loaded = await run(['launchctl', 'bootstrap', domain, plan.plistPath])
    if (loaded.code !== 0) throw new Error(`launchctl could not load ${plan.plistPath}: ${loaded.output}`)
  } else if (plan.platform === 'win32') {
    writeFileSync(plan.scriptPath, windowsScript(plan))
    const created = await run(['schtasks', '/Create', '/SC', 'DAILY', '/ST', time(plan), '/TN', windowsTaskName(plan), '/TR', `"${plan.scriptPath}"`, '/F'])
    if (created.code !== 0) throw new Error(`schtasks could not create the task: ${created.output}`)
  } else {
    const current = await readCrontab()
    if ('error' in current) return `${current.error}; add this line with your scheduler of choice:\n${crontabLine(plan)}`
    const kept = current.lines.filter((line) => !line.includes(`# elia-battmann:${plan.label}`))
    const written = await run(['crontab', '-'], `${[...kept, crontabLine(plan)].join('\n')}\n`)
    if (written.code !== 0) throw new Error(`crontab could not be updated: ${written.output}`)
  }
  return `Scheduled ${plan.label}: \`elia battmann cycle ${plan.playbook}\` runs ${when} in ${plan.workspace}, logging to ${plan.logPath}. It runs only while you are logged in and the machine is awake. Remove it with \`elia battmann autorun uninstall ${plan.playbook}\`.`
}

export async function uninstallAutorun(plan: AutorunPlan): Promise<string> {
  if (plan.platform === 'darwin') {
    if (!existsSync(plan.plistPath)) return `Nothing scheduled for this workspace (${plan.plistPath} does not exist).`
    await run(['launchctl', 'bootout', `gui/${String(process.getuid?.() ?? '')}`, plan.plistPath])
    rmSync(plan.plistPath)
  } else if (plan.platform === 'win32') {
    const deleted = await run(['schtasks', '/Delete', '/TN', windowsTaskName(plan), '/F'])
    if (existsSync(plan.scriptPath)) rmSync(plan.scriptPath)
    if (deleted.code !== 0) return `No scheduled task named ${windowsTaskName(plan)} (${deleted.output}).`
  } else {
    const current = await readCrontab()
    if ('error' in current) return `${current.error}; remove the line tagged elia-battmann:${plan.label} from your scheduler.`
    const kept = current.lines.filter((line) => !line.includes(`# elia-battmann:${plan.label}`))
    if (kept.length === current.lines.length) return 'Nothing scheduled for this workspace in your crontab.'
    const written = await run(['crontab', '-'], kept.length ? `${kept.join('\n')}\n` : '')
    if (written.code !== 0) throw new Error(`crontab could not be updated: ${written.output}`)
  }
  return `Removed ${plan.label}.`
}

export async function autorunStatus(plan: AutorunPlan): Promise<string> {
  const lines: string[] = []
  if (plan.platform === 'darwin') {
    const plist = existsSync(plan.plistPath) ? readFileSync(plan.plistPath, 'utf8') : ''
    const at = (key: string) => String(Number(new RegExp(`<key>${key}</key><integer>(\\d+)</integer>`).exec(plist)?.[1] ?? 0)).padStart(2, '0')
    lines.push(`${plan.label}: ${plist ? `scheduled daily at ${at('Hour')}:${at('Minute')} (${plan.plistPath})` : 'not scheduled'}`)
    if (plist) {
      const lastExit = /last exit code = (.+)/.exec((await run(['launchctl', 'print', `gui/${String(process.getuid?.() ?? '')}/${plan.label}`])).output)?.[1]
      if (lastExit) lines.push(`last exit: ${lastExit}`)
    }
  } else if (plan.platform === 'win32') {
    const queried = await run(['schtasks', '/Query', '/TN', windowsTaskName(plan), '/FO', 'LIST', '/V'])
    const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(queried.output)?.[1]?.trim()
    lines.push(queried.code === 0 ? `${windowsTaskName(plan)}: next run ${field('Next Run Time') ?? '?'}, last run ${field('Last Run Time') ?? '?'}, last result ${field('Last Result') ?? '?'}` : `${windowsTaskName(plan)}: not scheduled`)
  } else {
    const current = await readCrontab()
    const line = 'error' in current ? undefined : current.lines.find((entry) => entry.includes(`# elia-battmann:${plan.label}`))
    lines.push(line ? `${plan.label}: scheduled in your crontab: ${line}` : `${plan.label}: not scheduled${'error' in current ? ` (${current.error})` : ''}`)
  }
  if (existsSync(plan.logPath)) lines.push('log tail:', ...readFileSync(plan.logPath, 'utf8').trimEnd().split('\n').slice(-8).map((line) => `  ${line}`))
  return lines.join('\n')
}
