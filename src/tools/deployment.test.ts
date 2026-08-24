import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withAgentIdentity } from '../autonomy/context.ts'
import { deploymentTool } from './deployment.ts'

describe('deployment tool', () => {
  test('plans without creating or guessing a provider project', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-deployment-'))
    try {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }))
      const raw = await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => deploymentTool.execute({ action: 'plan', provider: 'vercel', target: 'preview' }))
      const result = JSON.parse(raw) as { status: string; linked: boolean; notes: string[] }
      expect(result.status).toBe('failed')
      expect(result.linked).toBe(false)
      expect(result.notes.join(' ')).toContain('linked')
      expect(existsSync(join(cwd, '.elia', 'deployments.jsonl'))).toBe(true)
      expect(readFileSync(join(cwd, '.elia', 'deployments.jsonl'), 'utf8')).toContain('"action":"plan"')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('refuses private or non-provider verification hosts before any request', async () => {
    await expect(deploymentTool.execute({ action: 'verify', provider: 'vercel', url: 'https://127.0.0.1:3000' })).rejects.toThrow('private-network')
    await expect(deploymentTool.execute({ action: 'verify', provider: 'netlify', url: 'https://example.com' })).rejects.toThrow('provider’s default')
  })
})
