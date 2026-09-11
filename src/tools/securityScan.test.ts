import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { runSecurityTool, validateScanInput, type SecurityToolContext } from './securityScan.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

describe('validateScanInput', () => {
  it('rejects empty or missing fields', () => {
    expect(() => validateScanInput({ label: 'l', command: 'c' })).toThrow(/engagement must be a non-empty string/)
    expect(() => validateScanInput({ engagement: 'e', command: 'c' })).toThrow(/label must be a non-empty string/)
    expect(() => validateScanInput({ engagement: 'e', label: 'l' })).toThrow(/command must be a non-empty string/)
    expect(() => validateScanInput({ engagement: ' e ', label: ' l ', command: ' c ' })).not.toThrow()
  })

  it('sanitizes the label into a filesystem-safe name', () => {
    const { label } = validateScanInput({ engagement: 'e', label: 'Nmap!! Full TCP Scan', command: 'c' })
    expect(label).toBe('nmap-full-tcp-scan')
  })

  it('rejects commands beyond the length cap', () => {
    expect(() => validateScanInput({ engagement: 'e', label: 'l', command: 'x'.repeat(100_001) })).toThrow(/exceeds 100000 characters/)
  })
})

describe('runSecurityTool (injected command and log)', () => {
  let ws: string
  let cwd: string
  let written: string[] = []

  const ctx = (overrides: Partial<SecurityToolContext> = {}): SecurityToolContext => ({
    engagementRoot: ws,
    cwd,
    runCommand: async () => ({
      command: 'probe',
      exitCode: 0,
      stdout: 'port 443 is open\nSECRET_KEY=do-not-leak\n',
      stderr: '',
      elapsedMs: 5,
      timedOut: false,
    }),
    writeLog: async (path, contents) => {
      written.push(path)
      writeFileSync(path, contents)
    },
    ...overrides,
  })

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'sec-ws-'))
    cwd = mkdtempSync(join(tmpdir(), 'sec-cwd-'))
    mkdirSync(join(ws, 'engagements', 'acme-webapp', 'recon'), { recursive: true })
    writeFileSync(join(ws, 'engagements', 'acme-webapp', 'SCOPE.md'), '# Scope\ntarget: acme.test\n')
  })

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses to run before an engagement is scaffolded', async () => {
    const out = await runSecurityTool({ engagement: 'unknown-eng', label: 'probe', command: 'x' }, ctx())
    expect(out).toContain('No engagement "unknown-eng" found')
    expect(out).toContain('SCOPE.md')
    expect(written.length).toBe(0)
  })

  it('saves scanned output into the engagement recon folder, redacted', async () => {
    const out = await runSecurityTool({ engagement: 'acme-webapp', label: 'tls-probe', command: 'openssl s_client -connect acme.test:443' }, ctx())
    expect(out).toContain('Saved full output to')
    const saved = written[0]!
    expect(saved).toContain(join('engagements', 'acme-webapp', 'recon'))
    expect(existsSync(saved)).toBe(true)
    const contents = readFileSync(saved, 'utf-8')
    expect(contents).toContain('$ openssl s_client -connect acme.test:443')
    expect(contents).toContain('port 443 is open')
    expect(contents).not.toContain('do-not-leak')
  })

  it('passes the command through to the runner with context cwd', async () => {
    let captured: { command: string; cwd?: string } | null = null
    const out = await runSecurityTool(
      { engagement: 'acme-webapp', label: 'srv-probe', command: 'curl -s http://acme.test/health' },
      ctx({
        runCommand: async (command) => {
          captured = { command }
          return { command, exitCode: 0, stdout: '{"status":"ok"}', stderr: '', elapsedMs: 3, timedOut: false }
        },
      }),
    )
    expect(captured!.command).toBe('curl -s http://acme.test/health')
    expect(out).toContain('"status":"ok"')
  })
})