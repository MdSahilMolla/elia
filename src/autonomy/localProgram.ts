import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPathWithinWorkspace, resolveProjectPath, resolveWorkspacePath } from './context.ts'
import { isSensitivePath } from './sensitivePaths.ts'

/**
 * Running the project's own program: `node bin/notes.js list`, `python
 * tools/report.py`, `./scripts/check.sh`, `npm run notes -- add "x"`.
 *
 * Everything off the read-only list used to fall through to `shell.unknown`,
 * so a CLI the agent had just built could not be run to check it: the
 * autonomous session asked "Run this command?" after every step was done, and
 * an unattended run refused it outright (seen live 2026-09-28, a tiny notes
 * CLI whose plan verified with `node bin/notes.js add "Test note"`). `bun test`
 * and `npm run build` already run the project's own code unasked; this is the
 * same trust for the project's own entry points, and nothing wider.
 *
 * What makes a run "local" is decided here from the words the program
 * receives and the directory it runs in — never from the command text alone:
 *
 *   - the program is a file inside the workspace after every symlink is
 *     resolved, a regular file, not inside a dependency tree (`node_modules`,
 *     a Python virtualenv, `.git`, …) and not a protected path;
 *   - an interpreter gets that file as its first word — any flag before it
 *     (`-e`, `-c`, `--require`, `--inspect`, `-m`) is refused, because those
 *     evaluate code or load modules the file check never saw;
 *   - a package-manager script must be defined in the package.json of the
 *     directory it runs in; its body, with the `pre`/`post` hooks the manager
 *     also runs, is handed back to the caller to classify like any command;
 *   - every argument stays local: no URL, no `~`, no `..`, no absolute path
 *     outside the workspace, no protected path.
 *
 * The governor asks this only after every other shell gate has passed (control
 * syntax, sensitive reads, network egress, installs, remote execution,
 * CRITICAL_COMMAND), so none of those can be reached through it.
 */

export interface ProgramInvocation {
  /** The words the program receives, the program itself first. */
  argv: readonly string[]
  /** The canonical directory it runs in. */
  cwd: string
}

export type LocalProgram =
  | { kind: 'file'; path: string }
  | { kind: 'script'; name: string; manifest: string; bodies: Array<{ command: string; argv: string[] | undefined }> }

/** An interpreter, and the script extensions it is trusted to run as a file. */
const INTERPRETERS: ReadonlyArray<readonly [program: RegExp, script: RegExp]> = [
  [/^(?:node|bun)(?:\.exe)?$/i, /\.(?:[cm]?[jt]s|[jt]sx)$/i],
  [/^(?:python3?|py)(?:\.exe)?$/i, /\.py$/i],
  [/^(?:ba)?sh$/i, /\.sh$/i],
]
const JS_SCRIPT = INTERPRETERS[0]![1]
const PACKAGE_MANAGER = /^(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?$/i

/**
 * Directories whose files are someone else's program, not the project's:
 * installed packages and their launchers (`node_modules/.bin/prisma db push`
 * reaches a live database), vendored trees, and git internals.
 */
const DEPENDENCY_DIRECTORIES = new Set(['node_modules', 'bower_components', 'jspm_packages', '.yarn', '.pnpm-store', 'vendor', 'site-packages', 'dist-packages', '__pypackages__', '.git'])

/** Script nesting followed through package.json (`"a": "npm run b"`). */
export const MAX_SCRIPT_DEPTH = 2

/**
 * The words a shell passes for `command`, or undefined when that is not
 * certain from the text alone. POSIX `sh`: single and double quotes group;
 * a backslash, glob, brace, tilde, subshell or leading `#` is refused rather
 * than modelled. cmd.exe: double quotes group, backslashes are separators, and
 * `%`/`!` expansion, `^` escapes and parentheses are refused. Control syntax
 * (`;&|<>$` and backticks) never gets here — the governor rejects it first.
 */
export function shellWords(command: string, platform: NodeJS.Platform = process.platform): string[] | undefined {
  const windows = platform === 'win32'
  if (windows && /[%!^()]|\\"/.test(command)) return undefined
  const words: string[] = []
  let current = ''
  let quoted = false
  let quote: string | undefined
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else if (!windows && quote === '"' && /[\\`$]/.test(char)) return undefined
      else current += char
      continue
    }
    if (char === '"' || (!windows && char === "'")) {
      quote = char
      quoted = true
      continue
    }
    if (/\s/.test(char)) {
      if (current || quoted) words.push(current)
      current = ''
      quoted = false
      continue
    }
    if (!windows && (/[\\*?[\]{}~()]/.test(char) || (char === '#' && !current && !quoted))) return undefined
    current += char
  }
  if (quote) return undefined
  if (current || quoted) words.push(current)
  return words
}

/** A shell command line as the program it runs; undefined when its words or directory are uncertain. */
export function shellInvocation(command: unknown, rawCwd: unknown, root: string, platform: NodeJS.Platform = process.platform): ProgramInvocation | undefined {
  if (typeof command !== 'string') return undefined
  const argv = shellWords(command, platform)
  const cwd = runDirectory(rawCwd, root)
  return argv && cwd ? { argv, cwd } : undefined
}

/** A literal argv (run_program: no shell reparses it). */
export function argvInvocation(argv: readonly string[], rawCwd: unknown, root: string): ProgramInvocation | undefined {
  const cwd = runDirectory(rawCwd, root)
  return cwd ? { argv, cwd } : undefined
}

/**
 * The directory run_command, run_program and `process start` run in for this
 * `cwd` input — resolved exactly as they resolve it (resolveProjectPath), so
 * the file checked is the file that runs.
 */
function runDirectory(rawCwd: unknown, root: string): string | undefined {
  try {
    const dir = typeof rawCwd === 'string' && rawCwd.trim() ? resolveProjectPath(rawCwd, root) : resolveWorkspacePath('.', root)
    return statSync(dir).isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}

/**
 * What `invocation` runs when it is the project's own program inside `root`,
 * or undefined. `planning` accepts a script that does not exist yet — a plan
 * names the program it is about to write — as long as it would land inside
 * the workspace; at run time the file must exist.
 */
export function localProgram(
  invocation: ProgramInvocation,
  root: string,
  options: { planning?: boolean; platform?: NodeJS.Platform } = {},
): LocalProgram | undefined {
  const [program = '', ...args] = invocation.argv
  const planning = options.planning === true
  if (!program || program.includes('=')) return undefined
  if (PACKAGE_MANAGER.test(program) && (args[0] === 'run' || args[0] === 'start')) {
    return packageScript(program, args, root, invocation.cwd, planning)
  }
  const interpreter = INTERPRETERS.find(([name]) => name.test(program))
  if (interpreter) {
    const [script = '', ...rest] = args
    if (!interpreter[1].test(script)) return undefined
    const path = workspaceFile(script, root, invocation.cwd, planning)
    return path && rest.every((arg) => staysLocal(arg, root)) ? { kind: 'file', path } : undefined
  }
  // `sh` runs a word containing a slash as that file, never through PATH.
  // cmd.exe reads `/` as a switch and resolves bare names through PATHEXT and
  // the current directory, so on Windows only the interpreter forms apply. A
  // copy of an interpreter or package manager (`./node -e …`) is not the
  // project's program, whatever directory it was copied into.
  const base = program.split('/').pop() ?? ''
  if (INTERPRETERS.some(([name]) => name.test(base)) || PACKAGE_MANAGER.test(base)) return undefined
  if ((options.platform ?? process.platform) !== 'win32' && program.includes('/')) {
    const path = workspaceFile(program, root, invocation.cwd, planning)
    return path && args.every((arg) => staysLocal(arg, root)) ? { kind: 'file', path } : undefined
  }
  return undefined
}

function packageScript(program: string, args: string[], root: string, cwd: string, planning: boolean): LocalProgram | undefined {
  const start = args[0] === 'start'
  const name = start ? 'start' : args[1]
  const rest = args.slice(start ? 1 : 2)
  if (!name || name.startsWith('-')) return undefined
  // npm and pnpm read a dash word after the name as their own option unless it
  // follows `--` — and `--script-shell=…` or `--prefix=…` changes what runs.
  const separator = rest.indexOf('--')
  const before = separator === -1 ? rest : rest.slice(0, separator)
  if (before.some((word) => word.startsWith('-'))) return undefined
  const extra = separator === -1 ? rest : [...before, ...rest.slice(separator + 1)]
  if (!extra.every((arg) => staysLocal(arg, root))) return undefined

  const manifest = packageManifest(cwd, root)
  if (!manifest || !Object.hasOwn(manifest.scripts, name) || typeof manifest.scripts[name] !== 'string') {
    // `bun run bin/notes.js` runs the file when no script has that name.
    if (!start && /^bun/i.test(program) && JS_SCRIPT.test(name)) {
      const path = workspaceFile(name, root, cwd, planning)
      return path ? { kind: 'file', path } : undefined
    }
    return undefined
  }
  // The manager also runs `pre<name>` and `post<name>` when they exist; only
  // the named script receives the extra arguments.
  const bodies = [`pre${name}`, name, `post${name}`].flatMap((key) => {
    const text = Object.hasOwn(manifest.scripts, key) ? manifest.scripts[key] : undefined
    if (typeof text !== 'string') return []
    const words = shellWords(text)
    if (key !== name || extra.length === 0) return [{ command: text, argv: words }]
    return [{ command: `${text} ${extra.join(' ')}`, argv: words && [...words, ...extra] }]
  })
  return { kind: 'script', name, manifest: manifest.path, bodies }
}

function packageManifest(cwd: string, root: string): { path: string; scripts: Record<string, unknown> } | undefined {
  try {
    const file = resolveWorkspacePath(join(cwd, 'package.json'), root)
    if (!statSync(file).isFile()) return undefined
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const scripts = parsed && typeof parsed === 'object' ? (parsed as { scripts?: unknown }).scripts : undefined
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return undefined
    return { path: toPosix(relative(resolveWorkspacePath('.', root), file)), scripts: scripts as Record<string, unknown> }
  } catch {
    return undefined
  }
}

/**
 * The workspace-relative path of the program `token` names from `cwd`, when
 * it is one of the project's own files. Refuses traversal lexically (`..`, `~`)
 * and then again after canonicalising, so a symlink — the file itself or any
 * directory on the way — that leads out of the workspace is caught.
 */
function workspaceFile(token: string, root: string, cwd: string, planning: boolean): string | undefined {
  if (!token || token.startsWith('-') || token.startsWith('~') || isSensitivePath(token)) return undefined
  if (token.split(/[\\/]/).some((segment) => segment === '..' || DEPENDENCY_DIRECTORIES.has(segment.toLowerCase()))) return undefined
  let canonicalRoot: string
  let target: string
  try {
    canonicalRoot = resolveWorkspacePath('.', root)
    target = resolveWorkspacePath(resolve(cwd, token), root)
  } catch {
    return undefined
  }
  const path = relative(canonicalRoot, target)
  if (!path || path.split(sep).some((segment) => DEPENDENCY_DIRECTORIES.has(segment.toLowerCase())) || isSensitivePath(path)) return undefined
  if (insideEnvironment(dirname(target), canonicalRoot)) return undefined
  try {
    return statSync(target).isFile() ? toPosix(path) : undefined
  } catch {
    return planning && !throughDanglingLink(target, canonicalRoot) ? toPosix(path) : undefined
  }
}

/**
 * A Python virtualenv or conda environment: its `bin/pip` is a regular file
 * inside the workspace, and running it installs packages exactly as the
 * `pip install` the governor refuses would.
 */
function insideEnvironment(dir: string, root: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, 'pyvenv.cfg')) || existsSync(join(current, 'conda-meta'))) return true
    if (current === root || dirname(current) === current) return false
  }
}

/**
 * Whether a not-yet-existing path runs through a symlink whose target is
 * missing. Canonicalising resolved every link that exists, so a link left in
 * the path is dangling: it points somewhere that may be created outside the
 * workspace later, and is not a file the plan is about to write.
 */
function throughDanglingLink(target: string, root: string): boolean {
  for (let current = target; current !== root && dirname(current) !== current; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch {
      // Not there yet; nothing to follow.
    }
  }
  return false
}

/**
 * Whether an argument keeps the program inside the workspace. It is checked
 * whole, after a `--flag=` prefix, and after a glued short option (`-o/etc`).
 */
function staysLocal(arg: string, root: string): boolean {
  if (arg.includes('://')) return false
  const parts = [arg]
  if (arg.includes('=')) parts.push(arg.slice(arg.indexOf('=') + 1))
  if (/^-[A-Za-z]./.test(arg)) parts.push(arg.slice(2))
  return parts.every((part) => {
    if (part.startsWith('~') || isSensitivePath(part) || part.split(/[\\/]/).includes('..')) return false
    const absolute = isAbsolute(part) || /^[A-Za-z]:|^\\\\/.test(part)
    return !absolute || isPathWithinWorkspace(part, root)
  })
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
