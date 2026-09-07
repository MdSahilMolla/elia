// Two things a passing test suite structurally cannot catch, both seen for real
// in `elia auto` deliverables:
//
//  1. An import of a package that was never declared in package.json. Bun
//     silently auto-installs a missing package, so `bun test` goes green on a
//     project that is broken for everybody else who clones it. The test suite is
//     the wrong instrument here — the defect is in the manifest, not the code.
//  2. Exploratory scratch files (debug_test.js, tmp_check.ts) left behind in the
//     deliverable. Nothing in the loop ever asked the agent to clean up after
//     itself, so they shipped, and then got swept into the project's own test
//     glob.
//
// Both are decidable by reading the tree, so they are checked deterministically
// and folded into the review verdict as issues rather than being handed to a
// model to notice.
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { packageRoot } from './autoInstall.ts'
import type { CriticIssue, CriticVerdict } from './types.ts'

export interface HygieneInput {
  /** Root of the deliverable — where its package.json lives. */
  cwd: string
  /** Files this run created. Repo-relative or absolute. */
  addedFiles: string[]
  /** Files this run created or modified. */
  changedFiles: string[]
  /** Additional manifests that may legitimately declare a dependency (a monorepo root). */
  extraManifests?: string[]
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/i

/** Node builtins, plus the runtime prefixes that are never packages. */
const BUILTIN = new Set([...builtinModules, 'bun'])

/**
 * Import specifiers, in every form that reaches a resolver: static import and
 * re-export, `require`, and dynamic `import()`. Type-only imports count — the
 * types still have to come from a declared package.
 *
 * The static forms are anchored to the start of a line because they are
 * statements and nothing else, and because plenty of real files carry code
 * *samples* in string literals — a test that builds `"import express from
 * 'express'"` to feed a parser is not importing express. The call forms can
 * legitimately sit mid-line, so they are guarded by a quote check instead.
 */
const IMPORT_PATTERNS: { pattern: RegExp; guardStrings: boolean }[] = [
  { pattern: /^[ \t]*import\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"\n]+)['"]/gm, guardStrings: false },
  { pattern: /^[ \t]*export\s+[\w*{},\s]+\s+from\s+['"]([^'"\n]+)['"]/gm, guardStrings: false },
  { pattern: /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, guardStrings: true },
  { pattern: /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, guardStrings: true },
]

/**
 * Names whose whole point is being throwaway. The basename must *start* with
 * one of them, so a legitimate `tmpdir.ts` is safe but `tmp_check.ts` is not.
 */
const ALWAYS_SCRATCH = /^(?:debug|tmp|temp|scratch|untitled|foo|bar|baz|asdf|qux)(?:[-_.][\w-]+)*\.(?:[cm]?[jt]sx?|py|rb|go|sh|json|txt|log|md)$/i

/**
 * Ambiguous stems — `run.ts` and `manual.ts` are perfectly ordinary names — so
 * these only count as scratch when a second throwaway marker follows.
 */
const MARKED_SCRATCH = /^(?:manual|run|quick|my|new|old|final|copy)[-_.](?:test|check|debug|tmp|temp|scratch)[\w-]*\.(?:[cm]?[jt]sx?|py|rb|go|sh)$/i

/** Extensions that are output, never source. */
const SCRATCH_EXT = /\.(?:log|tmp|bak|orig|rej|swp|swo)$/i

/**
 * A directory that announces its contents are throwaway. The basename alone can
 * look perfectly ordinary — a run left `tmp/check.js` behind, and `check.js`
 * matches nothing suspicious until you notice where it lives.
 */
const SCRATCH_DIR = /(?:^|[\/])(?:tmp|temp|scratch|junk|playground|sandbox)[\/]/i

/**
 * Credentials with a recognisable shape. A match here is a real key, not a
 * guess: these prefixes and lengths are issuer formats, so a false positive
 * would have to be a deliberately constructed lookalike.
 */
const KNOWN_KEY_FORMATS: { name: string; pattern: RegExp }[] = [
  { name: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'an OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'a GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{16,}/ },
  { name: 'a private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
]

/**
 * `const JWT_SECRET = "supersecret"` — a secret-shaped name assigned a literal.
 * The keyword may sit anywhere in the name, including at the start (`apiKey`).
 */
const SECRET_ASSIGNMENT = /\b([\w.]*(?:secret|passwd|password|token|api[_-]?key|apikey|auth[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[\w.]*)\s*[:=]\s*(['"`])([^'"`\n]{6,})\2/gi

/**
 * Names that merely contain a secret word and hold no credential.
 *
 * A tokenizer is a tokenizer. More importantly, a name ending in `Env` or
 * `_ENV` holds the *name of an environment variable* — `apiKeyEnv:
 * 'ANTHROPIC_API_KEY'` is the correct pattern, and elia's own provider registry
 * does it nine times. And `process.env.X = '...'` is writing *into* the
 * environment, which is test setup, not a hardcoded secret.
 */
const NOT_A_SECRET_NAME = /token(?:ize|izer|ization|isation)|passwordless|secretary|env(?:_?(?:var|name))?$|^process\.env\./i

/**
 * Test files get issuer-format matching only.
 *
 * Fake credentials are what test fixtures are made of, and the name-based
 * heuristics are tuned for shipped code: on elia's own repo they produced
 * eighteen fixture false positives and nothing real. A genuine `AKIA…` or
 * `sk-ant-…` committed in a test is still a leak, so the high-confidence format
 * scan still runs there.
 */
const TEST_FILE = /(?:^|[\\/])(?:__tests__|tests?)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/i

/**
 * `process.env.JWT_SECRET || 'dev-secret'` — the pattern that actually shipped,
 * twice. It reads as responsible (there *is* an env var) while guaranteeing that
 * a deployment which forgets to set it runs on a secret the whole world can read
 * in the source.
 */
const SECRET_FALLBACK = /process\.env\.([A-Za-z_]\w*(?:SECRET|PASSWORD|TOKEN|KEY)\w*)\s*(?:\|\||\?\?)\s*(['"`])([^'"`\n]{4,})\2/g

/**
 * Values that only look like secrets. A placeholder is the correct thing to
 * write in an example or a template, so flagging one trains people to ignore
 * the check.
 */
const PLACEHOLDER = /^(?:x{3,}|\.{3,}|-+|_+|\$\{.*\}|<.*>|\{\{.*\}\})$|(?:your|my|some|the)[-_]?(?:api|secret|key|token|password)|(?:example|sample|placeholder|changeme|change[-_]me|replace[-_]?me|dummy|fake|todo|fixme|redacted|xxxx|test[-_]?key|not[-_]?a[-_]?real)/i

/**
 * The manifest-level dependency check. Deliberately *not* implemented by
 * re-running the tests with auto-install disabled: that only covers Bun, needs a
 * clean node_modules to mean anything, and reports the first missing package
 * rather than all of them.
 */
export function undeclaredDependencies(input: HygieneInput): { name: string; files: string[] }[] {
  const root = resolve(input.cwd)
  const base = new Set<string>()
  for (const path of input.extraManifests ?? []) {
    for (const name of manifestDependencies(path)) base.add(name)
  }
  const aliases = pathAliases(root)
  // A file's dependencies are declared by the nearest package.json above it, not
  // necessarily the root one — otherwise every workspace package in a monorepo
  // would read as undeclared.
  const nearest = new Map<string, Set<string> | undefined>()

  const found = new Map<string, Set<string>>()
  for (const file of input.changedFiles) {
    const absolute = toAbsolute(file, root)
    if (!SOURCE_EXT.test(absolute) || !isReadableFile(absolute)) continue
    const declared = declaredFor(absolute, root, base, nearest)
    // No manifest above this file, or one we could not parse: nothing can be
    // proven undeclared, so claim nothing.
    if (!declared || declared.has(UNKNOWN_MANIFEST)) continue
    const source = stripComments(readTextFile(absolute) ?? '')
    for (const specifier of importSpecifiers(source)) {
      const name = externalPackage(specifier, aliases)
      if (!name || declared.has(name)) continue
      const files = found.get(name) ?? new Set<string>()
      files.add(relativeTo(absolute, root))
      found.set(name, files)
    }
  }

  return [...found]
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Scratch files the run left behind. Only files the run *created* are eligible —
 * a `debug.ts` that was already in the repo is the project's business — and only
 * ones nothing else references, so a scratch-looking file that the code actually
 * imports is left alone.
 */
export function scratchArtifacts(input: HygieneInput): string[] {
  const referenceable = input.changedFiles
    .map((file) => toAbsolute(file, input.cwd))
    .concat(join(input.cwd, 'package.json'))

  const scratch: string[] = []
  for (const file of input.addedFiles) {
    const absolute = toAbsolute(file, input.cwd)
    const name = basename(absolute)
    const relative = relativeTo(absolute, input.cwd)
    const inScratchDirectory = SCRATCH_DIR.test(relative)
    const looksScratch = inScratchDirectory || ALWAYS_SCRATCH.test(name) || MARKED_SCRATCH.test(name) || SCRATCH_EXT.test(name)
    if (!looksScratch || !isReadableFile(absolute)) continue
    // A throwaway directory is a declaration of intent, so it outranks the
    // reference check — something mentioning the name does not make `tmp/`
    // part of the deliverable. For a merely scratch-*looking* name, being
    // referenced is what tells the two apart.
    if (!inScratchDirectory && isReferencedElsewhere(absolute, referenceable)) continue
    scratch.push(relative)
  }
  return scratch.sort()
}

export interface HardcodedSecret {
  file: string
  line: number
  /** What was found, in words — never the secret itself. */
  description: string
}

/**
 * Credentials written into the source.
 *
 * `sensitivePaths` guards which *files* may be read or committed; nothing
 * guarded what gets written *into* the code. Two runs shipped
 * `JWT_SECRET = "supersecret"`, and one of them declared the intent in its own
 * plan ("we will hard-code a dev secret for simplicity") with nothing to stop
 * it. Whether a reviewer happened to notice decided the outcome, and when they
 * did, two reviewers disagreed about the severity.
 *
 * The finding never quotes the value — a run receipt is written to disk and
 * shown in a terminal, so repeating a live key there would spread it further.
 */
export function hardcodedSecrets(input: HygieneInput): HardcodedSecret[] {
  const root = resolve(input.cwd)
  const found: HardcodedSecret[] = []

  for (const file of input.changedFiles) {
    const absolute = toAbsolute(file, root)
    if (!SOURCE_EXT.test(absolute) || !isReadableFile(absolute)) continue
    const source = stripComments(readTextFile(absolute) ?? '')
    const relative = relativeTo(absolute, root)

    for (const { name, pattern } of KNOWN_KEY_FORMATS) {
      const match = pattern.exec(source)
      // Issuers publish example keys (AWS's own docs use AKIAIOSFODNN7EXAMPLE);
      // those are documentation, not credentials.
      if (match && !PLACEHOLDER.test(match[0])) {
        found.push({ file: relative, line: lineOf(source, match.index), description: `what looks like ${name}` })
      }
    }

    if (TEST_FILE.test(relative)) continue

    for (const match of source.matchAll(SECRET_FALLBACK)) {
      if (PLACEHOLDER.test(match[3] ?? '')) continue
      found.push({
        file: relative,
        line: lineOf(source, match.index ?? 0),
        description: `a fallback secret for ${match[1]} — if the environment variable is unset, the app silently runs on a secret that is readable in the source`,
      })
    }

    for (const match of source.matchAll(SECRET_ASSIGNMENT)) {
      const value = match[3] ?? ''
      if (PLACEHOLDER.test(value) || value.startsWith('process.env')) continue
      if (NOT_A_SECRET_NAME.test(match[1] ?? '')) continue
      const line = lineOf(source, match.index ?? 0)
      // The fallback scan already reported this line, and with a better reason.
      if (found.some((entry) => entry.file === relative && entry.line === line)) continue
      found.push({ file: relative, line, description: `${match[1]} assigned a literal value` })
    }
  }

  return found
}

/** Both checks, as review issues the repair phase can act on. */
export function auditDeliverable(input: HygieneInput): CriticIssue[] {
  const issues: CriticIssue[] = []

  for (const secret of hardcodedSecrets(input)) {
    issues.push({
      severity: 'blocker',
      file: secret.file,
      detail:
        `${secret.file}:${secret.line} contains ${secret.description}. ` +
        'Read it from the environment instead, and fail startup when it is missing rather than falling back to a literal. ' +
        'If this credential is real, it is now in the source history and must be rotated.',
    })
  }

  for (const dependency of undeclaredDependencies(input)) {
    issues.push({
      severity: 'blocker',
      file: dependency.files[0],
      detail:
        `"${dependency.name}" is imported by ${dependency.files.join(', ')} but is not declared in package.json. ` +
        'Bun auto-installs missing packages, so the tests pass here while the project is broken for anyone who clones it. ' +
        'Add it to dependencies (or devDependencies if only tests use it).',
    })
  }

  const scratch = scratchArtifacts(input)
  if (scratch.length > 0) {
    issues.push({
      severity: 'major',
      file: scratch[0],
      detail:
        `This run created ${scratch.length} scratch file(s) that nothing references and that are not part of the deliverable: ${scratch.join(', ')}. ` +
        'Delete them. If one is actually part of the deliverable, give it a real name and wire it up.',
    })
  }

  return issues
}

/** The audit as a reviewer verdict, so it merges with the model reviewers' verdicts. */
export function hygieneVerdict(input: HygieneInput): CriticVerdict {
  const issues = auditDeliverable(input)
  return {
    verdict: issues.length > 0 ? 'revise' : 'approve',
    summary:
      issues.length > 0
        ? `${issues.length} deliverable-hygiene problem(s): hardcoded secrets, undeclared dependencies, or leftover scratch files.`
        : 'No hardcoded secrets, dependencies are declared, and no scratch files were left behind.',
    issues,
  }
}

/**
 * Added and changed file lists from `git status --porcelain=v1`. Rename targets
 * count as added, since the file at that path is new.
 */
export function filesFromGitStatus(porcelain: string): { added: string[]; changed: string[] } {
  const added: string[] = []
  const changed: string[] = []
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ')[1] ?? path
    path = path.replace(/^"|"$/g, '')
    if (!path || path.endsWith('/')) continue
    if (code.includes('D')) continue
    if (code === '??' || code.includes('A') || code.includes('R')) added.push(path)
    changed.push(path)
  }
  return { added: [...new Set(added)], changed: [...new Set(changed)] }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.elia', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', 'vendor'])

/**
 * Every file in a project, for a deliverable that is not in git at all — the
 * scratch directory a run scaffolded from nothing, which is exactly the case
 * where undeclared dependencies and leftover scratch files show up and where
 * `git status` has nothing to say.
 */
export function scanProjectFiles(cwd: string, options: { modifiedSince?: number; limit?: number } = {}): string[] {
  const { modifiedSince, limit = 3000 } = options
  const root = resolve(cwd)
  const files: string[] = []
  const stack = [root]
  while (stack.length > 0 && files.length < limit) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // Hidden directories are tooling state, never deliverable content.
      if (entry.isDirectory() && entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full)
      } else if (entry.isFile()) {
        // Without git there is nothing that says which files this run created,
        // so "changed since the run started" is the only honest answer — and it
        // matters, because a scratch-looking file the user already had is not
        // this run's to delete.
        if (modifiedSince !== undefined && !modifiedAfter(full, modifiedSince)) continue
        files.push(relativeTo(full, root))
        if (files.length >= limit) break
      }
    }
  }
  return files.sort()
}

// --- internals --------------------------------------------------------------

/** Sentinel for "a manifest existed but could not be read", which must not read as "nothing is declared". */
const UNKNOWN_MANIFEST = '!unparsable-manifest'

function manifestDependencies(path: string): string[] {
  const raw = readTextFile(path)
  if (raw === undefined) return existsSync(path) ? [UNKNOWN_MANIFEST] : []
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>
    const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    return fields.flatMap((field) => {
      const value = pkg[field]
      return value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : []
    })
  } catch {
    return [UNKNOWN_MANIFEST]
  }
}

/**
 * What counts as declared for one file: the deliverable's own manifests plus the
 * nearest package.json above the file, so a workspace package that declares its
 * own dependency is not reported against the root manifest.
 */
function declaredFor(file: string, root: string, base: Set<string>, cache: Map<string, Set<string> | undefined>): Set<string> | undefined {
  let dir = dirname(file)
  const seen: string[] = []
  while (dir.startsWith(root)) {
    if (cache.has(dir)) {
      const cached = cache.get(dir)
      for (const entry of seen) cache.set(entry, cached)
      return cached
    }
    seen.push(dir)
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const merged = new Set([...base, ...manifestDependencies(manifest)])
      for (const entry of seen) cache.set(entry, merged)
      return merged
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const entry of seen) cache.set(entry, undefined)
  return undefined
}

/** `compilerOptions.paths` prefixes — an aliased import is internal, not a package. */
function pathAliases(cwd: string): string[] {
  const raw = readTextFile(join(cwd, 'tsconfig.json'))
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(stripComments(raw)) as { compilerOptions?: { paths?: Record<string, unknown> } }
    return Object.keys(parsed.compilerOptions?.paths ?? {}).map((key) => key.replace(/\*$/, ''))
  } catch {
    return []
  }
}

export function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  for (const { pattern, guardStrings } of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (!match[1]) continue
      if (guardStrings && startsInsideString(source, match.index ?? 0)) continue
      specifiers.add(match[1])
    }
  }
  return [...specifiers]
}

/**
 * Whether the character at `index` sits inside a quoted string, judged from the
 * start of its own line. Line-local on purpose: it costs nothing, and the case
 * it exists for — a one-line code sample in a test fixture — is always on one
 * line.
 */
function startsInsideString(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  let quote: string | undefined
  for (let i = lineStart; i < index; i += 1) {
    const character = source[i]
    if (character === '\\') {
      i += 1
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character
    }
  }
  return quote !== undefined
}

/** The npm package a specifier resolves to, or undefined when it resolves inside the project. */
function externalPackage(specifier: string, aliases: string[]): string | undefined {
  if (!specifier) return undefined
  // Relative, absolute, subpath-imports (`#db`), and anything with a scheme
  // (node:, bun:, http:, data:) never comes from package.json.
  if (/^[./#]/.test(specifier) || isAbsolute(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined
  if (aliases.some((alias) => alias && specifier.startsWith(alias))) return undefined
  const name = packageRoot(specifier)
  if (BUILTIN.has(name)) return undefined
  // Anything that is not a plausible package name (a bare Windows path, say).
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return undefined
  return name
}

/**
 * Comment-stripping ahead of the import scan, so a commented-out import is not
 * reported as a missing dependency. Only whole-line `//` comments are removed,
 * because a trailing `//` is far more often inside a URL string than a comment.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isReferencedElsewhere(file: string, others: string[]): boolean {
  const stem = basename(file).replace(/\.[^.]+$/, '')
  // A one- or two-character stem matches everywhere and proves nothing.
  if (stem.length < 3) return false
  // Whole-word, not substring: a plain `includes` let `tmp/check.js` pass as
  // "referenced" because some other file contained the word "checkout". The
  // scratch file then shipped.
  const reference = new RegExp(String.raw`\b${escapeRegExp(stem)}\b`)
  for (const other of others) {
    if (resolve(other) === resolve(file) || !isReadableFile(other)) continue
    const content = readTextFile(other)
    if (content && reference.test(content)) return true
  }
  return false
}

function modifiedAfter(path: string, since: number): boolean {
  try {
    return statSync(path).mtimeMs >= since
  } catch {
    return false
  }
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1
  }
  return line
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function toAbsolute(file: string, cwd: string): string {
  return isAbsolute(file) ? file : resolve(cwd, file)
}

function relativeTo(file: string, cwd: string): string {
  const root = resolve(cwd)
  const absolute = resolve(file)
  return absolute.startsWith(root) ? absolute.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : absolute
}
