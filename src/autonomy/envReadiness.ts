/**
 * Declared-vs-available environment assessment.
 *
 * The `environment` tool reports what runtimes are *present*. This adds the
 * other half: what the project *declares* it needs (a Node version pin, a
 * lockfile, a compose file, a devcontainer, a nix shell) and where that does
 * not line up with the machine the run is on.
 *
 * The point is to surface a broken environment during the orient phase — one
 * cheap read of the tree — instead of after a run has spent its repair budget
 * discovering that `node_modules` was never installed.
 *
 * This module only reads. It produces suggested setup commands; running them is
 * a governed step the planner adds, not something this does.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface EnvBlocker {
  /** Short label of the unmet requirement. */
  what: string
  /** Why it will likely strand the run. */
  because: string
  /** A suggested command that resolves it, if there is a clear one. */
  fix?: string
}

export interface EnvironmentAssessment {
  /** No blockers found. Warnings may still be present. */
  ready: boolean
  /** Human-readable list of what the project expects (for the orient agent). */
  declared: string[]
  /** Must be resolved or the run will probably fail on something unrelated to the change. */
  blockers: EnvBlocker[]
  /** Probably fine, but worth the planner knowing. */
  warnings: string[]
  /** Ordered, de-duplicated setup commands the planner can turn into a step. */
  setup: string[]
}

interface Ctx {
  cwd: string
  /** `name -> present`, from `Bun.which` in the caller. */
  has: (cmd: string) => boolean
  /** `node --version` output, `python3 --version`, etc., when the caller has them. */
  versions: Record<string, string>
}

function fileExists(cwd: string, ...names: string[]): string | undefined {
  return names.map((n) => join(cwd, n)).find((p) => existsSync(p))
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** `node_modules` exists and looks populated (more than a couple of entries). */
function nodeModulesInstalled(cwd: string): boolean {
  const dir = join(cwd, 'node_modules')
  if (!existsSync(dir)) return false
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 3
  } catch {
    return false
  }
}

function detectPackageManager(cwd: string): { name: 'bun' | 'pnpm' | 'yarn' | 'npm'; lockfile: string } | undefined {
  if (fileExists(cwd, 'bun.lock', 'bun.lockb')) return { name: 'bun', lockfile: 'bun.lock' }
  if (fileExists(cwd, 'pnpm-lock.yaml')) return { name: 'pnpm', lockfile: 'pnpm-lock.yaml' }
  if (fileExists(cwd, 'yarn.lock')) return { name: 'yarn', lockfile: 'yarn.lock' }
  if (fileExists(cwd, 'package-lock.json')) return { name: 'npm', lockfile: 'package-lock.json' }
  return undefined
}

function installCommand(pm: 'bun' | 'pnpm' | 'yarn' | 'npm'): string {
  switch (pm) {
    case 'bun': return 'bun install'
    case 'pnpm': return 'pnpm install --frozen-lockfile'
    case 'yarn': return 'yarn install --immutable'
    case 'npm': return 'npm ci'
  }
}

/** Parse a version pin like "20", "v20.11.0", "lts/iron" to a major number. */
function majorFromPin(raw: string): number | undefined {
  const trimmed = raw.trim().replace(/^v/, '')
  const m = trimmed.match(/^(\d+)/)
  return m ? Number(m[1]) : undefined
}

function majorFromVersionOutput(out: string | undefined): number | undefined {
  if (!out) return undefined
  const m = out.match(/(\d+)\.\d+/)
  return m ? Number(m[1]) : undefined
}

export function assessEnvironment(ctx: Ctx): EnvironmentAssessment {
  const { cwd, has, versions } = ctx
  const declared: string[] = []
  const blockers: EnvBlocker[] = []
  const warnings: string[] = []
  const setup: string[] = []
  const addSetup = (cmd: string) => {
    if (!setup.includes(cmd)) setup.push(cmd)
  }

  // --- Node / JS toolchain ---
  const pkgPath = fileExists(cwd, 'package.json')
  if (pkgPath) {
    const pkg = ((): { engines?: Record<string, string> } => {
      try {
        return JSON.parse(read(pkgPath) ?? '{}')
      } catch {
        return {}
      }
    })()

    const pm = detectPackageManager(cwd)
    if (pm) {
      declared.push(`JS dependencies (${pm.name}, ${pm.lockfile})`)
      if (!nodeModulesInstalled(cwd)) {
        blockers.push({
          what: 'JS dependencies are not installed',
          because: `${pm.lockfile} is present but node_modules is missing or empty — imports, typecheck, and tests will fail immediately.`,
          fix: installCommand(pm.name),
        })
        addSetup(installCommand(pm.name))
      }
      if (!has(pm.name) && pm.name !== 'npm') {
        blockers.push({
          what: `the ${pm.name} package manager is not on PATH`,
          because: `the project pins ${pm.name} via ${pm.lockfile}; another manager would resolve different versions.`,
          fix: pm.name === 'bun' ? 'curl -fsSL https://bun.sh/install | bash' : `npm i -g ${pm.name}`,
        })
      }
    }

    const nodePin = fileExists(cwd, '.nvmrc', '.node-version')
    const pinnedMajor = nodePin ? majorFromPin(read(nodePin) ?? '') : majorFromPin(pkg.engines?.node ?? '')
    if (pinnedMajor !== undefined) {
      declared.push(`Node ${pinnedMajor}.x`)
      const actual = majorFromVersionOutput(versions.node)
      if (actual !== undefined && actual !== pinnedMajor) {
        ;(Math.abs(actual - pinnedMajor) >= 1 ? blockers : ([] as EnvBlocker[])).push({
          what: `Node ${actual} is active, the project pins ${pinnedMajor}`,
          because: 'a major Node mismatch changes API behaviour and native-module ABIs; test failures may be environmental, not real.',
          fix: `use a Node version manager to switch to ${pinnedMajor} (nvm use ${pinnedMajor} / fnm use ${pinnedMajor})`,
        })
        if (Math.abs(actual - pinnedMajor) < 1) {
          warnings.push(`Node ${actual} is active; the project pins ${pinnedMajor} (minor mismatch — usually fine).`)
        }
      } else if (actual === undefined && !has('node') && !has('bun')) {
        blockers.push({ what: 'no Node or Bun runtime on PATH', because: 'a JS project cannot run without one.' })
      }
    }
  }

  // --- Python ---
  const pyDeps = fileExists(cwd, 'requirements.txt', 'pyproject.toml', 'Pipfile')
  if (pyDeps) {
    declared.push('Python dependencies')
    if (!has('python3') && !has('python')) {
      blockers.push({ what: 'no Python runtime on PATH', because: 'the project has Python dependencies but no interpreter to run them.' })
    } else {
      const hasVenv = existsSync(join(cwd, '.venv')) || existsSync(join(cwd, 'venv')) || Boolean(process.env.VIRTUAL_ENV)
      if (!hasVenv) {
        const cmd = fileExists(cwd, 'poetry.lock')
          ? 'poetry install'
          : fileExists(cwd, 'uv.lock')
            ? 'uv sync'
            : fileExists(cwd, 'Pipfile.lock')
              ? 'pipenv install --dev'
              : existsSync(join(cwd, 'requirements.txt'))
                ? 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
                : 'pip install -e .'
        warnings.push('No virtualenv detected — Python dependencies may not be installed for this project.')
        addSetup(cmd)
      }
    }
    const pyPin = fileExists(cwd, '.python-version', 'runtime.txt')
    if (pyPin) declared.push(`Python ${(read(pyPin) ?? '').trim().split('\n')[0]}`)
  }

  // --- Other language toolchains ---
  if (fileExists(cwd, 'go.mod')) {
    declared.push('Go module')
    if (!has('go')) blockers.push({ what: 'the Go toolchain is not on PATH', because: 'a go.mod project cannot build or test without it.' })
  }
  if (fileExists(cwd, 'Cargo.toml')) {
    declared.push('Rust crate')
    if (!has('cargo')) blockers.push({ what: 'the Rust toolchain is not on PATH', because: 'a Cargo project cannot build or test without it.', fix: 'https://rustup.rs' })
  }
  if (fileExists(cwd, 'Gemfile')) {
    declared.push('Ruby bundle')
    if (!has('ruby') && !has('bundle')) {
      blockers.push({ what: 'Ruby / Bundler is not on PATH', because: 'a Gemfile project needs them.' })
    } else if (fileExists(cwd, 'Gemfile.lock')) {
      addSetup('bundle install')
    }
  }

  // --- Containers / declared dev environments ---
  const compose = fileExists(cwd, 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml')
  if (compose) {
    const services = (read(compose) ?? '').match(/^\s{2}([a-z0-9_-]+):/gim)?.map((s) => s.trim().replace(/:$/, '')) ?? []
    declared.push(`Docker Compose${services.length ? ` (${services.join(', ')})` : ''}`)
    if (!has('docker')) {
      blockers.push({ what: 'Docker is not on PATH', because: 'the project defines services in a compose file that the app or its tests likely depend on.' })
    } else {
      warnings.push(`A compose file defines ${services.length || 'some'} service(s); confirm they are up (\`docker compose ps\`) before relying on the app or integration tests.`)
      addSetup('docker compose up -d')
    }
  }
  const devcontainer = fileExists(cwd, '.devcontainer/devcontainer.json', '.devcontainer.json')
  if (devcontainer) {
    declared.push('Dev Container')
    const spec = read(devcontainer) ?? ''
    const post = spec.match(/"postCreateCommand"\s*:\s*"([^"]+)"/)?.[1]
    warnings.push(
      `This project ships a devcontainer; the run is on the host, not inside it${post ? ` — its postCreateCommand is: ${post}` : ''}. Host tool versions may differ from the container's.`,
    )
    if (post) addSetup(post)
  }
  const nix = fileExists(cwd, 'flake.nix', 'shell.nix', 'default.nix')
  if (nix) {
    declared.push('Nix environment')
    if (!has('nix')) {
      warnings.push('This project has a Nix environment file but `nix` is not on PATH; tool versions will not match the flake.')
    } else {
      warnings.push('This project has a Nix environment; commands may need to run inside `nix develop` / `nix-shell`.')
    }
  }

  // --- Config ---
  if (fileExists(cwd, '.env.example') && !fileExists(cwd, '.env') && !fileExists(cwd, '.env.local')) {
    warnings.push('.env.example is present but no .env — the app likely needs configuration values before it will start.')
  }

  // --- Makefile setup target ---
  const makefile = fileExists(cwd, 'Makefile', 'makefile')
  if (makefile) {
    const target = (read(makefile) ?? '').match(/^(setup|bootstrap|init|install|dev-setup):/m)?.[1]
    if (target) {
      declared.push(`Makefile \`${target}\` target`)
      addSetup(`make ${target}`)
    }
  }

  return { ready: blockers.length === 0, declared, blockers, warnings, setup }
}

/** A compact block for the orient agent's context. */
export function formatEnvironmentAssessment(a: EnvironmentAssessment): string {
  const lines: string[] = []
  if (a.declared.length) lines.push(`Project declares: ${a.declared.join(' · ')}`)
  if (a.blockers.length) {
    lines.push('BLOCKERS (resolve before the run relies on the environment):')
    for (const b of a.blockers) lines.push(`  - ${b.what} — ${b.because}${b.fix ? ` [fix: ${b.fix}]` : ''}`)
  }
  if (a.warnings.length) {
    lines.push('Warnings:')
    for (const w of a.warnings) lines.push(`  - ${w}`)
  }
  if (a.setup.length) lines.push(`Suggested setup (add a governed step if the plan needs it): ${a.setup.join(' && ')}`)
  if (lines.length === 0) return 'Environment readiness: nothing the project declares is missing.'
  return lines.join('\n')
}
