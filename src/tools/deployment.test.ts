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

  describe('docker provider', () => {
    function withRegistry<T>(value: string | undefined, fn: () => T): T {
      const previous = process.env.ELIA_DOCKER_REGISTRY
      if (value === undefined) delete process.env.ELIA_DOCKER_REGISTRY
      else process.env.ELIA_DOCKER_REGISTRY = value
      try {
        return fn()
      } finally {
        if (previous === undefined) delete process.env.ELIA_DOCKER_REGISTRY
        else process.env.ELIA_DOCKER_REGISTRY = previous
      }
    }

    test('plans as unlinked, never guessing a registry, when ELIA_DOCKER_REGISTRY is unset', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'elia-deployment-docker-'))
      try {
        writeFileSync(join(cwd, 'Dockerfile'), 'FROM scratch\n')
        const raw = await withRegistry(undefined, () =>
          withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => deploymentTool.execute({ action: 'plan', provider: 'docker', target: 'preview' })),
        )
        const result = JSON.parse(raw) as { status: string; linked: boolean; notes: string[] }
        expect(result.status).toBe('failed')
        expect(result.linked).toBe(false)
        expect(result.notes.join(' ')).toContain('ELIA_DOCKER_REGISTRY')
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })

    test('rejects a malformed ELIA_DOCKER_REGISTRY value instead of passing it through to docker', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'elia-deployment-docker-'))
      try {
        writeFileSync(join(cwd, 'Dockerfile'), 'FROM scratch\n')
        const raw = await withRegistry('not a valid image ref!!', () =>
          withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => deploymentTool.execute({ action: 'plan', provider: 'docker', target: 'preview' })),
        )
        const result = JSON.parse(raw) as { linked: boolean }
        expect(result.linked).toBe(false)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })

    test('build tags with the configured registry+target when linked, and builds untagged when not', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'elia-deployment-docker-'))
      try {
        writeFileSync(join(cwd, 'Dockerfile'), 'FROM scratch\n')

        const linkedPlan = await withRegistry('ghcr.io/acme/widgets', () =>
          withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => deploymentTool.execute({ action: 'plan', provider: 'docker', target: 'production' })),
        )
        expect(JSON.parse(linkedPlan).buildCommand).toBe('docker build -t ghcr.io/acme/widgets:latest .')

        const unlinkedPlan = await withRegistry(undefined, () =>
          withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => deploymentTool.execute({ action: 'plan', provider: 'docker', target: 'preview' })),
        )
        expect(JSON.parse(unlinkedPlan).buildCommand).toBe('docker build .')
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })

    test('verify without a configured registry fails clearly without spawning docker', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'elia-deployment-docker-'))
      try {
        const raw = await withRegistry(undefined, () =>
          withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => deploymentTool.execute({ action: 'verify', provider: 'docker', target: 'preview' })),
        )
        const result = JSON.parse(raw) as { status: string; error: string }
        expect(result.status).toBe('failed')
        expect(result.error).toContain('ELIA_DOCKER_REGISTRY')
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })

    test('verify requires a target so it knows which tag to check', async () => {
      await expect(deploymentTool.execute({ action: 'verify', provider: 'docker' })).rejects.toThrow(/target is required/)
    })
  })
})
