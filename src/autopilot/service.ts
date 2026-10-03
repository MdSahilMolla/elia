import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { currentPlatform, isTemporaryPath, type AutorunPlatform } from '../battmann/autorun.ts'

/**
 * Keeping `elia autopilot --watch` running: started when you log in, restarted
 * if it stops, by the operating system's own service manager.
 *
 * - macOS: a launchd agent (KeepAlive) in ~/Library/LaunchAgents.
 * - Linux: a systemd user service (Restart=always) in ~/.config/systemd/user.
 * - Windows: a Task Scheduler task that runs at log-on.
 *
 * Nothing is installed unless a person asks, and uninstall removes exactly what
 * install created. No key is written into the service: elia reads its provider
 * from the workspace `.env` or ~/.elia/config.env at start, as it does at the
 * terminal. It runs while you are logged in and the machine is awake.
 */

export interface PilotServicePlan {
  platform: AutorunPlatform
  label: string
  workspace: string
  runtime: string
  entry: string
  logPath: string
  plistPath: string
  unitPath: string
  scriptPath: string
  temporary: boolean
  /**
   * A file of settings (the model key) for elia itself, passed as Bun's
   * `--env-file`. Only its path is written into the service. Used when the
   * watched checkout must not hold a `.env` of its own, which the project's
   * tests would load too: a worktree of elia watching elia.
   */
  envFile?: string
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace'
}

export function pilotServicePlan(options: { workspace?: string; runtime: string; entry: string; envFile?: string; platform?: AutorunPlatform; home?: string; systemTemp?: string }): PilotServicePlan {
  const platform = options.platform ?? currentPlatform()
  const paths = platform === 'win32' ? path.win32 : path.posix
  const workspace = paths.resolve(options.workspace ?? process.cwd())
  const home = options.home ?? homedir()
  const label = `ai.elia.autopilot.${slug(workspace.split(/[\\/]/).filter(Boolean).slice(-2).join('-'))}`
  return {
    platform, label, workspace, runtime: options.runtime, entry: options.entry, envFile: options.envFile,
    temporary: isTemporaryPath(workspace, platform, options.systemTemp),
    logPath: paths.join(workspace, '.elia', 'autopilot', 'watch.log'),
    plistPath: paths.join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    unitPath: paths.join(home, '.config', 'systemd', 'user', `${label}.service`),
    scriptPath: paths.join(workspace, '.elia', 'autopilot', 'watch.cmd'),
  }
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const command = (plan: PilotServicePlan) => [plan.runtime, ...(plan.envFile ? [`--env-file=${plan.envFile}`] : []), plan.entry, 'autopilot', '--watch']

export function pilotLaunchdPlist(plan: PilotServicePlan): string {
  const searchPath = [path.posix.dirname(plan.runtime), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
${command(plan).map((argument) => `    <string>${xml(argument)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(plan.workspace)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(searchPath)}</string>
    <key>ELIA_NO_UPDATE_CHECK</key><string>1</string>
    <key>NO_COLOR</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(plan.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(plan.logPath)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
`
}

export function pilotSystemdUnit(plan: PilotServicePlan): string {
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return `[Unit]
Description=elia autopilot --watch (${plan.workspace})
After=network-online.target

[Service]
WorkingDirectory=${plan.workspace}
ExecStart=${command(plan).map(quote).join(' ')}
Environment=ELIA_NO_UPDATE_CHECK=1 NO_COLOR=1
Restart=always
RestartSec=30
StandardOutput=append:${plan.logPath}
StandardError=append:${plan.logPath}

[Install]
WantedBy=default.target
`
}

export function pilotWindowsScript(plan: PilotServicePlan): string {
  const quote = (value: string) => `"${value.replaceAll('"', '')}"`
  return [
    '@echo off',
    'rem created by `elia autopilot install`; remove with `elia autopilot uninstall`.',
    'set ELIA_NO_UPDATE_CHECK=1',
    'set NO_COLOR=1',
    `cd /d ${quote(plan.workspace)}`,
    ':loop',
    `${command(plan).map(quote).join(' ')} >> ${quote(plan.logPath)} 2>&1`,
    'timeout /t 30 /nobreak >nul',
    'goto loop',
    '',
  ].join('\r\n')
}

const windowsTask = (plan: PilotServicePlan) => `elia\\${plan.label}`

async function run(argv: string[]): Promise<{ code: number; output: string }> {
  try {
    const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code: await child.exited, output: `${out}${err}`.trim() }
  } catch {
    return { code: 127, output: `${argv[0]} is not available` }
  }
}

export async function installPilotService(plan: PilotServicePlan): Promise<string> {
  if (plan.temporary) throw new Error(`${plan.workspace} is a temporary directory the system may clear; run the autopilot from somewhere durable`)
  mkdirSync(path.dirname(plan.logPath), { recursive: true })
  if (plan.platform === 'darwin') {
    mkdirSync(path.dirname(plan.plistPath), { recursive: true })
    const domain = `gui/${String(process.getuid?.() ?? '')}`
    if (existsSync(plan.plistPath)) await run(['launchctl', 'bootout', domain, plan.plistPath])
    writeFileSync(plan.plistPath, pilotLaunchdPlist(plan), { mode: 0o644 })
    const loaded = await run(['launchctl', 'bootstrap', domain, plan.plistPath])
    if (loaded.code !== 0) throw new Error(`launchctl could not load ${plan.plistPath}: ${loaded.output}`)
  } else if (plan.platform === 'win32') {
    writeFileSync(plan.scriptPath, pilotWindowsScript(plan))
    const created = await run(['schtasks', '/Create', '/SC', 'ONLOGON', '/TN', windowsTask(plan), '/TR', `"${plan.scriptPath}"`, '/F'])
    if (created.code !== 0) throw new Error(`schtasks could not create the task: ${created.output}`)
    await run(['schtasks', '/Run', '/TN', windowsTask(plan)])
  } else {
    mkdirSync(path.dirname(plan.unitPath), { recursive: true })
    writeFileSync(plan.unitPath, pilotSystemdUnit(plan))
    await run(['systemctl', '--user', 'daemon-reload'])
    const enabled = await run(['systemctl', '--user', 'enable', '--now', path.basename(plan.unitPath)])
    if (enabled.code !== 0) return `Wrote ${plan.unitPath}, but systemd could not start it (${enabled.output}). Start \`elia autopilot --watch\` another way, e.g. from your session's startup.`
  }
  return `The autopilot now watches this repository in the background (${plan.label}) from ${plan.workspace}, starts when you log in and restarts if it stops. Log: ${plan.logPath}. It runs while this machine is awake and you are logged in. Remove it with \`elia autopilot uninstall\`.`
}

export async function uninstallPilotService(plan: PilotServicePlan): Promise<string> {
  if (plan.platform === 'darwin') {
    if (!existsSync(plan.plistPath)) return 'No autopilot service is installed for this repository.'
    await run(['launchctl', 'bootout', `gui/${String(process.getuid?.() ?? '')}`, plan.plistPath])
    rmSync(plan.plistPath)
  } else if (plan.platform === 'win32') {
    await run(['schtasks', '/End', '/TN', windowsTask(plan)])
    const deleted = await run(['schtasks', '/Delete', '/TN', windowsTask(plan), '/F'])
    if (existsSync(plan.scriptPath)) rmSync(plan.scriptPath)
    if (deleted.code !== 0) return `No autopilot task named ${windowsTask(plan)}.`
  } else {
    if (!existsSync(plan.unitPath)) return 'No autopilot service is installed for this repository.'
    await run(['systemctl', '--user', 'disable', '--now', path.basename(plan.unitPath)])
    rmSync(plan.unitPath)
    await run(['systemctl', '--user', 'daemon-reload'])
  }
  return `Removed ${plan.label}; the autopilot no longer watches in the background.`
}

export function pilotServiceInstalled(plan: PilotServicePlan): boolean {
  if (plan.platform === 'darwin') return existsSync(plan.plistPath)
  if (plan.platform === 'win32') return existsSync(plan.scriptPath)
  return existsSync(plan.unitPath)
}

export function pilotLogTail(plan: PilotServicePlan, lines = 10): string[] {
  if (!existsSync(plan.logPath)) return []
  return readFileSync(plan.logPath, 'utf8').trimEnd().split('\n').slice(-lines)
}
