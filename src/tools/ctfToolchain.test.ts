import { describe, expect, test } from 'bun:test'
import { classifyInstall, ctfToolchainTool, reportToolchain, runProbeCommand, type ToolchainContext } from './ctfToolchain.ts'
import { SECURITY_TOOL_CATALOG } from '../security/toolCatalog.ts'

/**
 * Detection is injected, so nothing here depends on a real toolchain: the
 * suite passes on a machine with none of these installed. The default `which`
 * would otherwise read the real PATH and make the assertions machine-specific.
 */
const noneInstalled = (overrides: Partial<ToolchainContext> = {}): ToolchainContext => ({
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
  test('groups all five categories and states that nothing was installed', async () => {
    const report = await reportToolchain({}, noneInstalled())
    for (const category of ['pwn', 'rev', 'crypto', 'stego', 'misc']) {
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
    for (const category of ['pwn', 'rev', 'stego', 'misc']) expect(report).not.toContain(`--- ${category} — `)
    expect(report).toContain('Categories: crypto')
  })

  test('an unknown category throws and names the valid ones', async () => {
    await expect(reportToolchain({ category: 'forensics' }, noneInstalled())).rejects.toThrow(/category must be one of: pwn, rev, crypto, stego, misc/)
    // An empty string is "not provided" here, not an invalid category.
    await expect(reportToolchain({ category: '' }, noneInstalled())).resolves.toContain('Categories: pwn, rev, crypto, stego, misc')
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
          return command === 'python3 -c "import pwn"'
        },
      }),
    )
    expect(probes).toEqual(['python3 -c "import pwn"'])
    expect(report).toContain('  [present] pwntools  (probe: python3 -c "import pwn")')
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

describe('ctfToolchainTool', () => {
  test('declares the five categories and says it only reports', () => {
    expect(ctfToolchainTool.name).toBe('ctf_toolchain')
    const category = ctfToolchainTool.input_schema.properties.category as { enum: string[] }
    expect(category.enum).toEqual(['pwn', 'rev', 'crypto', 'stego', 'misc'])
    expect(ctfToolchainTool.description).toContain('NEVER installs')
    expect(ctfToolchainTool.description).toContain('READ-ONLY')
  })
})
