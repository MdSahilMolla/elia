import { expect, test } from 'bun:test'
import { withAgentIdentity } from '../autonomy/context.ts'
import { environmentTool } from './environment.ts'

test('environment discovery reports project, git, runtimes, and redacted capability presence', async () => {
  const result = JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd: process.cwd() }, () => environmentTool.execute({ includeGitDiffStat: true }))) as {
    cwd: string
    project: { stacks: string[] }
    git: { branch: string; status: string }
    runtimes: Record<string, string>
    configuredCapabilityPresence: Record<string, boolean>
    capabilityReadiness: {
      sourceControl: { status: 'ready' | 'missing-config' | 'unavailable'; basis: string; missing?: string[] }
      llm: { status: 'ready' | 'missing-config' | 'unavailable'; basis: string; missing?: string[] }
    }
    browser: { configured: boolean; transports: { mcp: boolean; bridge: boolean; cdp: boolean } }
    limitations: string[]
  }
  expect(result.cwd).toBe(process.cwd())
  expect(result.project.stacks).toContain('typescript')
  expect(result.git.branch).toBe('manus')
  expect(result.runtimes.git).not.toBe('unavailable')
  expect(result.configuredCapabilityPresence).not.toHaveProperty('OPENAI_API_KEY', process.env.OPENAI_API_KEY)
  expect(result.capabilityReadiness.sourceControl.status).toBe('ready')
  expect(['ready', 'missing-config']).toContain(result.capabilityReadiness.llm.status)
  expect(Object.values(result.capabilityReadiness).every((item) => !item.basis.match(/sk-|AIza|Bearer\s+\S+/i))).toBe(true)
  expect(result.browser.transports).toEqual({ mcp: Boolean(process.env.ELIA_BROWSER_MCP_SERVER), bridge: Boolean(process.env.ELIA_BROWSER_BRIDGE_COMMAND), cdp: Boolean(process.env.ELIA_BROWSER_CDP_URL) })
  expect(result.limitations.some((item) => item.includes('Secret values are never returned'))).toBe(true)
})

test('environment discovery does not require a configured browser or provider', async () => {
  const result = JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd: '/tmp' }, () => environmentTool.execute({}))) as { browser: { configured: boolean }; capabilityReadiness: { browser: { status: string; missing?: string[] } }; project: { root: string } }
  expect(result.project.root).toBe('/tmp')
  expect(result.browser.configured).toBe(Boolean(process.env.ELIA_BROWSER_MCP_SERVER || process.env.ELIA_BROWSER_BRIDGE_COMMAND || process.env.ELIA_BROWSER_CDP_URL))
  expect(result.capabilityReadiness.browser.status).toBe(result.browser.configured ? 'ready' : 'missing-config')
})
