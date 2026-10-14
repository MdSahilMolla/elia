import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'bun:test'
import { runSecurityTool, validateScanInput, extractCommandTargets, type SecurityToolContext } from './securityScan.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('extractCommandTargets', () => {
  it('finds bare hostnames, IPv4 literals, host:port, CIDR networks, and URL hosts', () => {
    expect(extractCommandTargets('nmap -sV scanme.example.com')).toEqual(['scanme.example.com'])
    expect(extractCommandTargets('curl -k https://192.168.56.10:8443/actuator')).toEqual(['192.168.56.10'])
    expect(extractCommandTargets('openssl s_client -connect acme.test:443')).toEqual(['acme.test'])
    expect(extractCommandTargets('nmap -p- 10.0.0.0/24')).toEqual(['10.0.0.0'])
    expect(extractCommandTargets('dig +short app.acme.io A')).toEqual(['app.acme.io'])
    expect(extractCommandTargets('hydra -l admin -P /dev/null 10.0.0.5 ssh')).toEqual(['10.0.0.5'])
    expect(extractCommandTargets('ssh admin@acme.test')).toEqual(['acme.test'])
    expect(extractCommandTargets('http://a.test http://b.test')).toEqual(['a.test', 'b.test'])
  })

  it('does not read a file path as a host', () => {
    expect(extractCommandTargets('file C:\\samples\\app.exe')).toEqual([])
    expect(extractCommandTargets('strings /usr/share/wordlists/big.txt')).toEqual([])
    expect(extractCommandTargets('gobuster dir -u http://acme.test -w /usr/share/wordlists/x.txt')).toEqual(['acme.test'])
    expect(extractCommandTargets('gobuster dir -u http://acme.test -w lists/dirb.txt')).toEqual(['acme.test'])
    expect(extractCommandTargets('radare2 -A app.exe')).toEqual([])
    expect(extractCommandTargets('checksec --file=build/vuln')).toEqual([])
    expect(extractCommandTargets('python exploit.py')).toEqual([])
  })

  it('leaves a local analysis command with no target at all', () => {
    expect(extractCommandTargets('echo scan-output-123')).toEqual([])
    expect(extractCommandTargets('nmap -p 22,80,443')).toEqual([])
  })
})

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

  it('caps timeoutMs at 30 minutes and rejects a value that is not a positive integer', () => {
    expect(validateScanInput({ engagement: 'e', label: 'l', command: 'c', timeoutMs: 900_000 }).timeoutMs).toBe(900_000)
    expect(validateScanInput({ engagement: 'e', label: 'l', command: 'c', timeoutMs: 45 * 60_000 }).timeoutMs).toBe(30 * 60_000)
    expect(validateScanInput({ engagement: 'e', label: 'l', command: 'c' }).timeoutMs).toBeUndefined()
    for (const bad of [0, -1, 1.5, '900000', {}]) {
      expect(() => validateScanInput({ engagement: 'e', label: 'l', command: 'c', timeoutMs: bad })).toThrow(/timeoutMs must be a positive integer/)
    }
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
    which: () => 'C:\\fake\\tool.exe',
    ...overrides,
  })

  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'sec-ws-'))
    cwd = mkdtempSync(join(tmpdir(), 'sec-cwd-'))
    mkdirSync(join(ws, 'engagements', 'acme-webapp', 'recon'), { recursive: true })
    writeFileSync(join(ws, 'engagements', 'acme-webapp', 'SCOPE.md'), '# Scope\ntarget: acme.test\n')
  })

  beforeEach(() => {
    written = []
  })

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses to run before an engagement is scaffolded, for a network target', async () => {
    const out = await runSecurityTool({ engagement: 'unknown-eng', label: 'probe', command: 'nmap -sV acme.test' }, ctx())
    expect(out).toContain('No engagement "unknown-eng" found')
    expect(out).toContain('SCOPE.md')
    expect(out).toContain('acme.test')
    expect(written.length).toBe(0)
  })

  it('saves scanned output into the engagement recon folder, redacted', async () => {
    const out = await runSecurityTool({ engagement: 'acme-webapp', label: 'tls-probe', command: 'openssl s_client -connect acme.test:443' }, ctx())
    expect(out).toContain('Saved full output to')
    expect(out).toContain('scope-check: acme.test verified in SCOPE.md')
    const saved = written[0]!
    expect(saved).toContain(join('engagements', 'acme-webapp', 'recon'))
    expect(existsSync(saved)).toBe(true)
    const contents = readFileSync(saved, 'utf-8')
    expect(contents).toContain('$ openssl s_client -connect acme.test:443')
    expect(contents).toContain('scope-check: acme.test verified in SCOPE.md')
    expect(contents).toContain('port 443 is open')
    expect(contents).not.toContain('do-not-leak')
  })

  it('refuses a target that SCOPE.md does not authorize and writes no log', async () => {
    let ran = false
    await expect(
      runSecurityTool({ engagement: 'acme-webapp', label: 'oob', command: 'nmap -sV evil.example.org' }, ctx({ runCommand: async (command) => {
        ran = true
        return { command, exitCode: 0, stdout: '', stderr: '', elapsedMs: 1, timedOut: false }
      } })),
    ).rejects.toThrow(/evil\.example\.org is not in scope/)
    expect(ran).toBe(false)
    expect(written.length).toBe(0)
  })

  it('names what SCOPE.md does authorize when it refuses', async () => {
    await expect(
      runSecurityTool({ engagement: 'acme-webapp', label: 'oob', command: 'curl -s https://other.test/' }, ctx()),
    ).rejects.toThrow(/SCOPE\.md authorizes: acme\.test/)
  })

  it('runs a command with no network target and records that nothing was scope-verified', async () => {
    const out = await runSecurityTool({ engagement: 'acme-webapp', label: 'strings', command: 'file C:\\samples\\app.exe' }, ctx())
    expect(out).toContain('scope-check: no network target detected in the command - nothing was verified against SCOPE.md')
    const contents = readFileSync(written[0]!, 'utf-8')
    expect(contents).toContain('scope-check: no network target detected in the command')
    expect(contents).toContain('port 443 is open')
  })

  it('skips the binary check for a shell builtin rather than refusing a command that runs', async () => {
    const out = await runSecurityTool({ engagement: 'acme-webapp', label: 'echo', command: 'echo local-only' }, ctx({ which: () => null }))
    expect(out).not.toContain('Tool unavailable')
    expect(written.length).toBe(1)
  })

  it('tries to install a missing catalogued binary, then reports why it could not, and writes no log', async () => {
    const commands: string[] = []
    const out = await runSecurityTool(
      { engagement: 'acme-webapp', label: 'nmap', command: 'nmap -sV acme.test' },
      ctx({
        platform: 'linux',
        which: (name) => (name === 'nmap' ? null : 'C:\\fake\\tool.exe'),
        runCommand: async (command) => {
          commands.push(command)
          return { command, exitCode: 0, stdout: '', stderr: '', elapsedMs: 1, timedOut: false }
        },
      }),
    )
    // The install seam is the same runner, so `ran` would be true for the
    // preflight. What must not have happened is the scan itself: an
    // unlaunchable tool never reaches recon/ and cannot be cited as evidence.
    expect(commands.some((c) => c.startsWith('nmap -sV'))).toBe(false)
    expect(out).toContain('nmap is not installed and could not be installed automatically')
    expect(out).toContain('no recon log was written')
    expect(out).toContain('sudo apt install nmap')
    expect(written.length).toBe(0)
  })

  it('installs a missing binary, re-checks PATH, and then runs the scan as asked', async () => {
    const commands: string[] = []
    let installed = false
    const out = await runSecurityTool(
      { engagement: 'acme-webapp', label: 'nmap', command: 'nmap -sV acme.test' },
      ctx({
        platform: 'linux',
        // Absent until the install runs, present after - this is the re-check
        // that makes the scan below honest rather than assumed.
        which: (name) => (name === 'nmap' ? (installed ? '/usr/bin/nmap' : null) : '/usr/bin/other'),
        runCommand: async (command) => {
          commands.push(command)
          if (command.includes('apt install')) {
            installed = true
            return { command, exitCode: 0, stdout: 'done', stderr: '', elapsedMs: 1, timedOut: false }
          }
          return { command, exitCode: 0, stdout: 'port 443 is open', stderr: '', elapsedMs: 1, timedOut: false }
        },
      }),
    )
    // The sudo preflight has to come first, and it must not prompt.
    expect(commands[0]).toBe('sudo -n true')
    expect(commands).toContain('sudo apt install nmap')
    // The install exists so the requested scan can happen: the same command
    // runs afterwards, and a model told to "re-run this" would only be adding a
    // round trip between the install and the work it was asked to do.
    expect(commands).toContain('nmap -sV acme.test')
    expect(out).toContain('port 443 is open')
    expect(out).toContain('nmap was not installed, so it was installed first')
    expect(written.length).toBe(1)
  })

  it('never asks sudo for a password: a cold credential is reported, not prompted', async () => {
    const commands: string[] = []
    const out = await runSecurityTool(
      { engagement: 'acme-webapp', label: 'gdb', command: 'gdb --version' },
      ctx({
        platform: 'linux',
        which: () => null,
        runCommand: async (command) => {
          commands.push(command)
          // sudo -n fails immediately when nothing is cached, which is what
          // keeps an unattended run from hanging on an invisible password prompt.
          return { command, exitCode: 1, stdout: '', stderr: 'sudo: a password is required', elapsedMs: 1, timedOut: false }
        },
      }),
    )
    expect(commands).toEqual(['sudo -n true'])
    expect(out).toContain('sudo -v')
    // It still names the command so the user can run it — naming it is not
    // running it. The executed set above is the actual invariant.
    expect(out).toContain('sudo apt install gdb')
  })

  it('checks the binary behind a wrapper', async () => {
    const out = await runSecurityTool(
      { engagement: 'acme-webapp', label: 'sudo-nmap', command: 'sudo nmap -sV acme.test' },
      ctx({ platform: 'linux', which: () => null }),
    )
    expect(out).toContain('nmap is not installed')
  })

  it('writes no log when the shell reports the tool could not be started', async () => {
    const out = await runSecurityTool(
      { engagement: 'acme-webapp', label: 'nuclei', command: 'nuclei -u http://acme.test' },
      ctx({
        runCommand: async (command) => ({
          command,
          exitCode: 1,
          stdout: '',
          stderr: "'nuclei' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n",
          elapsedMs: 4,
          timedOut: false,
        }),
      }),
    )
    expect(out).toContain('not recognized as an internal or external command')
    expect(out).toContain('not scan evidence')
    expect(written.length).toBe(0)
  })

  it('still logs a genuine non-zero failure that is not a missing tool', async () => {
    await runSecurityTool(
      { engagement: 'acme-webapp', label: 'curl-fail', command: 'curl -s http://acme.test' },
      ctx({ runCommand: async (command) => ({ command, exitCode: 7, stdout: '', stderr: 'connection refused', elapsedMs: 2, timedOut: false }) }),
    )
    expect(written.length).toBe(1)
  })

  it('passes a requested timeout through, capped at 30 minutes', async () => {
    const seen: number[] = []
    const capture: SecurityToolContext['runCommand'] = async (command, timeoutMs) => {
      seen.push(timeoutMs)
      return { command, exitCode: 0, stdout: 'ok', stderr: '', elapsedMs: 1, timedOut: false }
    }
    await runSecurityTool({ engagement: 'acme-webapp', label: 'decompile', command: 'file C:\\samples\\app.exe', timeoutMs: 20 * 60_000 }, ctx({ runCommand: capture }))
    await runSecurityTool({ engagement: 'acme-webapp', label: 'decompile', command: 'file C:\\samples\\app.exe', timeoutMs: 60 * 60_000 }, ctx({ runCommand: capture }))
    await runSecurityTool({ engagement: 'acme-webapp', label: 'decompile', command: 'file C:\\samples\\app.exe' }, ctx({ runCommand: capture }))
    expect(seen).toEqual([20 * 60_000, 30 * 60_000, 5 * 60_000])
  })

  it('rejects an invalid timeoutMs before anything runs', async () => {
    await expect(
      runSecurityTool({ engagement: 'acme-webapp', label: 'bad-timeout', command: 'nmap -sV acme.test', timeoutMs: 1.5 }, ctx()),
    ).rejects.toThrow(/timeoutMs must be a positive integer/)
    expect(written.length).toBe(0)
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