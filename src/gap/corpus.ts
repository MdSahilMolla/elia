import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlantedDefect } from './types.ts'

/**
 * The planted-defect corpus.
 *
 * Every entry is a minimal, self-contained change with a known verdict: the
 * `defective` variant really is wrong, the `clean` one really is fine, and
 * `expectedCatch` names the cheapest rung that ought to notice. Kept hermetic on
 * purpose — no installs, no network — so the scoreboard is reproducible
 * run-to-run and the guard can trust a delta.
 *
 * `judgment`-regime entries are the control group: they compile and pass their
 * own tests, and only an adversarial reader catches them. They are expected to
 * escape the deterministic ladder — that number is the point, not a failure.
 */

const PKG = JSON.stringify({ name: 'fixture', private: true, version: '0.0.0' }, null, 2)
const TSCONFIG = JSON.stringify(
  { compilerOptions: { strict: true, noEmit: true, target: 'esnext', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true } },
  null,
  2,
)

export const CORPUS: PlantedDefect[] = [
  {
    id: 'structural-unbalanced-brace',
    regime: 'mechanical',
    summary: 'an edit drops a closing brace, leaving the file unparseable',
    expectedCatch: 'structural',
    clean: { 'src/area.ts': `export function area(w: number, h: number): number {\n  return w * h\n}\n` },
    defective: { 'src/area.ts': `export function area(w: number, h: number): number {\n  return w * h\n` },
  },
  {
    id: 'structural-unterminated-string',
    regime: 'mechanical',
    summary: 'a string literal is left unterminated',
    expectedCatch: 'structural',
    clean: { 'src/greet.ts': `export const hello = "hi there"\n` },
    defective: { 'src/greet.ts': `export const hello = "hi there\n` },
  },
  {
    id: 'typecheck-wrong-return-type',
    regime: 'mechanical',
    summary: 'a function annotated : number returns a string',
    expectedCatch: 'typecheck',
    clean: {
      'package.json': PKG,
      'tsconfig.json': TSCONFIG,
      'src/count.ts': `export function count(items: unknown[]): number {\n  return items.length\n}\n`,
    },
    defective: {
      'package.json': PKG,
      'tsconfig.json': TSCONFIG,
      'src/count.ts': `export function count(items: unknown[]): number {\n  return String(items.length)\n}\n`,
    },
  },
  {
    id: 'typecheck-missing-argument',
    regime: 'mechanical',
    summary: 'a call site drops a required argument after a signature change',
    expectedCatch: 'typecheck',
    clean: {
      'package.json': PKG,
      'tsconfig.json': TSCONFIG,
      'src/pad.ts': `function pad(s: string, width: number): string {\n  return s.padStart(width)\n}\nexport const out = pad('x', 4)\n`,
    },
    defective: {
      'package.json': PKG,
      'tsconfig.json': TSCONFIG,
      'src/pad.ts': `function pad(s: string, width: number): string {\n  return s.padStart(width)\n}\nexport const out = pad('x')\n`,
    },
  },
  {
    id: 'test-off-by-one',
    regime: 'mechanical',
    summary: 'a range helper includes one element too many',
    expectedCatch: 'test',
    clean: { 'src/range.ts': `export function range(n: number): number[] {\n  const out: number[] = []\n  for (let i = 0; i < n; i++) out.push(i)\n  return out\n}\n` },
    defective: { 'src/range.ts': `export function range(n: number): number[] {\n  const out: number[] = []\n  for (let i = 0; i <= n; i++) out.push(i)\n  return out\n}\n` },
    test: { 'src/range.test.ts': `import { expect, test } from 'bun:test'\nimport { range } from './range.ts'\ntest('range(3) is [0,1,2]', () => {\n  expect(range(3)).toEqual([0, 1, 2])\n})\n` },
  },
  {
    id: 'test-inverted-condition',
    regime: 'mechanical',
    summary: 'a comparison operator is flipped, so max() returns the min',
    expectedCatch: 'test',
    clean: { 'src/max.ts': `export function max(a: number, b: number): number {\n  return a > b ? a : b\n}\n` },
    defective: { 'src/max.ts': `export function max(a: number, b: number): number {\n  return a < b ? a : b\n}\n` },
    test: { 'src/max.test.ts': `import { expect, test } from 'bun:test'\nimport { max } from './max.ts'\ntest('max picks the larger', () => {\n  expect(max(2, 9)).toBe(9)\n  expect(max(9, 2)).toBe(9)\n})\n` },
  },
  {
    id: 'test-empty-collection',
    regime: 'mechanical',
    summary: 'average() divides by zero on an empty array instead of returning 0',
    expectedCatch: 'test',
    clean: { 'src/avg.ts': `export function average(xs: number[]): number {\n  if (xs.length === 0) return 0\n  return xs.reduce((a, b) => a + b, 0) / xs.length\n}\n` },
    defective: { 'src/avg.ts': `export function average(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0) / xs.length\n}\n` },
    test: { 'src/avg.test.ts': `import { expect, test } from 'bun:test'\nimport { average } from './avg.ts'\ntest('average of [] is 0', () => {\n  expect(average([])).toBe(0)\n})\n` },
  },
  {
    id: 'hygiene-hardcoded-secret',
    regime: 'mechanical',
    summary: 'an API key is committed as a string literal',
    expectedCatch: 'hygiene',
    clean: { 'src/client.ts': `export const apiKey = process.env.SERVICE_API_KEY ?? ''\n` },
    defective: { 'src/client.ts': `export const apiKey = process.env.SERVICE_API_KEY ?? 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'\n` },
  },
  {
    id: 'hygiene-undeclared-dependency',
    regime: 'mechanical',
    summary: 'a new import is not added to package.json, so it only works locally',
    expectedCatch: 'hygiene',
    clean: {
      'package.json': JSON.stringify({ name: 'fixture', private: true, version: '0.0.0', dependencies: { 'left-pad': '^1.3.0' } }, null, 2),
      'src/fmt.ts': `import leftPad from 'left-pad'\nexport const out = leftPad('x', 4)\n`,
    },
    defective: {
      'package.json': PKG,
      'src/fmt.ts': `import leftPad from 'left-pad'\nexport const out = leftPad('x', 4)\n`,
    },
  },
  {
    id: 'judgment-intent-drift',
    regime: 'judgment',
    summary: 'code compiles and its own test passes, but it silently changes a documented default (30 → 3600s)',
    expectedCatch: 'critic',
    clean: {
      'src/cache.ts': `/** Time-to-live for a cached entry, in seconds. Default: 30. */\nexport function ttlSeconds(override?: number): number {\n  return override ?? 30\n}\n`,
    },
    defective: {
      'src/cache.ts': `/** Time-to-live for a cached entry, in seconds. Default: 30. */\nexport function ttlSeconds(override?: number): number {\n  return override ?? 3600\n}\n`,
    },
    test: { 'src/cache.test.ts': `import { expect, test } from 'bun:test'\nimport { ttlSeconds } from './cache.ts'\ntest('an override is respected', () => {\n  expect(ttlSeconds(10)).toBe(10)\n})\n` },
  },
  {
    id: 'judgment-missing-authz',
    regime: 'judgment',
    summary: 'a handler drops its ownership check; it compiles and the happy-path test still passes',
    expectedCatch: 'critic',
    clean: {
      'src/handler.ts': `interface Ctx { userId: string }\ninterface Doc { ownerId: string; body: string }\nexport function readDoc(ctx: Ctx, doc: Doc): string {\n  if (doc.ownerId !== ctx.userId) throw new Error('forbidden')\n  return doc.body\n}\n`,
    },
    defective: {
      'src/handler.ts': `interface Ctx { userId: string }\ninterface Doc { ownerId: string; body: string }\nexport function readDoc(ctx: Ctx, doc: Doc): string {\n  return doc.body\n}\n`,
    },
    test: { 'src/handler.test.ts': `import { expect, test } from 'bun:test'\nimport { readDoc } from './handler.ts'\ntest('owner can read their doc', () => {\n  expect(readDoc({ userId: 'u1' }, { ownerId: 'u1', body: 'hi' })).toBe('hi')\n})\n` },
  },
]

/**
 * Best-effort annotation: how often each defect's failure shape actually turned
 * up in this project's own run history. It does not add defects — it weights the
 * corpus toward the mistakes elia has really made here, and flags when the
 * seeded corpus has drifted from reality.
 */
export function annotateWithHistory(corpus: PlantedDefect[], cwd = process.cwd()): PlantedDefect[] {
  const signatures = readHistorySignatures(cwd)
  if (signatures.length === 0) return corpus
  return corpus.map((defect) => {
    const hay = `${defect.id} ${defect.summary}`.toLowerCase()
    const hits = signatures.filter((sig) => overlaps(hay, sig)).length
    return hits > 0 ? { ...defect, observedInHistory: hits } : defect
  })
}

function readHistorySignatures(cwd: string): string[] {
  const out: string[] = []
  const outcomes = join(cwd, '.elia', 'outcomes.jsonl')
  if (existsSync(outcomes)) {
    for (const line of safeLines(outcomes)) {
      try {
        const row = JSON.parse(line) as { toolErrors?: unknown; domains?: unknown }
        if (typeof row.toolErrors === 'number' && row.toolErrors > 0 && Array.isArray(row.domains)) {
          out.push(row.domains.join(' ').toLowerCase())
        }
      } catch {
        // skip
      }
    }
  }
  const lessons = join(cwd, '.elia', 'lessons.md')
  if (existsSync(lessons)) {
    for (const line of safeLines(lessons)) {
      if (line.trimStart().startsWith('- ')) out.push(line.toLowerCase())
    }
  }
  return out
}

function overlaps(a: string, b: string): boolean {
  const words = new Set(a.split(/\W+/).filter((w) => w.length > 3))
  return b.split(/\W+/).some((w) => w.length > 3 && words.has(w))
}

function safeLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}
