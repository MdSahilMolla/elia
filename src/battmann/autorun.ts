import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Keeping a Battmann workspace's monitoring loop running without anyone at the terminal: one daily
 * `elia battmann cycle <playbook>`, scheduled by the operating system. On macOS that is a per-user launchd agent
 * this module writes and loads; elsewhere it prints the crontab line to add. Nothing here runs unless a person
 * asks for it, and `uninstall` removes exactly what `install` created.
 *
 * API keys are never written into the job. The cycle's model step reads the provider saved by
 * `elia config set` (~/.elia/config.env, owner-only), and without one it only runs the model-free steps.
 */

export interface AutorunPlan {
  label: string
  plistPath: string
  workspace: string
  logPath: string
  programArguments: string[]
  hour: number
  minute: number
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace'
}

export function autorunPlan(options: { playbook: string; workspace?: string; at?: string; entry: string; runtime: string }): AutorunPlan {
  const workspace = resolve(options.workspace ?? process.cwd())
  const [hourText, minuteText] = (options.at ?? '22:00').split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText ?? 0)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('--at must be a local time like 22:00')
  if (/^\/(?:private\/)?tmp\/|^\/var\/folders\//.test(workspace)) throw new Error(`${workspace} is a temporary directory the system may clear; move the workspace somewhere durable before scheduling it`)
  const label = `ai.elia.battmann.${slug(options.playbook)}.${slug(workspace.split('/').slice(-2).join('-'))}`
  return {
    label, workspace,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    logPath: join(workspace, '.elia', 'battmann-autorun.log'),
    programArguments: [options.runtime, options.entry, 'battmann', 'cycle', options.playbook],
    hour, minute,
  }
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function launchdPlist(plan: AutorunPlan): string {
  const path = [dirname(plan.programArguments[0]!), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${plan.programArguments.map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(plan.workspace)}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${plan.hour}</integer><key>Minute</key><integer>${plan.minute}</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
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

export function crontabLine(plan: AutorunPlan): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return `${plan.minute} ${plan.hour} * * * cd ${quote(plan.workspace)} && ${plan.programArguments.map(quote).join(' ')} >> ${quote(plan.logPath)} 2>&1`
}

async function launchctl(args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code: await child.exited, output: `${out}${err}`.trim() }
}

export async function installAutorun(plan: AutorunPlan): Promise<string> {
  if (process.platform !== 'darwin') return `Automatic install is macOS-only. Add this line with \`crontab -e\`:\n${crontabLine(plan)}`
  mkdirSync(dirname(plan.plistPath), { recursive: true })
  mkdirSync(dirname(plan.logPath), { recursive: true })
  const uid = String(process.getuid?.() ?? '')
  if (existsSync(plan.plistPath)) await launchctl(['bootout', `gui/${uid}`, plan.plistPath])
  writeFileSync(plan.plistPath, launchdPlist(plan), { mode: 0o644 })
  const loaded = await launchctl(['bootstrap', `gui/${uid}`, plan.plistPath])
  if (loaded.code !== 0) throw new Error(`launchctl could not load ${plan.plistPath}: ${loaded.output}`)
  return `Scheduled ${plan.label}: \`elia battmann cycle\` runs daily at ${String(plan.hour).padStart(2, '0')}:${String(plan.minute).padStart(2, '0')} in ${plan.workspace}, logging to ${plan.logPath}. It runs only while you are logged in and the Mac is awake. Remove it with \`elia battmann autorun uninstall\`.`
}

export async function uninstallAutorun(plan: AutorunPlan): Promise<string> {
  if (process.platform !== 'darwin') return `Remove the line for ${plan.workspace} with \`crontab -e\`.`
  if (!existsSync(plan.plistPath)) return `Nothing scheduled for this workspace (${plan.plistPath} does not exist).`
  await launchctl(['bootout', `gui/${String(process.getuid?.() ?? '')}`, plan.plistPath])
  rmSync(plan.plistPath)
  return `Removed ${plan.label}.`
}

export async function autorunStatus(plan: AutorunPlan): Promise<string> {
  const scheduled = process.platform === 'darwin' ? existsSync(plan.plistPath) : false
  const plist = scheduled ? readFileSync(plan.plistPath, 'utf8') : ''
  const at = (key: string) => String(Number(new RegExp(`<key>${key}</key><integer>(\\d+)</integer>`).exec(plist)?.[1] ?? 0)).padStart(2, '0')
  const lines = [`${plan.label}: ${scheduled ? `scheduled daily at ${at('Hour')}:${at('Minute')} (${plan.plistPath})` : 'not scheduled'}`]
  if (scheduled) {
    const printed = await launchctl(['print', `gui/${String(process.getuid?.() ?? '')}/${plan.label}`])
    const lastExit = /last exit code = (.+)/.exec(printed.output)?.[1]
    if (lastExit) lines.push(`last exit: ${lastExit}`)
  }
  if (existsSync(plan.logPath)) lines.push('log tail:', ...readFileSync(plan.logPath, 'utf8').trimEnd().split('\n').slice(-8).map((line) => `  ${line}`))
  return lines.join('\n')
}
