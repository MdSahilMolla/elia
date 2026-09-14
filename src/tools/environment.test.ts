import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { environmentTool, versionOf } from './environment.ts'
import { setExecForTests } from '../github/exec.ts'
import { resetGitHubContextCache } from '../github/context.ts'

// Keep environment discovery hermetic: stub the git/gh probes the GitHub
// context detector runs so the test never spawns a real `gh` (which would
// reach the GitHub API) or depend on this checkout's remote.
beforeAll(() => {
  setExecForTests(async (_bin, args) => {
    const key = args.join(' ')
    if (key.includes('--is-inside-work-tree')) return { ok: true, exitCode: 0, stdout: 'true', stderr: '', missing: false }
    if (key.startsWith('remote get-url')) return { ok: true, exitCode: 0, stdout: 'https://github.com/example/repo.git', stderr: '', missing: false }
    if (key.includes('--abbrev-ref')) return { ok: true, exitCode: 0, stdout: 'main', stderr: '', missing: false }
    if (key.startsWith('status --porcelain')) return { ok: true, exitCode: 0, stdout: '', stderr: '', missing: false }
    return { ok: false, exitCode: 1, stdout: '', stderr: 'stubbed', missing: false }
  })
  resetGitHubContextCache()
})
afterAll(() => {
  setExecForTests()
  resetGitHubContextCache()
})

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
    github?: { ghInstalled: boolean; ghAuthenticated: boolean; autonomousReady: boolean }
    limitations: string[]
  }
  expect(result.cwd).toBe(process.cwd())
  expect(result.project.stacks).toContain('typescript')
  expect(result.git.branch).toBeTruthy()
  expect(result.git.branch).not.toBe('unavailable')
  expect(result.runtimes.git).not.toBe('unavailable')
  expect(result.configuredCapabilityPresence).not.toHaveProperty('OPENAI_API_KEY', process.env.OPENAI_API_KEY)
  expect(result.capabilityReadiness.sourceControl.status).toBe('ready')
  const githubReadiness = (result.capabilityReadiness as Record<string, { status: string }>).github
  expect(['ready', 'missing-config', 'unavailable']).toContain(githubReadiness?.status ?? 'unavailable')
  expect(['ready', 'missing-config']).toContain(result.capabilityReadiness.llm.status)
  expect(Object.values(result.capabilityReadiness).every((item) => !item.basis.match(/sk-|AIza|Bearer\s+\S+/i))).toBe(true)
  expect(result.browser.transports).toEqual({ mcp: Boolean(process.env.ELIA_BROWSER_MCP_SERVER), bridge: Boolean(process.env.ELIA_BROWSER_BRIDGE_COMMAND), cdp: Boolean(process.env.ELIA_BROWSER_CDP_URL) })
  expect(result.limitations.some((item) => item.includes('Secret values are never returned'))).toBe(true)
})

// A POSIX shell script stands in for a runtime whose `--version` never returns.
test.if(process.platform !== 'win32')('a hung --version is abandoned after the timeout instead of blocking the tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-hang-'))
  try {
    const hang = join(dir, 'hang')
    // `exec` so the killed process is the one holding the stdout pipe.
    writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n')
    chmodSync(hang, 0o755)
    const started = Date.now()
    expect(await versionOf(hang, 300)).toBe('')
    expect(Date.now() - started).toBeLessThan(5_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('environment discovery does not require a configured browser or provider', async () => {
  // A real directory that exists on every platform — a Unix-only `/tmp` made
  // `runShell` fail with a misleading ENOENT and broke this suite on Windows.
  const scratchDir = tmpdir()
  const result = JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd: scratchDir }, () => environmentTool.execute({}))) as { browser: { configured: boolean }; capabilityReadiness: { browser: { status: string; missing?: string[] } }; project: { root: string } }
  expect(result.project.root).toBe(scratchDir)
  expect(result.browser.configured).toBe(Boolean(process.env.ELIA_BROWSER_MCP_SERVER || process.env.ELIA_BROWSER_BRIDGE_COMMAND || process.env.ELIA_BROWSER_CDP_URL))
  expect(result.capabilityReadiness.browser.status).toBe(result.browser.configured ? 'ready' : 'missing-config')
  // Discovery legitimately costs seconds: ~20 `Bun.which` probes, three git
  // shells and two `--version` spawns. Making versionOf async and parallel took
  // it from ~20s to ~5s in isolation, but bun runs 281 test files at once and
  // under that contention it still measured ~17s — so the default 5s budget was
  // never realistic for this test, and the timeout it kept hitting was the
  // suite's load, not a hang in the tool. Given explicitly so a genuine
  // regression still fails instead of the clock deciding.
}, 60_000)
