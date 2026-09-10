// Reusable fixture project for architecture engine tests. Creates a throwaway
// TypeScript project on disk that the native compiler can open.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePath } from './parser.ts'

export interface Fixture {
  root: string
  /** Posix-normalized absolute path of the project root. */
  rootNorm: string
  tsconfig: string
}

export interface FixtureOptions {
  /** tsconfig `include` globs (defaults to `['src']`). */
  include?: string[]
  /** Merge the shared base FILES (app/core/cycles) on top of the extras. */
  includeBase?: boolean
}

const FILES: Record<string, string> = {
  'src/app.ts': `import { a } from './core/types'
import type { T } from './core/types'
import * as ns from './core/util'
import plugin from 'plugin-pkg'
export { plus } from './core/util'

export function run(): a {
  void ns
  void plugin
  void T
  return 0
}
`,
  'src/core/types.ts': `export interface T {
  value: number
}
export const a = 1
`,
  'src/core/util.ts': `import type { T } from './types'
export function plus(x: number, y: number): number {
  const t: T = { value: x + y }
  return t.value
}
export const answer = 42
`,
  'src/alpha.ts': `import { beta } from './beta'
export const alpha = beta
`,
  'src/beta.ts': `import { alpha } from './alpha'
export const beta = alpha
`,
  'src/self.ts': `import { SELF } from './self'
export const SELF = 1
export { SELF }
`,
  'src/dyn.ts': `export async function load(): Promise<number> {
  const m = await import('./core/types')
  return m.a
}
`,
  'src/mix.ts': `export type { T } from './core/types'
`,
  'src/index.ts': `export * from './core/types'
export * as util from './core/util'
`,
  'src/app.spec.ts': `import { run } from './app'
export const expected = typeof run
`,
}

export const TS_CONFIG = {
  compilerOptions: {
    strict: true,
    target: 'ESNext',
    module: 'Preserve',
    moduleResolution: 'Bundler',
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ['src'],
}

/**
 * Create a temporary fixture project. The caller receives the root and should
 * remove it with {@link cleanupFixture} when done.
 */
export function createFixture(
  baseDir: string,
  extraFiles: Record<string, string> = {},
  options: FixtureOptions = {},
): Fixture {
  rmSync(baseDir, { recursive: true, force: true })
  mkdirSync(baseDir, { recursive: true })
  const include = options.include ?? ['src']
  writeFileSync(
    join(baseDir, 'tsconfig.json'),
    JSON.stringify({ ...TS_CONFIG, include }, null, 2),
  )
  const base = options.includeBase ?? true ? FILES : {}
  const all = { ...base, ...extraFiles }
  for (const [rel, content] of Object.entries(all)) {
    const abs = join(baseDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return {
    root: baseDir,
    rootNorm: normalizePath(baseDir),
    tsconfig: normalizePath(join(baseDir, 'tsconfig.json')),
  }
}

export function cleanupFixture(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true })
}