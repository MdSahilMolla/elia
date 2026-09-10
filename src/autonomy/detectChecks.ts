import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PROJECT_MARKERS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'pytest.ini', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Makefile']

/**
 * Where to run the checks, or `undefined` when nothing owns these changes.
 *
 * The agent's changes may be entirely inside a sub-project it scaffolded
 * (workspace/my-app) — running elia's own `bun test` there would verify the
 * wrong thing. This walks up from the changed files to the nearest directory
 * with a project marker.
 *
 * It used to fall back to the repo root when no marker was found at all. That
 * is the freshly-scaffolded case — a folder with an index.html and no manifest
 * yet — and the fallback handed back the *host* repo, so `detectChecks` then
 * returned elia's own `bun run typecheck && bun test src/` and ran it against a
 * three-file static page. Returning `undefined` says the honest thing instead:
 * no project owns this change, so there is no check to run and the caller must
 * not claim the work was verified. Changes inside a real project (including the
 * host repo's own source) still resolve to that project's root, because a
 * marker *is* found there.
 */
export function checkRoot(changedPaths: string[], repoRoot = process.cwd()): string | undefined {
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
  // No project marker above any changed file — nothing here is a project.
  if (dirs.size === 0) return undefined
  // If every change sits under one sub-project, check there.
  const nonRoot = [...dirs].filter((dir) => resolve(dir) !== resolve(repoRoot))
  if (nonRoot.length === 1 && dirs.size === 1) return nonRoot[0]!
  // Otherwise the repo root — but only if its checks actually reach these files.
  return repoRootCovers(repoRoot, changedPaths) ? repoRoot : undefined
}

/**
 * Whether the repo root's own checks would actually exercise `changedPaths`.
 *
 * Falling back to the repo root unconditionally is what made elia run its own
 * `bun run typecheck && bun test src/` against a three-file static page: the
 * upward walk from `<repo>/portfolio-demo/index.html` finds the *host*
 * `package.json`, because every path inside the checkout is under it. Those
 * commands never touch `portfolio-demo/`, so "they passed" said nothing about
 * the change — and when they failed, they failed for reasons the change had
 * nothing to do with.
 *
 * The distinguishing fact is coverage, not location: a project's checks name
 * the directories they cover, in the check scripts themselves (`bun test src/`)
 * and in `tsconfig.json`'s `include`. A change under a top-level directory that
 * no check mentions is a separate deliverable that happens to live inside the
 * checkout. Changes to the project's own source still resolve normally, which
 * is what keeps elia able to verify work on itself.
 *
 * Conservative by construction: when a project declares no paths at all, its
 * checks are assumed to cover the whole tree, which is the old behaviour.
 */
function repoRootCovers(repoRoot: string, changedPaths: string[]): boolean {
  const declared = declaredPaths(repoRoot)
  if (declared.size === 0) return true
  return changedPaths.some((path) => {
    const rel = relative(repoRoot, isAbsolute(path) ? path : resolve(repoRoot, path))
    if (!rel || rel.startsWith('..')) return false
    const top = rel.split(sep)[0]
    return top !== undefined && declared.has(top.toLowerCase())
  })
}

/** Top-level directory names the root project's checks and tsconfig say they cover. */
function declaredPaths(repoRoot: string): Set<string> {
  const names = new Set<string>()
  const add = (text: string): void => {
    for (const match of text.matchAll(/(?:^|[\s"'([])\.?\/?([A-Za-z0-9_.-]+)\//g)) {
      const name = match[1]
      if (name && name !== '.' && name !== '..') names.add(name.toLowerCase())
    }
  }

  const pkg = readPackageJson(repoRoot)
  for (const script of Object.values(pkg?.scripts ?? {})) add(script)

  try {
    const tsconfig = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8')
    for (const match of tsconfig.matchAll(/"(?:include|files)"\s*:\s*\[([^\]]*)\]/g)) add(match[1] ?? '')
  } catch {
    // No tsconfig, or unreadable — the scripts alone decide.
  }
  return names
}

/** The HTML pages among `paths` — a static deliverable verifies by rendering, not by a test command. */
export function changedStaticPages(paths: string[]): string[] {
  return paths.filter((path) => /\.html?$/i.test(path))
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

  // JVM. A Gradle wrapper is the project's own pinned Gradle; prefer it over a
  // system `gradle` that may be the wrong version. `build` already runs `test`
  // plus compilation, which is exactly the gate we want.
  if (existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts')) || existsSync(join(cwd, 'settings.gradle')) || existsSync(join(cwd, 'settings.gradle.kts'))) {
    const wrapper = existsSync(join(cwd, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))
    return [wrapper ? `${process.platform === 'win32' ? 'gradlew.bat' : './gradlew'} build` : 'gradle build']
  }
  if (existsSync(join(cwd, 'pom.xml'))) return ['mvn -q -B test']

  // C / C++. Build systems vary and a configure step may be needed, so this is
  // best-effort: a plain `make` or, for CMake, whatever the conventional
  // `build/` tree already has configured. clangd carries the rest via
  // per-edit diagnostics.
  if (existsSync(join(cwd, 'CMakeLists.txt'))) {
    return existsSync(join(cwd, 'build')) ? ['cmake --build build'] : ['cmake -B build', 'cmake --build build']
  }
  if (existsSync(join(cwd, 'Makefile')) || existsSync(join(cwd, 'makefile'))) return ['make']

  return []
}

/**
 * How much a "the change is fine" verdict is actually worth.
 *
 * Not every domain lets a machine check the answer. Typecheck-and-test is a
 * mechanical proof; a rendered static page is an empirical one you can eyeball;
 * a change with no runnable check at all rests on someone's judgement. The
 * self-improvement loops must know which of these they are standing on, because
 * a `judgment`-regime pass is the closed loop where a reasoner talks itself into
 * being confidently wrong — nothing outside its own opinion said otherwise. Such
 * an outcome may inform this session but must never become durable cross-run
 * knowledge or training signal.
 */
export type VerificationRegime = 'mechanical' | 'empirical' | 'judgment'

/** A command that would actually exercise the code — a type/compile gate or a test run. */
const MECHANICAL_CMD =
  /(^|\s)(tsc|typecheck|type-check|check-types|test|tests|test:unit|pytest|mypy|jest|vitest|mocha|clippy)(\s|$|:|&|")|cargo\s+(check|test|build|clippy)|go\s+(build|test|vet)|(^|\s)mvn(\s|$)|gradlew?\b|cmake\b|(^|\s)make(\s|$)/i

function anyMechanical(commands: string[]): boolean {
  return commands.some((command) => MECHANICAL_CMD.test(command))
}

/**
 * Classifies the strongest verification available for a set of changed files.
 *
 * `explicitCommands` is the proposal's own declared verification (autonomous
 * runs have this; the interactive loop does not). When absent, the regime is
 * inferred from the repo the same way `detectChecks` infers commands.
 */
export function classifyRegime(
  changedPaths: string[],
  explicitCommands: string[] = [],
  repoRoot = process.cwd(),
): VerificationRegime {
  if (explicitCommands.length > 0 && anyMechanical(explicitCommands)) return 'mechanical'

  const root = checkRoot(changedPaths, repoRoot)
  if (root) {
    const checks = detectChecks(root)
    if (anyMechanical(checks)) return 'mechanical'
    if (checks.length > 0) return 'empirical'
  }

  const staticPages = changedStaticPages(changedPaths)
  const codeFiles = changedCodeFiles(changedPaths)
  if (staticPages.length > 0 && codeFiles.length === 0) return 'empirical'

  return 'judgment'
}

/** The weaker of two regimes — used when several signals disagree; the floor wins. */
export function weakestRegime(regimes: VerificationRegime[]): VerificationRegime {
  const rank: Record<VerificationRegime, number> = { judgment: 0, empirical: 1, mechanical: 2 }
  return regimes.reduce<VerificationRegime>(
    (weakest, regime) => (rank[regime] < rank[weakest] ? regime : weakest),
    'mechanical',
  )
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
