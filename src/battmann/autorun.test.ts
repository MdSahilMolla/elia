import { expect, test } from 'bun:test'
import { autorunPlan, crontabLine, launchdPlist } from './autorun.ts'

const base = { playbook: 'india-semiconductors', workspace: '/Users/analyst/battmann/india', entry: '/Users/analyst/elia/bin/elia.ts', runtime: '/Users/analyst/.bun/bin/bun' }

test('the daily job runs `elia battmann cycle` in the workspace and carries no secrets', () => {
  const plan = autorunPlan({ ...base, at: '21:30' })
  expect(plan.label).toBe('ai.elia.battmann.india-semiconductors.battmann-india')
  expect(plan.programArguments).toEqual(['/Users/analyst/.bun/bin/bun', '/Users/analyst/elia/bin/elia.ts', 'battmann', 'cycle', 'india-semiconductors'])
  const plist = launchdPlist(plan)
  expect(plist).toContain('<key>WorkingDirectory</key><string>/Users/analyst/battmann/india</string>')
  expect(plist).toContain('<key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer>')
  expect(plist).toContain('/Users/analyst/.bun/bin:')
  expect(plist).not.toMatch(/API_KEY|TOKEN|SECRET/i)
  expect(crontabLine(plan)).toBe("30 21 * * * cd '/Users/analyst/battmann/india' && '/Users/analyst/.bun/bin/bun' '/Users/analyst/elia/bin/elia.ts' 'battmann' 'cycle' 'india-semiconductors' >> '/Users/analyst/battmann/india/.elia/battmann-autorun.log' 2>&1")
})

test('a temporary workspace or a malformed time is refused', () => {
  expect(() => autorunPlan({ ...base, workspace: '/private/tmp/scratch/battmann' })).toThrow('temporary directory')
  expect(() => autorunPlan({ ...base, workspace: '/var/folders/xy/T/battmann' })).toThrow('temporary directory')
  expect(() => autorunPlan({ ...base, at: '25:00' })).toThrow('--at must be a local time')
})
