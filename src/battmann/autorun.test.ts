import { expect, test } from 'bun:test'
import { autorunPlan, crontabLine, installAutorun, isTemporaryPath, launchdPlist, windowsScript, windowsTaskName } from './autorun.ts'

// Plans are built for an explicit platform with that platform's path rules, so these hold on any test machine.

const unix = { playbook: 'india-semiconductors', workspace: '/home/analyst/battmann/india', entry: '/home/analyst/elia/bin/elia.ts', runtime: '/home/analyst/.bun/bin/bun', home: '/home/analyst', systemTemp: '/tmp' }
const windows = { playbook: 'india-semiconductors', workspace: 'C:\\Users\\analyst\\battmann\\india', entry: 'C:\\Users\\analyst\\elia\\bin\\elia.ts', runtime: 'C:\\Users\\analyst\\.bun\\bin\\bun.exe', home: 'C:\\Users\\analyst', systemTemp: 'C:\\Users\\analyst\\AppData\\Local\\Temp', platform: 'win32' as const }

test('macOS: a launchd agent that runs the cycle in the workspace and carries no secrets', () => {
  const plan = autorunPlan({ ...unix, platform: 'darwin', at: '21:30' })
  expect(plan.label).toBe('ai.elia.battmann.india-semiconductors.battmann-india')
  expect(plan.plistPath).toBe('/home/analyst/Library/LaunchAgents/ai.elia.battmann.india-semiconductors.battmann-india.plist')
  const plist = launchdPlist(plan)
  expect(plist).toContain('<key>WorkingDirectory</key><string>/home/analyst/battmann/india</string>')
  expect(plist).toContain('<key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer>')
  expect(plist).toContain('<string>cycle</string>')
  expect(plist).not.toMatch(/API_KEY|TOKEN|SECRET/i)
})

test('Linux: a tagged crontab line, so uninstall can find exactly it', () => {
  const plan = autorunPlan({ ...unix, platform: 'linux', at: '06:05' })
  expect(crontabLine(plan)).toBe("5 6 * * * cd '/home/analyst/battmann/india' && ELIA_NO_UPDATE_CHECK=1 NO_COLOR=1 '/home/analyst/.bun/bin/bun' '/home/analyst/elia/bin/elia.ts' 'battmann' 'cycle' 'india-semiconductors' >> '/home/analyst/battmann/india/.elia/battmann-autorun.log' 2>&1 # elia-battmann:ai.elia.battmann.india-semiconductors.battmann-india")
})

test('Windows: a Task Scheduler task running a script kept in the workspace', () => {
  const plan = autorunPlan(windows)
  expect(plan.scriptPath).toBe('C:\\Users\\analyst\\battmann\\india\\.elia\\battmann-autorun.cmd')
  expect(windowsTaskName(plan)).toBe('elia\\battmann-india-semiconductors.battmann-india')
  const script = windowsScript(plan)
  expect(script).toContain('cd /d "C:\\Users\\analyst\\battmann\\india"')
  expect(script).toContain('"C:\\Users\\analyst\\.bun\\bin\\bun.exe" "C:\\Users\\analyst\\elia\\bin\\elia.ts" "battmann" "cycle" "india-semiconductors" >> "C:\\Users\\analyst\\battmann\\india\\.elia\\battmann-autorun.log" 2>&1')
  expect(script).toContain('\r\n')
  expect(script).not.toMatch(/API_KEY|TOKEN|SECRET/i)
})

test('temporary directories are refused on every platform, and a malformed time is too', () => {
  expect(isTemporaryPath('/tmp/battmann', 'linux', '/tmp')).toBe(true)
  expect(isTemporaryPath('/private/var/folders/xy/T/battmann', 'darwin', '/private/var/folders/xy/T')).toBe(true)
  expect(isTemporaryPath('C:\\Users\\analyst\\AppData\\Local\\Temp\\battmann', 'win32', 'C:\\Users\\analyst\\AppData\\Local\\Temp')).toBe(true)
  expect(isTemporaryPath('C:\\Windows\\Temp\\battmann', 'win32', 'C:\\Users\\analyst\\AppData\\Local\\Temp')).toBe(true)
  expect(isTemporaryPath('/home/analyst/battmann', 'linux', '/tmp')).toBe(false)
  expect(isTemporaryPath('C:\\Users\\analyst\\battmann', 'win32', 'C:\\Users\\analyst\\AppData\\Local\\Temp')).toBe(false)
  expect(autorunPlan({ ...unix, platform: 'linux', workspace: '/tmp/battmann' }).temporary).toBe(true)
  expect(autorunPlan({ ...windows, workspace: 'C:\\Users\\analyst\\AppData\\Local\\Temp\\b' }).temporary).toBe(true)
  expect(autorunPlan({ ...windows }).temporary).toBe(false)
  expect(() => autorunPlan({ ...unix, platform: 'linux', at: '25:00' })).toThrow('--at must be a local time')
})

test('install refuses a temporary workspace before touching any scheduler', async () => {
  await expect(installAutorun(autorunPlan({ ...unix, platform: 'linux', workspace: '/tmp/battmann' }))).rejects.toThrow('temporary directory')
})
