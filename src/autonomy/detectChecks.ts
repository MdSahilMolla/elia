import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const PROJECT_MARKERS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pytest.ini']

/**
 * Where to run the checks. The agent's changes may be entirely inside a
 * sub-project it scaffolded (workspace/my-app) — running elia's own `bun test`
 * there would verify the wrong thing. This walks up from the changed files to
 * the nearest directory with a project marker, falling back to the repo root.
 */
export function checkRoot(changedPaths: string[], repoRoot = process.cwd()): string {
  const dirs = new Set<string>()
  for (const path of changedPaths) {
    let dir = dirname(isAbsolute(path) ? path : resolve(repoRoot, path))
    // Walk up until a project marker or the repo root.
    for (let i = 0; i < 8 && dir.startsWith(repoRoot); i += 1) {
      if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) {
        dirs.add(dir)
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // If every change sits under one sub-project, check there; otherwise the repo root.
  const nonRoot = [...dirs].filter((dir) => resolve(dir) !== resolve(repoRoot))
  if (nonRoot.length === 1 && dirs.size === 1) return nonRoot[0]!
  return repoRoot
}

/**
 * Infers the commands that prove a change didn't break the project — the same
 * gate a careful engineer runs before saying "done": typecheck, then tests.
 *
 * `elia auto` gets these from its own proposal. The interactive loop has no
 * proposal, so it has to work them out from the repo: package.json scripts
 * first (the project's own declared checks), then language markers.
 *
 * Deliberately conservative — a build or a full e2e run is too slow and too
 * flaky to gate every turn on. Typecheck + unit tests is the sweet spot.
 */

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|swift|kt)$/i

export function changedCodeFiles(paths: string[]): string[] {
  return paths.filter((path) => CODE_EXT.test(path))
}

interface PackageJson {
  scripts?: Record<string, string>
  packageManager?: string
}

function readPackageJson(cwd: string): PackageJson | undefined {
  const path = join(cwd, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
  } catch {
    return undefined
  }
}

type PkgManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

function packageManager(cwd: string, pkg: PackageJson | undefined): PkgManager {
  if (pkg?.packageManager?.startsWith('bun') || existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  if (pkg?.packageManager?.startsWith('pnpm') || existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (pkg?.packageManager?.startsWith('yarn') || existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** `bun run <s>` / `pnpm <s>` / `yarn <s>` / `npm run <s>`, with the `test` shorthand where it exists. */
function scriptCmd(pm: PkgManager, script: string): string {
  if (script === 'test') return pm === 'npm' || pm === 'yarn' || pm === 'pnpm' ? `${pm} test` : 'bun run test'
  if (pm === 'npm' || pm === 'bun') return `${pm} run ${script}`
  return `${pm} ${script}`
}

/**
 * Returns check commands in the order they should run (fail-fast): a type/compile
 * gate first, then tests. Empty when nothing reliable can be inferred — in which
 * case the caller must NOT claim the change is verified.
 */
export function detectChecks(cwd: string = process.cwd()): string[] {
  const checks: string[] = []
  const pkg = readPackageJson(cwd)

  if (pkg?.scripts) {
    const pm = packageManager(cwd, pkg)
    const scripts = pkg.scripts

    const typecheckScript = ['typecheck', 'type-check', 'tsc', 'check-types'].find((name) => scripts[name])
    if (typecheckScript) checks.push(scriptCmd(pm, typecheckScript))

    const testScript = ['test', 'test:unit', 'tests'].find((name) => scripts[name] && !/(?:^|\s)(?:--)?watch\b/.test(scripts[name]!))
    if (testScript) checks.push(scriptCmd(pm, testScript))
    return dedupe(checks)
  }

  // Non-Node projects.
  if (existsSync(join(cwd, 'Cargo.toml'))) return ['cargo check', 'cargo test']
  if (existsSync(join(cwd, 'go.mod'))) return ['go build ./...', 'go test ./...']
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'setup.cfg'))) {
    return existsSync(join(cwd, 'mypy.ini')) || hasMypyConfig(cwd) ? ['mypy .', 'pytest -q'] : ['pytest -q']
  }

  return []
}

function hasMypyConfig(cwd: string): boolean {
  const pyproject = join(cwd, 'pyproject.toml')
  if (!existsSync(pyproject)) return false
  try {
    return readFileSync(pyproject, 'utf8').includes('[tool.mypy]')
  } catch {
    return false
  }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}
