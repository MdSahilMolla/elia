import { describe, expect, test } from 'bun:test'
import {
  CATEGORY_DESCRIPTIONS,
  SECURITY_TOOL_CATALOG,
  TOOL_CATEGORIES,
  binaryForPlatform,
  entriesForCategory,
  probeExecutable,
  toolNamesFor,
  type CatalogEntry,
  type ToolCategory,
} from '../security/toolCatalog.ts'

const CATEGORIES: ToolCategory[] = ['pwn', 'rev', 'crypto', 'stego', 'web', 'misc']

describe('SECURITY_TOOL_CATALOG invariants', () => {
  test('every entry names itself, picks a real category, and says what it is for', () => {
    for (const entry of SECURITY_TOOL_CATALOG) {
      expect(entry.name.trim().length).toBeGreaterThan(0)
      expect(CATEGORIES).toContain(entry.category)
      expect(entry.purpose.trim().length).toBeGreaterThan(10)
    }
  })

  test('every category is represented and described', () => {
    expect(TOOL_CATEGORIES).toEqual(CATEGORIES)
    for (const category of CATEGORIES) {
      expect(CATEGORY_DESCRIPTIONS[category].length).toBeGreaterThan(10)
      expect(entriesForCategory(category).length).toBeGreaterThan(0)
    }
  })

  test('every entry is detectable: a binary on PATH, or a probe to run', () => {
    for (const entry of SECURITY_TOOL_CATALOG) {
      const hasBinary = entry.binaries.length > 0
      expect(hasBinary || typeof entry.probe === 'string' && entry.probe.length > 0).toBe(true)
      if (hasBinary) {
        for (const binary of entry.binaries) expect(binary.trim()).toBe(binary)
      }
    }
  })

  test('no duplicate names — a second entry would double-count the detect list', () => {
    const names = SECURITY_TOOL_CATALOG.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('entriesForCategory partitions the catalog exactly', () => {
    const union = CATEGORIES.flatMap((category) => entriesForCategory(category))
    expect(union).toEqual(SECURITY_TOOL_CATALOG)
    expect(SECURITY_TOOL_CATALOG.length).toBe(union.length)
  })
})

describe('toolNamesFor', () => {
  test('is deterministic and covers every catalogued entry', () => {
    for (const platform of ['linux', 'macos', 'win32'] as NodeJS.Platform[]) {
      const first = toolNamesFor(platform)
      const second = toolNamesFor(platform)
      expect(first).toEqual(second)
      expect(first.length).toBe(SECURITY_TOOL_CATALOG.length)
      expect(first.map((item) => item.name)).toEqual(SECURITY_TOOL_CATALOG.map((entry) => entry.name))
      expect(first.every((item) => item.binary.length > 0)).toBe(true)
    }
  })

  test('defaults to the running platform and resolves the Windows spelling', () => {
    expect(toolNamesFor()).toEqual(toolNamesFor(process.platform))
    const ghidra = SECURITY_TOOL_CATALOG.find((entry) => entry.name === 'ghidra') as CatalogEntry
    expect(binaryForPlatform(ghidra, 'linux')).toBe('analyzeHeadless')
    expect(binaryForPlatform(ghidra, 'darwin')).toBe('analyzeHeadless')
    expect(binaryForPlatform(ghidra, 'win32')).toBe('analyzeHeadless.bat')
    expect(toolNamesFor('win32').find((item) => item.name === 'ghidra')?.binary).toBe('analyzeHeadless.bat')
  })

  test('a probe-only entry reports the interpreter its probe needs on PATH', () => {
    const pwntools = SECURITY_TOOL_CATALOG.find((entry) => entry.name === 'pwntools') as CatalogEntry
    expect(pwntools.binaries).toEqual([])
    expect(probeExecutable(pwntools.probe)).toBe('python3')
    expect(binaryForPlatform(pwntools, 'linux')).toBe('python3')
    expect(toolNamesFor('linux').find((item) => item.name === 'pwntools')?.binary).toBe('python3')
  })

  test('the scope-restricted crackers carry their boundary note into the detect list', () => {
    for (const name of ['hashcat', 'john']) {
      const item = toolNamesFor().find((entry) => entry.name === name)
      expect(item).toBeDefined()
      expect(item!.scopeNote).toContain('CTF')
      expect(item!.scopeNote).toContain('authorized engagement')
    }
  })
})

describe('catalog content', () => {
  const installHints = (entry: CatalogEntry): string[] => Object.values(entry.install ?? {}).filter((hint): hint is string => typeof hint === 'string')

  test('covers the expected count and the named tools of each category', () => {
    expect(SECURITY_TOOL_CATALOG.length).toBeGreaterThanOrEqual(55)
    const names = new Set(SECURITY_TOOL_CATALOG.map((entry) => entry.name))
    for (const expected of ['pwntools', 'gdb', 'ghidra', 'checksec', 'socat', 'sympy', 'z3-solver', 'SageMath', 'hashcat', 'john', 'binwalk', 'exiftool', 'zsteg', 'qpdf', 'tshark', 'ffmpeg', 'sox', 'pdftotext', 'curl', 'jadx', 'apktool', 'upx']) {
      expect(names.has(expected)).toBe(true)
    }
  })

  test('Ghidra is a download, not an apt package, and says where it has to end up on PATH', () => {
    const ghidra = SECURITY_TOOL_CATALOG.find((entry) => entry.name === 'ghidra') as CatalogEntry
    const hints = installHints(ghidra)
    expect(hints.length).toBe(3)
    for (const hint of hints) {
      expect(hint).not.toMatch(/apt(-get)? install|brew install|winget install/)
      expect(hint.toLowerCase()).toContain('path')
    }
  })

  test('a sudo install hint is recognisable as the highest-friction mechanism', () => {
    const sudoHints = SECURITY_TOOL_CATALOG
      .flatMap((entry) => installHints(entry))
      .filter((hint) => hint.startsWith('sudo apt'))
    expect(sudoHints.length).toBeGreaterThan(5)
  })
})
