import { describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyInstall,
  ctfToolchainTool,
  executableInstallCommand,
  installEntry,
  reportToolchain,
  runProbeCommand,
  type InstallContext,
} from './ctfToolchain.ts'
import { SECURITY_TOOL_CATALOG } from '../security/toolCatalog.ts'
import { setActiveMode } from '../autonomy/mode.ts'

/**
 * Detection is injected, so nothing here depends on a real toolchain: the
 * suite passes on a machine with none of these installed. The default `which`
 * would otherwise read the real PATH and make the assertions machine-specific.
 *
 * Typed as InstallContext rather than ToolchainContext so the install tests can
 * inject `runInstall` through the same helper; InstallContext only adds that
 * field, so every read-only caller is unaffected.
 */
const noneInstalled = (overrides: Partial<InstallContext> = {}): InstallContext => ({
  platform: 'linux',
  which: () => null,
  probe: async () => false,
  probeCache: new Map(),
  ...overrides,
})

const onlyInstalled = (...present: string[]) => noneInstalled({
  which: (binary) => (present.includes(binary) ? `/usr/bin/${binary}` : null),
})

describe('reportToolchain structure', () => {
  test('groups all six categories and states that nothing was installed', async () => {
    const report = await reportToolchain({}, noneInstalled())
    for (const category of ['pwn', 'rev', 'crypto', 'stego', 'web', 'misc']) {
      expect(report).toContain(`--- ${category} — `)
    }
    expect(report).toContain('=== CTF toolchain (read-only detection) ===')
    expect(report).toContain('NEVER installs')
    expect(report).toContain('NEVER runs an install')
    expect(report).toContain('Install plan (NOTHING BELOW WAS EXECUTED)')
  })

  test('a category filter narrows the report to that category only', async () => {
    const report = await reportToolchain({ category: 'crypto' }, noneInstalled())
    expect(report).toContain('--- crypto — ')
    for (const category of ['pwn', 'rev', 'stego', 'web', 'misc']) expect(report).not.toContain(`--- ${category} — `)
    expect(report).toContain('Categories: crypto')
  })

  test('an unknown category throws and names the valid ones', async () => {
    await expect(reportToolchain({ category: 'forensics' }, noneInstalled())).rejects.toThrow(/category must be one of: pwn, rev, crypto, stego, web, misc/)
    // An empty string is "not provided" here, not an invalid category.
    await expect(reportToolchain({ category: '' }, noneInstalled())).resolves.toContain('Categories: pwn, rev, crypto, stego, web, misc')
  })

  test('every catalogued tool appears exactly once in a full report', async () => {
    const report = await reportToolchain({}, noneInstalled())
    for (const entry of SECURITY_TOOL_CATALOG) {
      expect(report.split(`  [missing] ${entry.name}  `).length - 1).toBe(1)
    }
  })
})

describe('present and missing reporting', () => {
  test('a detected binary is marked present with the name it was found under', async () => {
    const report = await reportToolchain({ category: 'pwn' }, onlyInstalled('gdb'))
    expect(report).toContain('  [present] gdb  (binary: gdb)')
    expect(report).toContain('  [missing] checksec')
  })

  test('a missing tool states the blocking impact, taken from its purpose', async () => {
    const report = await reportToolchain({ category: 'pwn' }, noneInstalled())
    const checksec = SECURITY_TOOL_CATALOG.find((entry) => entry.name === 'checksec')
    expect(report).toContain(`  [missing] checksec`)
    expect(report).toContain(`      blocked: ${checksec!.purpose}`)
  })

  test('a probe-only tool is detected by its probe, not by a binary lookup', async () => {
    const probes: string[] = []
    const report = await reportToolchain(
      { category: 'pwn' },
      noneInstalled({
        probe: async (command) => {
          probes.push(command)
          return command === 'python3 -I -c "import pwn"'
        },
      }),
    )
    expect(probes).toEqual(['python3 -I -c "import pwn"'])
    expect(report).toContain('  [present] pwntools  (probe: python3 -I -c "import pwn")')
    // A probe-based tool has no binary of its own, so the note says what the
    // probe actually depends on.
    expect(report).toContain('note: detected by probe, so it only answers once python3 is on PATH')
  })

  test('probes run once per process, not once per report', async () => {
    let calls = 0
    const ctx = noneInstalled({ probe: async () => { calls += 1; return true } })
    await reportToolchain({ category: 'crypto' }, ctx)
    const after = calls
    await reportToolchain({ category: 'crypto' }, ctx)
    expect(after).toBeGreaterThan(0)
    expect(calls).toBe(after)
  })

  test('a scope-restricted tool carries its boundary into the report', async () => {
    const report = await reportToolchain({ category: 'crypto' }, noneInstalled())
    expect(report).toContain('      scope: Only run this against a CTF')
    expect(report).toContain('authorized engagement')
  })
})

describe('install plan', () => {
  test('groups every missing tool by mechanism and labels each group\'s cost', async () => {
    const report = await reportToolchain({ category: 'pwn' }, noneInstalled())
    // sudo apt is the top group, the download-style hint the bottom one.
    const aptIndex = report.indexOf('[1] apt — HIGHEST friction')
    const manualIndex = report.indexOf('manual — LOWEST friction')
    expect(aptIndex).toBeGreaterThan(-1)
    expect(manualIndex).toBeGreaterThan(aptIndex)
    expect(report).toContain('cost: This runs `sudo`')
    expect(report).toContain('A plain download and unzip')
    expect(report).toContain('    checksec: mkdir -p ~/.local/bin')
    expect(report).toContain('    gdb: sudo apt install gdb')
  })

  test('a pip install is labelled as running package build scripts', async () => {
    const report = await reportToolchain({ category: 'crypto' }, noneInstalled())
    expect(report).toContain('pip — MEDIUM-HIGH friction')
    expect(report).toContain("runs the package's own install and build scripts")
    expect(report).toContain('    sympy: pip install sympy')
  })

  test('a tool with no hint for this platform is reported as unhinted, not guessed', async () => {
    const report = await reportToolchain({ category: 'pwn' }, noneInstalled({ platform: 'darwin' }))
    // strace and ltrace are Linux-only; the report says so rather than
    // suggesting the apt command it printed for a different platform.
    expect(report).toContain('no macos hint')
    expect(report).not.toMatch(/sudo apt install/)
  })

  test('with nothing missing there is no install plan to act on', async () => {
    const report = await reportToolchain(
      { category: 'stego' },
      noneInstalled({ which: (binary) => `/usr/bin/${binary}`, probe: async () => true }),
    )
    expect(report).toContain('every catalogued tool for the requested categories was detected')
    expect(report).not.toContain('[1]')
  })

  test('platform-specific PATH notes are emitted for the tools that need one', async () => {
    const windows = await reportToolchain({ category: 'rev' }, noneInstalled({ platform: 'win32' }))
    expect(windows).toContain('note: on win32 the binary is analyzeHeadless.bat, not analyzeHeadless')
    expect(windows).toContain('add <ghidra>\\support to PATH')
  })
})

describe('classifyInstall', () => {
  test('routes an install hint to the mechanism that runs it', () => {
    expect(classifyInstall('sudo apt install gdb')).toBe('apt')
    expect(classifyInstall('sudo apt install nmap — ncat ships inside the nmap package')).toBe('apt')
    expect(classifyInstall('brew install radare2')).toBe('brew')
    expect(classifyInstall('winget install Python.Python.3')).toBe('winget')
    expect(classifyInstall('choco install socat')).toBe('choco')
    expect(classifyInstall('pip install pwntools')).toBe('pip')
    expect(classifyInstall('sudo pip install pwntools')).toBe('pip')
    expect(classifyInstall('npm install -g cyberchef')).toBe('npm')
    expect(classifyInstall('gem install one_gadget')).toBe('gem')
    expect(classifyInstall('go install github.com/x/y@latest')).toBe('go')
    expect(classifyInstall('Download the official Ghidra release ZIP and unzip it')).toBe('manual')
    expect(classifyInstall('xcode-select --install — otool ships with the Xcode command line tools')).toBe('manual')
  })
})

describe('runProbeCommand', () => {
  // Driven with the interpreter already running the suite, so the assertion is
  // about the probe mechanism — async spawn, exit code, timeout — and not about
  // any catalogued tool being installed.
  test('answers on exit code and gives up on a command that never returns', async () => {
    expect(await runProbeCommand('bun -e "process.exit(0)"', 10_000)).toBe(true)
    expect(await runProbeCommand('bun -e "process.exit(3)"', 10_000)).toBe(false)
    const started = Date.now()
    expect(await runProbeCommand('bun -e "setTimeout(() => {}, 60000)"', 300)).toBe(false)
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})

describe('probe isolation', () => {
  test('a probe runs in an empty temp directory, not the workspace', async () => {
    const marker = `probe-cwd-${process.pid}`
    const out = join(tmpdir(), marker)
    // The probe writes its own cwd listing; the workspace (this repo) has many entries.
    const script = join(tmpdir(), `${marker}.js`)
    writeFileSync(script, `const fs = require('fs'); fs.writeFileSync(process.argv[2], process.cwd() + '|' + fs.readdirSync('.').length)`)
    const ok = await runProbeCommand(`bun ${script} ${out}`, 10_000)
    rmSync(script, { force: true })
    expect(ok).toBe(true)
    const [cwd, count] = readFileSync(out, 'utf8').split('|')
    rmSync(out, { force: true })
    expect(cwd).not.toBe(process.cwd())
    expect(count).toBe('0')
  })

  test('python probes are isolated and openstego is detected by PATH only', async () => {
    const commands: string[] = []
    await reportToolchain({}, { platform: 'linux', which: () => null, probe: async (c) => (commands.push(c), false) })
    const python = commands.filter((c) => c.startsWith('python3'))
    expect(python.length).toBeGreaterThan(0)
    for (const c of python) expect(c.startsWith('python3 -I -c ')).toBe(true)
    expect(commands.some((c) => c.includes('openstego.jar'))).toBe(false)
  })
})

describe('ctfToolchainTool', () => {
  test('declares the six categories and says it only reports', () => {
    expect(ctfToolchainTool.name).toBe('ctf_toolchain')
    const category = ctfToolchainTool.input_schema.properties.category as { enum: string[] }
    expect(category.enum).toEqual(['pwn', 'rev', 'crypto', 'stego', 'web', 'misc'])
    expect(ctfToolchainTool.description).toContain('NEVER installs')
    expect(ctfToolchainTool.description).toContain('READ-ONLY')
  })

  test('refuses install:true outside cyber, so the tool cannot install on a dev turn', async () => {
    // The schema still allows install:true in every mode, so the boundary cannot
    // live in the schema. It lives here: read-only reporting is harmless
    // anywhere, but installing packages runs build scripts and needs sudo, and
    // that is a cyber permission, not a tool default.
    setActiveMode('dev')
    const result = await ctfToolchainTool.execute({ category: 'pwn', install: true })
    expect(String(result)).toContain('cyber')
    expect(String(result)).toContain('install')
  })

  test('keeps read-only reporting available in dev, which installs nothing', async () => {
    setActiveMode('dev')
    const result = await ctfToolchainTool.execute({ category: 'pwn' })
    expect(String(result)).toContain('NEVER installs')
  })
})

describe('install hint vetting', () => {
  test('runs a single recognisable install command', () => {
    expect(executableInstallCommand('sudo apt install nmap')).toBe('sudo apt install nmap')
    expect(executableInstallCommand('pip install pwntools')).toBe('pip install pwntools')
    expect(executableInstallCommand('brew install radare2')).toBe('brew install radare2')
    expect(executableInstallCommand('go install example.com/tool@latest')).toBe('go install example.com/tool@latest')
  })

  test('refuses prose, because the catalog deliberately stores notes as hints', () => {
    // ghidra and openstego are stored as download instructions. Executing one
    // would run English as a shell and then record the failure as an install
    // attempt, which is worse than reporting no hint at all.
    expect(classifyInstall('Download Ghidra from the vendor site')).toBe('manual')
    expect(executableInstallCommand('Download Ghidra from the vendor site')).toBeUndefined()
    expect(executableInstallCommand('Build from source; see the project README')).toBeUndefined()
  })

  test('refuses a command with a trailing note, so apt is not handed a sentence', () => {
    // This is a real catalog entry: the em dash is how the file annotates why
    // one package serves several tools. Run verbatim, apt would try to resolve
    // the note as package names.
    const entry = SECURITY_TOOL_CATALOG.find((e) => e.name === 'ncat')
    expect(entry?.install?.linux).toBeDefined()
    expect(executableInstallCommand(entry!.install!.linux!)).toBeUndefined()
  })

  test('refuses chains and redirection, which are procedures rather than one install', () => {
    expect(executableInstallCommand('git clone https://example.com/pwndbg && cd pwndbg && ./setup.sh')).toBeUndefined()
    expect(executableInstallCommand('sudo apt install nmap > /tmp/out')).toBeUndefined()
    expect(executableInstallCommand('sudo apt install nmap; reboot')).toBeUndefined()
  })

  test('every vetted linux hint in the real catalog is a single runnable command', () => {
    // The catalog's own rule is that a wrong install command is worse than no
    // hint, so this asserts the vetting holds across all of them rather than
    // only on the entries picked out above.
    for (const entry of SECURITY_TOOL_CATALOG) {
      const hint = entry.install?.linux
      if (hint === undefined) continue
      const vetted = executableInstallCommand(hint)
      if (vetted !== undefined) expect(vetted).toBe(hint.trim())
    }
  })
})

describe('installEntry', () => {
  const gdb = SECURITY_TOOL_CATALOG.find((e) => e.name === 'gdb')!

  test('reports an entry with no install hint instead of guessing one', async () => {
    const otool = SECURITY_TOOL_CATALOG.find((e) => e.name === 'otool')!
    const receipt = await installEntry(otool, noneInstalled())
    expect(receipt.outcome).toBe('no-runnable-hint')
  })

  test('does not run an install when the tool is already present', async () => {
    const receipt = await installEntry(gdb, noneInstalled({ which: (b) => (b === 'gdb' ? '/usr/bin/gdb' : null) }))
    expect(receipt.outcome).toBe('already-present')
  })

  test('never runs an install when sudo has no cached credential', async () => {
    const commands: string[] = []
    const receipt = await installEntry(
      gdb,
      noneInstalled({
        runInstall: async (command) => {
          commands.push(command)
          return { exitCode: 1, stdout: '', stderr: 'sudo: a password is required', timedOut: false }
        },
      }),
    )
    expect(commands).toEqual(['sudo -n true'])
    expect(receipt.outcome).toBe('needs-sudo')
  })

  test('reports a clean install that did not put the tool on PATH as a failure', async () => {
    // The exit code is not the postcondition: a pip --user or go install can
    // succeed and still leave the binary unresolvable, and claiming otherwise
    // would send the caller into a technique the machine cannot run.
    const receipt = await installEntry(
      gdb,
      noneInstalled({
        runInstall: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
      }),
    )
    expect(receipt.outcome).toBe('failed')
    expect(receipt.detail).toContain('still is not detectable')
  })

  test('a rootless install path needs no sudo preflight, and a probe-only tool is re-probed', async () => {
    // pwntools has no binary of its own: it is detected by `python3 -c "import
    // pwn"`, so the post-install check has to clear that probe's cached false
    // and ask again, or the install is reported as a failure every time.
    const commands: string[] = []
    let present = false
    const receipt = await installEntry(
      SECURITY_TOOL_CATALOG.find((e) => e.name === 'pwntools')!,
      noneInstalled({
        probe: async () => present,
        runInstall: async (command) => {
          commands.push(command)
          if (command.startsWith('pip')) present = true
          return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
        },
      }),
    )
    expect(commands.some((c) => c.startsWith('sudo -n'))).toBe(false)
    expect(receipt.outcome).toBe('installed')
  })
})
