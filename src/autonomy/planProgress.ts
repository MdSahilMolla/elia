import { isAbsolute, resolve } from 'node:path'
import type { TodoItem, TodoList } from './todoList.ts'

/**
 * Keeps the plan moving with the work instead of with the model's memory.
 *
 * The plan the user watches is the todo list, and until now only `todo_write`
 * moved it — so it moved when the model remembered to call it. On mercury-2.5
 * that is rarely: in the recorded sessions the model went 15, 20, once 45 tool
 * calls between updates, finishing whole steps (dependencies installed,
 * components written, the build green) while the panel still showed step 2 in
 * progress — and in a third of the plans it never marked a finished step done
 * at all. Then the turn ended and the panel kept showing that stale state.
 *
 * Two things change that here. elia ticks a step itself when what just ran
 * proves it done — and only then: a step is done when *every* concrete thing it
 * names has actually succeeded (the file it names was written, the command it
 * names exited 0, the page it asks for was opened and rendered), and one piece
 * of evidence counts toward one step only. A step that names nothing concrete
 * ("add responsive styling") is never ticked by elia; that is the model's call.
 * And when the plan has sat unchanged through several real actions, the model
 * is reminded to bring it up to date — the only way the steps elia cannot judge
 * ever get ticked.
 */

// ---------------------------------------------------------------------------
// Which plans this applies to
// ---------------------------------------------------------------------------

const requestBaselines = new WeakMap<TodoList, number>()

/** A fresh user request starts here: a list written before this point belongs to an earlier request. */
export function beginPlanRequest(list: TodoList): void {
  requestBaselines.set(list, list.revision())
}

/** The list was written since the current request began — it is this request's plan, not a leftover. */
export function planBelongsToRequest(list: TodoList): boolean {
  const baseline = requestBaselines.get(list)
  return baseline !== undefined && list.revision() > baseline && list.read().length > 0
}

/**
 * Whether the list counts as the plan for the work in hand. Where a request
 * boundary was marked, only a plan written since then counts; elsewhere (an
 * `elia auto` run, whose steps share one list) any list does, as it always has.
 */
export function planIsCurrent(list: TodoList): boolean {
  if (list.read().length === 0) return false
  return requestBaselines.has(list) ? planBelongsToRequest(list) : true
}

// ---------------------------------------------------------------------------
// What a step names
// ---------------------------------------------------------------------------

export type AnchorKind = 'file' | 'dir' | 'component' | 'command' | 'check' | 'serve' | 'package' | 'tool' | 'preview'

export interface Anchor {
  kind: AnchorKind
  /** Normalised identity. */
  key: string
  /** For commands: the significant tokens, runner and flags dropped. */
  tokens?: string[]
  /** For files and directories: an absolute path, or a relative one matched as a suffix. */
  absolute?: boolean
  /** A file named by a step whose job is to read or check it, not to change it. */
  readable?: boolean
  /** A script the step runs ("run `seed.py`"): a command that ran it and exited 0 proves it. */
  runnable?: boolean
  /** A file a step only needs to exist — a listing that shows it is enough. */
  listable?: boolean
  /** A directory the step is creating: a command running in it proves it. Otherwise only a file written inside it does. */
  creates?: boolean
}

const EXTENSIONS =
  'tsx?|jsx?|mjs|cjs|mts|cts|json|jsonc|md|mdx|css|scss|sass|less|html?|vue|svelte|astro|py|pyi|rs|go|java|kts?|swift|rb|php|cs|c|cc|cpp|cxx|h|hpp|hh|scala|ex|exs|hs|lua|dart|jl|sql|graphql|gql|proto|toml|ya?ml|ini|cfg|conf|env|lock|sh|bash|zsh|ps1|bat|txt|csv|xml|svg|gradle|properties|tf|prisma|ipynb|docx|xlsx|pptx|pdf'
const EXTENSIONLESS_FILES = /^(?:dockerfile|makefile|procfile|gemfile|rakefile|\.gitignore|\.env(?:\.[\w-]+)?|\.npmrc|\.editorconfig|\.prettierrc|license)$/i
const PATH_BODY = `(?:[A-Za-z]:[\\\\/])?(?:\\.{1,2}[\\\\/])?(?:[\\w@~.-]+[\\\\/])*[\\w@~-][\\w@~.-]*\\.(?:${EXTENSIONS})`
const FILE_PATH = new RegExp(`^${PATH_BODY}$`, 'i')
const BARE_FILE_PATH = new RegExp(`(?<![\\w/\\\\.@-])(${PATH_BODY})(?![\\w/\\\\-])`, 'gi')
const BARE_DOTFILE = /(?<![\w/\\.-])(\.(?:gitignore|env(?:\.[\w-]+)?|npmrc|editorconfig|prettierrc))\b/gi
const BARE_ABSOLUTE_DIR = /(?<![\w`])([A-Za-z]:[\\/][^\s`'",;()]*)/g
const NAMED_FOLDER = /\b([a-z0-9]+(?:[-_][a-z0-9]+)+)\s+(?:project\s+)?(?:folder|directory|dir)\b/gi
/** "Node.js", "Three.js" — libraries, not files. */
const LIBRARY_JS = /^(?:node|vite|next|nuxt|three|chart|d3|express|vue|react|angular|ember|backbone|alpine|p5|pixi|anime|moment|day|socket|leaflet|mapbox|tensorflow|brain|ml5|nest|solid|svelte|deno|phaser|matter|paper|fabric|video|tone|howler|swiper|chartist|highcharts|echarts|plotly|immutable|knockout|mithril|preact|redux|zod)\.js$/i
const CODE_EXTENSION = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|py|rs|go|java|kts?|swift|rb|php|cs|c|cc|cpp|h|hpp|dart|scala|ex|exs|lua)$/i

/** Package managers and interpreters that front a command without being its point: `npm run build` and `bun run build` are the same step. */
const RUNNERS = new Set(['bun', 'bunx', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'deno', 'node', 'python', 'python3', 'py', 'uv', 'poetry', 'pipenv'])
/** First words that make a backticked span a command. */
const COMMANDS = new Set([
  ...RUNNERS,
  'pip', 'pip3', 'cargo', 'rustc', 'go', 'make', 'cmake', 'gradle', 'gradlew', './gradlew', 'mvn', 'dotnet', 'git', 'docker', 'tsc',
  'vite', 'jest', 'vitest', 'pytest', 'eslint', 'prettier', 'ruff', 'mypy', 'black', 'gcc', 'g++', 'clang', 'clang++', 'javac', 'java',
  'php', 'composer', 'ruby', 'bundle', 'rails', 'rake', 'swift', 'flutter', 'dart', 'kubectl', 'terraform', 'mkdir', 'playwright', 'next', 'biome',
])
/** A command that needs arguments to mean anything — a bare `bun` or `npm` names no step. */
const NEEDS_ARGUMENTS = new Set([...RUNNERS, 'pip', 'pip3', 'cargo', 'go', 'git', 'docker', 'dotnet', 'mvn', 'gradle', 'kubectl', 'terraform', 'mkdir', 'java', 'php', 'ruby', 'bundle', 'flutter', 'dart', 'swift'])
const ALIASES: Record<string, string> = { i: 'install', ci: 'install', t: 'test', tst: 'test' }
/** Tools a step can name outright ("use the `preview` tool"); the file tools are how every step is done, so they name nothing. */
const NAMEABLE_TOOLS = new Set(['preview', 'list_files', 'grep', 'web_search', 'web_fetch', 'browser', 'find_symbol', 'http_probe', 'github', 'task', 'process'])
/** Scripts that start something long-running: they are verified by opening what they serve, never by exiting. */
const SERVE_SCRIPT = /^(?:dev|start|serve|server|preview|watch)$/

/** Leading verbs whose file is read or checked, not changed. */
const READ_VERB = /^(?:read|review|inspect|examine|study|understand|analy[sz]e|explore|investigate|audit|locate|find|identify|check|verify|confirm|ensure|look|view|scan|search|list|open)$/
const INSTALL_VERB = /^(?:install|add)$/
const CREATE_VERB = /^(?:create|make|set|setup|add|mkdir|initiali[sz]e|scaffold|bootstrap|prepare)$/
/**
 * The verbs under which a step asks for a check to be *run*. "Document the type
 * error" or "fix the failing test" is not done because a typecheck or the tests
 * passed once.
 */
const RUN_VERB = /^(?:run|rerun|verify|check|confirm|ensure|test|execute|validate|build|compile|typecheck|lint|do|perform|make)$/
const CHECK_VERBS: Record<string, RegExp> = {
  install: /^install$/,
  scaffold: /^(?:initiali[sz]e|scaffold|bootstrap|create|set|setup|generate)$/,
}
/** Verbs that make "…in the browser" something to do rather than something to describe. */
const LOOK_VERB = /^(?:preview|open|view|verify|check|test|confirm|ensure|launch|load|serve|show|visit|use|run|start)$/
const PREVIEW_INTENT = /\bpreview\b|\b(?:open|view|load|check|verify|test|launch|show|visit)\b[^.;]{0,40}\bin (?:the |a )?(?:web )?browser\b|\bopen (?:it|the (?:page|site|app|file|map|website|result\w*|build)|index\.html)\b/i
const THEN_LOOK = /\b(?:and|then)\s+(?:then\s+)?(?:open|preview|view|verify|check|load)\b/i
const BARE_COMMAND = /\b(?:run|running|execute|executing)\s+([a-z][\w.+-]*(?:\s+[^\s,;()]+){0,5})/gi
/** A package-manager command written into the prose without backticks: "(bun install)", "…using bun create vite". */
const BARE_RUNNER_COMMAND = /(?<![\w-])((?:bun|bunx|npm|npx|pnpm|yarn)\s+[a-z@][\w@/.:-]*(?:\s+[a-z@-][\w@/.:-]*){0,4})/g
const COMMAND_STOPWORDS = new Set(['to', 'and', 'so', 'then', 'for', 'with', 'until', 'again', 'once', 'in', 'on', 'from', 'that', 'which', 'if', 'or', 'before', 'after', 'while'])

function has(tokens: string[], ...words: string[]): boolean {
  return words.some((word) => tokens.includes(word))
}

/**
 * Checks a step can ask for in plain words — "run the tests", "verify the build
 * succeeds", "install dependencies". Only a command that exited 0 proves one.
 */
const CHECKS: { key: string; prose: RegExp; runs: (tokens: string[]) => boolean }[] = [
  {
    key: 'typecheck',
    prose: /\btype[- ]?check|\btsc\b|\b(?:type ?script|type) errors?\b|\btype ?script (?:code )?compiles\b|\bmypy\b|\bpyright\b/i,
    runs: (t) => has(t, 'tsc', 'typecheck', 'mypy', 'pyright') || isSubsequence(['type', 'check'], t) || (t[0] === 'cargo' && t[1] === 'check') || (t[0] === 'go' && t[1] === 'vet'),
  },
  {
    key: 'build',
    prose: /\b(?:run|re-?run|verify|check|confirm|ensure|final|production)\b[^.;]*\bbuild\b|\bbuild (?:the )?(?:whole |full |production |final )?(?:project|app|application|site|website|frontend|backend|client|server|output|bundle|code|package)\b|\bbuilds? (?:passes|succeeds|works|compiles|successfully|cleanly|without errors)\b|\b(?:compiles|compilation)\b/i,
    runs: (t) => has(t, 'build', 'compile') || t[0] === 'make' || (t[0] === 'mvn' && has(t, 'package', 'install')),
  },
  {
    key: 'test',
    prose: /\b(?:run|re-?run|execute)\b[^.;]*\btests?\b|\btest ?suite\b|\btests? (?:pass|passes|succeed|are green)\b|\ball tests\b/i,
    runs: (t) => has(t, 'test', 'pytest', 'jest', 'vitest', 'mocha', 'ctest'),
  },
  {
    key: 'lint',
    prose: /\b(?:run|re-?run)\b[^.;]*\b(?:lint(?:er)?|eslint|ruff|clippy|biome)\b/i,
    runs: (t) => has(t, 'lint', 'eslint', 'ruff', 'clippy', 'biome'),
  },
  {
    key: 'install',
    prose: /\binstall(?:ing)?\s+(?:the\s+|all\s+|any\s+|frontend\s+|backend\s+|project\s+|npm\s+|node\s+|necessary\s+|required\s+|missing\s+|needed\s+|new\s+)*(?:dependencies|deps|packages|modules|node_modules)\b/i,
    runs: (t) => ['install', 'add', 'sync'].includes(t[0] ?? '') || (['pip', 'pip3', 'cargo', 'go', 'composer', 'bundle', 'gem'].includes(t[0] ?? '') && ['install', 'add', 'get', 'require', 'fetch'].includes(t[1] ?? '')),
  },
  {
    key: 'scaffold',
    prose: /\b(?:initiali[sz]e|scaffold|bootstrap|create|set ?up|generate)\b[^.;]{0,60}\b(?:vite|react|next(?:\.js)?|vue|svelte(?:kit)?|astro|nuxt|remix|angular|solid|expo|tauri|electron|express|fastapi|django|flask|rails|laravel|spring|cargo|rust|bun|node(?:\.js)?|typescript)\b[^.;]{0,40}\b(?:project|app|application|template|frontend|backend)\b/i,
    runs: (t) => t[0] !== 'git' && (has(t, 'create', 'init', 'degit') || t[1] === 'new'),
  },
]

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase()
}

function stripVersion(token: string): string {
  const match = /^(@?[^@]+)@[^@/]*$/.exec(token)
  return match ? match[1]! : token
}

function isSubsequence(needle: string[], haystack: string[]): boolean {
  let at = 0
  for (const word of haystack) {
    if (word === needle[at]) at += 1
    if (at === needle.length) return true
  }
  return needle.length === 0
}

/**
 * A shell command as the tokens that say what it does: quotes, redirections,
 * env assignments, flags, versions, and the runner dropped, and `-`/`:` split so
 * `create-vite` meets `create vite` and `build:prod` meets `build`.
 */
export function commandTokens(segment: string): string[] {
  const words = segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["']$/g, ''))
    .filter((word) => word && !/^\d*[<>]/.test(word) && !/^[A-Z_][A-Z0-9_]*=/.test(word))
  while (words.length > 0 && RUNNERS.has(words[0]!.toLowerCase())) {
    const runner = words.shift()!.toLowerCase()
    // `python -m pytest` is pytest; `pnpm dlx x` / `yarn dlx x` is x.
    if ((runner.startsWith('py') && words[0] === '-m') || words[0] === 'dlx' || words[0] === 'exec') words.shift()
  }
  return words
    .filter((word) => !word.startsWith('-'))
    .map((word) => stripVersion(word.toLowerCase()))
    .flatMap((word) => word.split(/[-:]/))
    .filter(Boolean)
    .map((word) => ALIASES[word] ?? word)
}

/** Packages an install command adds, for "install `leaflet` and `lucide-react`". */
function installedPackages(segment: string): string[] {
  const words = segment.trim().split(/\s+/).map((word) => word.replace(/^["']|["']$/g, '').toLowerCase())
  const verb = words.findIndex((word) => word === 'add' || word === 'install' || word === 'i' || word === 'get')
  if (verb < 0 || !words.slice(0, verb).every((word) => RUNNERS.has(word) || ['pip', 'pip3', 'cargo', 'go'].includes(word))) return []
  return words.slice(verb + 1).filter((word) => !word.startsWith('-')).map(stripVersion)
}

function isCommandSpan(span: string): boolean {
  const words = span.trim().split(/\s+/)
  const first = words[0]!.toLowerCase()
  if (!COMMANDS.has(first)) return false
  if (NEEDS_ARGUMENTS.has(first) && words.length < 2) return false
  return commandTokens(span).length > 0
}

function commandAnchor(span: string): Anchor | undefined {
  const tokens = commandTokens(span)
  if (tokens.length === 0) return undefined
  const serve = (tokens.length === 1 && (SERVE_SCRIPT.test(tokens[0]!) || tokens[0] === 'vite')) ||
    (tokens[0] === 'run' && tokens.length === 2 && SERVE_SCRIPT.test(tokens[1]!)) ||
    (tokens[0] === 'next' && tokens[1] === 'dev')
  return { kind: serve ? 'serve' : 'command', key: tokens.join(' '), tokens }
}

function leadingVerb(step: string): string {
  const words = step.replace(/^[\s*#>\d.)-]+/, '').toLowerCase().match(/[a-z]+/g) ?? []
  const skip = new Set(['first', 'then', 'next', 'finally', 'now', 'also', 'lastly', 're'])
  return words.find((word) => !skip.has(word)) ?? ''
}

/** The concrete things a plan step names — what has to have happened for it to be done. */
export function stepAnchors(step: string): Anchor[] {
  const verb = leadingVerb(step)
  const readable = READ_VERB.test(verb)
  const runnable = /^(?:run|rerun|execute)$/.test(verb)
  const listable = /\bexists?\b/i.test(step)
  // "Create the `shop` folder" makes the folder; "add routes in a `server`
  // subfolder" only says where they go.
  const beforeLocative = step.split(/\s(?:in|inside|under|within|into)\s/i)[0] ?? step
  const creatingDir = CREATE_VERB.test(verb) && /\b(?:sub)?(?:folder|directory|dir)\b/i.test(beforeLocative)
  const installing = INSTALL_VERB.test(verb) && (verb === 'install' || /\b(?:dependenc|package|librar|module)/i.test(step))
  const anchors: Anchor[] = []
  const components: Anchor[] = []

  const addFile = (raw: string): void => {
    const trimmed = raw.trim().replace(/[.,;:]+$/, '')
    const base = trimmed.split(/[\\/]/).pop() ?? trimmed
    if (!trimmed.includes('/') && !trimmed.includes('\\') && LIBRARY_JS.test(base)) return
    anchors.push({ kind: 'file', key: normalizePath(trimmed), readable, runnable, listable, absolute: isAbsolute(trimmed) })
  }
  const addDir = (raw: string): void => {
    const trimmed = raw.trim().replace(/[.,;:]+$/, '')
    if (trimmed) anchors.push({ kind: 'dir', key: normalizePath(trimmed), absolute: isAbsolute(trimmed), creates: creatingDir })
  }

  const spans = [...step.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim()).filter(Boolean)
  for (const span of spans) {
    if (FILE_PATH.test(span) || EXTENSIONLESS_FILES.test(span.split(/[\\/]/).pop() ?? '')) {
      addFile(span)
      continue
    }
    if (isCommandSpan(span)) {
      for (const part of span.split(/\s*(?:&&|;)\s*/)) {
        const anchor = part && isCommandSpan(part) ? commandAnchor(part) : undefined
        if (anchor) anchors.push(anchor)
      }
      continue
    }
    const lower = span.toLowerCase()
    if (NAMEABLE_TOOLS.has(lower)) {
      anchors.push(lower === 'preview' ? { kind: 'preview', key: 'preview' } : { kind: 'tool', key: lower })
      continue
    }
    if (/[\\/]/.test(span) && !/\s/.test(span) && !/^https?:/i.test(span) && !/[<>{}]/.test(span)) {
      addDir(span)
      continue
    }
    if (installing && /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(span)) {
      anchors.push({ kind: 'package', key: stripVersion(lower) })
      continue
    }
    const after = step.slice(step.indexOf(`\`${span}\``) + span.length + 2)
    if (/^[a-z0-9_.-]+$/i.test(span) && /^\s*(?:sub)?(?:folder|directory|dir)\b/i.test(after)) {
      addDir(span)
      continue
    }
    if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*$/.test(span)) components.push({ kind: 'component', key: lower })
  }

  const prose = step.replace(/`[^`]*`/g, ' ')
  for (const match of prose.matchAll(BARE_FILE_PATH)) addFile(match[1]!)
  for (const match of prose.matchAll(BARE_DOTFILE)) addFile(match[1]!)
  if (/\bREADME\b(?!\.)/.test(prose)) addFile('README.md')
  for (const match of prose.matchAll(BARE_ABSOLUTE_DIR)) {
    const path = match[1]!.replace(/[.,;:]+$/, '')
    if (!FILE_PATH.test(path)) addDir(path)
  }
  for (const match of prose.matchAll(NAMED_FOLDER)) addDir(match[1]!)
  for (const match of [...prose.matchAll(BARE_COMMAND), ...prose.matchAll(BARE_RUNNER_COMMAND)]) {
    const words = match[1]!.split(/\s+/)
    const cut = words.findIndex((word) => COMMAND_STOPWORDS.has(word.toLowerCase()))
    const candidate = (cut < 0 ? words : words.slice(0, cut)).join(' ').replace(/[.,;:)]+$/, '')
    if (candidate && isCommandSpan(candidate)) {
      const anchor = commandAnchor(candidate)
      if (anchor) anchors.push(anchor)
    }
  }
  // "Create a README explaining how to run it (open in browser)" describes the
  // browser; "Preview the site" and "…and open it in the browser" ask for it.
  const spoken = prose.replace(/\([^)]*\)/g, ' ')
  if (PREVIEW_INTENT.test(spoken) && (LOOK_VERB.test(verb) || /\bpreview\b/i.test(spoken) || THEN_LOOK.test(spoken))) {
    anchors.push({ kind: 'preview', key: 'preview' })
  }

  // A check asked for in words, when no command was named for it outright —
  // judged clause by clause, so "install dependencies and build the project"
  // asks for both and "document the type error" asks for neither.
  if (!anchors.some((anchor) => anchor.kind === 'command' || anchor.kind === 'serve')) {
    const clauses = step.split(/\s*(?:[,;]|\band\b|\bthen\b)\s*/i).filter(Boolean)
    const checks = CHECKS.filter((check) =>
      clauses.some((clause, index) => {
        if (!check.prose.test(clause)) return false
        // A clause with no verb of its own ("…, and dev server") carries the step's.
        const own = leadingVerb(clause)
        return (CHECK_VERBS[check.key] ?? RUN_VERB).test(index === 0 ? verb : own) || (CHECK_VERBS[check.key] ?? RUN_VERB).test(verb)
      }),
    )
    const keys = new Set(checks.map((check) => check.key))
    for (const check of checks) {
      // "Run the typecheck to verify the code compiles" asks for one check, not two.
      if (check.key === 'build' && keys.has('typecheck') && !/\bbuild\b/i.test(step)) continue
      // "Install `leaflet`" is proven by the packages themselves.
      if (check.key === 'install' && anchors.some((anchor) => anchor.kind === 'package')) continue
      anchors.push({ kind: 'check', key: check.key })
    }
  }

  // A component named beside a file ("add a `Header` to `Layout.tsx`") lives in
  // that file — its own file is never going to be written.
  if (!anchors.some((anchor) => anchor.kind === 'file')) anchors.push(...components)

  // The same file named twice ("`index.html`" and its full path) is one thing
  // to prove, and so is "run `bun run dev` and check it in the browser".
  const files = anchors.filter((anchor) => anchor.kind === 'file' || anchor.kind === 'dir')
  const serves = anchors.some((anchor) => anchor.kind === 'serve')
  const seen = new Set<string>()
  return anchors.filter((anchor) => {
    const id = `${anchor.kind}:${anchor.key}`
    if (seen.has(id) || (anchor.kind === 'preview' && serves)) return false
    seen.add(id)
    if ((anchor.kind === 'file' || anchor.kind === 'dir') && !anchor.absolute) {
      return !files.some((other) => other !== anchor && other.kind === anchor.kind && other.key.endsWith(`/${anchor.key}`))
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// What a tool call proves
// ---------------------------------------------------------------------------

export interface ToolOutcome {
  name: string
  input: Record<string, unknown>
  result: string
  isError: boolean
}

interface Proof {
  /** Files written or edited, absolute and normalised. */
  wrote: string[]
  read: string[]
  /** Pages a preview rendered — "open `index.html` in the browser" is about this file. */
  viewed: string[]
  /** Files a successful list_files showed, absolute and normalised. */
  listed: string[]
  /** Directories a successful command ran in (a missing cwd fails the spawn) or created. */
  dirs: string[]
  /** Each command segment the exit code vouches for. */
  commands: { tokens: string[]; packages: string[]; raw: string }[]
  started: string[][]
  previewed: boolean
  tool: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function absolute(path: string, root: string): string {
  return normalizePath(resolve(root, path))
}

/**
 * The segments of a command whose success the exit code actually vouches for.
 * `a && b` exiting 0 means both ran and passed; `a; b` means b did; a pipeline
 * reports its last stage (so `bun test | tail` proves nothing about the tests),
 * and `a || b` could have been either.
 */
function vouchedSegments(command: string): string[] {
  if (command.includes('||')) return []
  const statements = command.split(/\s*;\s*/)
  const last = statements[statements.length - 1] ?? ''
  return last.split(/\s*&&\s*/).filter((part) => part.trim() && !/\|/.test(part.replace(/2>&1/g, '')))
}

function commandSucceeded(outcome: ToolOutcome): boolean {
  if (outcome.isError) return false
  const exit = /^exit code: (-?\d+)/m.exec(outcome.result)
  if (exit) return exit[1] === '0'
  return !/\btimed out\b/i.test(outcome.result.slice(0, 200))
}

export function proofOf(outcome: ToolOutcome, root: string): Proof | undefined {
  if (outcome.isError) return undefined
  const proof: Proof = { wrote: [], read: [], viewed: [], listed: [], dirs: [], commands: [], started: [], previewed: false, tool: outcome.name }
  const input = outcome.input
  const cwd = str(input.cwd) ? resolve(root, str(input.cwd)) : root
  switch (outcome.name) {
    case 'write_file':
    case 'edit_file':
      if (str(input.path)) proof.wrote.push(absolute(str(input.path), root))
      break
    case 'read_file':
      if (str(input.path)) proof.read.push(absolute(str(input.path), root))
      break
    case 'list_files':
      // Not proof a folder exists — listing one that is not there can come back
      // empty rather than fail — but it does show which files are there.
      proof.listed = outcome.result.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2_000).map((line) => absolute(line, cwd))
      break
    case 'run_command':
    case 'run_program': {
      if (!commandSucceeded(outcome)) return undefined
      const command = outcome.name === 'run_program'
        ? [str(input.program), ...(Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : [])].join(' ')
        : str(input.command)
      proof.dirs.push(normalizePath(cwd))
      for (const segment of vouchedSegments(command)) {
        proof.commands.push({ tokens: commandTokens(segment), packages: installedPackages(segment), raw: normalizePath(segment) })
        const args = (pattern: RegExp): string[] =>
          // Flags: `-p`, `--force`, and cmd's `/s /q`.
          (pattern.exec(segment)?.[1] ?? '').split(/\s+/).filter((arg) => arg && !/^-|^\/[a-z?]$/i.test(arg)).map((arg) => absolute(arg.replace(/^["']|["']$/g, ''), cwd))
        proof.dirs.push(...args(/^\s*(?:mkdir|md|New-Item\s+-ItemType\s+Directory(?:\s+-Force)?(?:\s+-Path)?)\s+(.+)$/i))
        // Deleting, moving, or copying a file is the change a "remove X" or
        // "rename X to Y" step asks for.
        proof.wrote.push(...args(/^\s*(?:rm|del|erase|unlink|git\s+rm|git\s+mv|mv|move|ren|rename|cp|copy|Remove-Item|Move-Item|Rename-Item|Copy-Item)\s+(.+)$/i))
      }
      break
    }
    case 'process':
      if (str(input.action) !== 'start' || !/^\S+ started: /.test(outcome.result)) return undefined
      proof.dirs.push(normalizePath(cwd))
      proof.started.push(commandTokens(str(input.command)))
      break
    case 'preview':
      // "Build failed — nothing to preview yet" is not an error result, but it
      // is not a preview either. A page that rendered reports where it is served.
      proof.previewed = /\nServing \S/.test(outcome.result) || /^Opened https?:\/\//.test(outcome.result)
      if (!proof.previewed) return undefined
      // What it was asked to open, and the file it actually served (a folder
      // serves its index.html, a Vite project its built output).
      if (str(input.path)) proof.viewed.push(absolute(str(input.path), root))
      for (const served of outcome.result.matchAll(/^Serving (?!https?:)(.+)$/gm)) proof.viewed.push(absolute(served[1]!.trim(), root))
      break
    case 'browser':
      proof.previewed = /^(?:navigate|open|goto)$/.test(str(input.action))
      break
  }
  return proof
}

function pathMatches(path: string, anchor: Anchor): boolean {
  return anchor.absolute ? path === anchor.key : path === anchor.key || path.endsWith(`/${anchor.key}`)
}

function inDirectory(path: string, anchor: Anchor): boolean {
  if (anchor.absolute) return path === anchor.key || path.startsWith(`${anchor.key}/`)
  return path.endsWith(`/${anchor.key}`) || path.includes(`/${anchor.key}/`)
}

/**
 * The pieces of evidence in `proof` that satisfy `anchor`, as tokens. A token is
 * spent by the first step that uses it, so one write or one passing command
 * never ticks two steps.
 */
export function evidenceFor(proof: Proof, anchor: Anchor): string[] {
  switch (anchor.kind) {
    case 'file':
      // Writing the script is not running it.
      if (anchor.runnable) {
        const base = anchor.key.split('/').pop()!
        return proof.commands.flatMap((command, index) => (new RegExp(`(?:^|[\\s/"'])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s"'])`).test(command.raw) ? [`c:${index}`] : []))
      }
      return [
        ...proof.wrote.filter((path) => pathMatches(path, anchor)).map((path) => `w:${path}`),
        ...(anchor.readable ? proof.read.filter((path) => pathMatches(path, anchor)).map((path) => `r:${path}`) : []),
        ...(anchor.readable ? proof.viewed.filter((path) => pathMatches(path, anchor)).map((path) => `v:${path}`) : []),
        ...(anchor.listable ? proof.listed.filter((path) => pathMatches(path, anchor)).map((path) => `l:${path}`) : []),
      ]
    case 'dir':
      return [
        ...proof.wrote.filter((path) => inDirectory(path, anchor)).map((path) => `d:${path}`),
        ...(anchor.creates ? proof.dirs.filter((path) => inDirectory(path, anchor)).map((path) => `d:${path}`) : []),
      ]
    case 'component':
      return proof.wrote
        .filter((path) => {
          const base = path.split('/').pop()!
          const stem = base.replace(/\.[^.]+$/, '')
          return (CODE_EXTENSION.test(base) && stem === anchor.key) || stem.startsWith(`${anchor.key}.config`)
        })
        .map((path) => `w:${path}`)
    case 'command':
      return proof.commands.flatMap((command, index) => (isSubsequence(anchor.tokens!, command.tokens) ? [`c:${index}`] : []))
    case 'check': {
      const check = CHECKS.find((candidate) => candidate.key === anchor.key)!
      return proof.commands.flatMap((command, index) => (check.runs(command.tokens) ? [`c:${index}`] : []))
    }
    case 'serve':
      return [
        // A rendered page proves the frontend is served — not a backend `bun run server`.
        ...(proof.previewed && !/\b(?:server|watch)$/.test(anchor.key) ? ['p'] : []),
        ...proof.started.flatMap((tokens, index) => (isSubsequence(anchor.tokens!, tokens) ? [`s:${index}`] : [])),
      ]
    case 'package':
      return proof.commands.flatMap((command, index) => (command.packages.includes(anchor.key) ? [`k:${index}:${anchor.key}`] : []))
    case 'preview':
      return proof.previewed ? ['p'] : []
    case 'tool':
      return proof.tool === anchor.key ? ['t'] : []
  }
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/** Tools that change something — the actions that move a plan, or should have. */
const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_command', 'run_program', 'process'])

/** Changing actions with no plan update before the model is asked to bring it up to date. */
export const STALE_PLAN_ACTIONS = 6
/** Reminders per loop; each waits twice as long as the last, so a model with a reason to leave the plan alone is not nagged. */
const MAX_STALE_NUDGES = 3

export interface PlanProgressUpdate {
  /** The list after elia's ticks. */
  items: TodoItem[]
  /** Steps elia just marked done. */
  ticked: string[]
}

export interface PlanProgressResult {
  update?: PlanProgressUpdate
  /** Tells the model what elia ticked, so its next todo_write carries the tick rather than undoing it. */
  note?: string
  /** Asks the model to bring a plan that has not moved in a while up to date. */
  nudge?: string
}

export interface PlanProgressTracker {
  /** Record one completed batch of tool calls, in the order they were issued. */
  observe(batch: ToolOutcome[]): PlanProgressResult
}

export interface PlanProgressOptions {
  list: () => TodoList
  /** Where relative tool paths resolve. */
  root: string
  /** Whether the list is this request's plan before any todo_write in this loop — see planBelongsToRequest. */
  owned?: () => boolean
}

/** A step as one line inside a sentence of elia's — no trailing period of its own. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/[.;:]+$/, '')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Step identity across rewrites: the model often drops the backticks when it copies a step into todo_write. */
function stepKey(content: string): string {
  return content.replace(/[`'"*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

const MARK: Record<TodoItem['status'], string> = { completed: '✓', in_progress: '◐', pending: '□' }

export function createPlanProgressTracker(options: PlanProgressOptions): PlanProgressTracker {
  // A step's anchors come from the first wording seen for it — the planner's,
  // with its backticked paths and commands, not a later paraphrase of it.
  const firstWording = new Map<string, string>()
  const anchorCache = new Map<string, Anchor[]>()
  const anchorsOf = (content: string): Anchor[] => {
    const key = stepKey(content)
    if (!firstWording.has(key)) firstWording.set(key, content)
    let anchors = anchorCache.get(key)
    if (!anchors) {
      anchors = stepAnchors(firstWording.get(key)!)
      anchorCache.set(key, anchors)
    }
    return anchors
  }
  const anchorId = (anchor: Anchor): string => `${anchor.kind}:${anchor.key}`

  // Per step: the anchors already proven.
  const proven = new Map<string, Set<string>>()
  // The list as this tracker last left it — what a todo_write in the next batch
  // is measured against. Observed only after a batch has run, the live list
  // already holds the model's write.
  let lastSeen = options.list().read()
  for (const item of lastSeen) anchorsOf(item.content)
  let wroteThisLoop = false
  let actionsSinceUpdate = 0
  let nudges = 0

  return {
    observe(batch) {
      const list = options.list()
      const items = list.read()
      if (batch.some((outcome) => outcome.name === 'todo_write' && !outcome.isError)) {
        wroteThisLoop = true
        actionsSinceUpdate = 0
        // The model's list is authoritative. A step it reopened — done before
        // this write, open now — was reopened for a reason: what proved it
        // before proves nothing about it now.
        const wasDone = new Set(lastSeen.filter((item) => item.status === 'completed').map((item) => stepKey(item.content)))
        for (const item of items) if (item.status !== 'completed' && wasDone.has(stepKey(item.content))) proven.delete(stepKey(item.content))
      }
      lastSeen = items.map((item) => ({ ...item }))
      if (items.length === 0 || (!wroteThisLoop && !(options.owned?.() ?? false))) return {}

      const ticked: string[] = []
      for (const outcome of batch) {
        if (outcome.name === 'todo_write') continue
        if (CHANGING_TOOLS.has(outcome.name)) actionsSinceUpdate += 1
        const proof = proofOf(outcome, options.root)
        if (!proof) continue
        // One piece of evidence proves one thing: the earliest open step that
        // asks for it gets it, and "run both dev servers" needs two.
        const spent = new Set<string>()
        for (const item of items) {
          if (item.status === 'completed') continue
          const anchors = anchorsOf(item.content)
          if (anchors.length === 0) continue
          const key = stepKey(item.content)
          const done = proven.get(key) ?? new Set<string>()
          for (const anchor of anchors) {
            if (done.has(anchorId(anchor))) continue
            const token = evidenceFor(proof, anchor).find((candidate) => !spent.has(candidate))
            if (!token) continue
            done.add(anchorId(anchor))
            spent.add(token)
          }
          proven.set(key, done)
          if (anchors.every((anchor) => done.has(anchorId(anchor)))) {
            item.status = 'completed'
            ticked.push(item.content)
          }
        }
      }

      if (ticked.length > 0) {
        // Exactly one step in progress: the first one still open.
        const firstOpen = items.findIndex((item) => item.status !== 'completed')
        items.forEach((item, index) => {
          if (item.status !== 'completed') item.status = index === firstOpen ? 'in_progress' : 'pending'
        })
        list.write(items)
        lastSeen = items.map((item) => ({ ...item }))
        actionsSinceUpdate = 0
        const numbered = (content: string): string => `${items.findIndex((item) => item.content === content) + 1}. ${clip(content, 90)}`
        const next = firstOpen >= 0 ? items[firstOpen] : undefined
        return {
          update: { items: items.map((item) => ({ ...item })), ticked },
          note:
            `[elia] Plan updated from what just ran: ${ticked.map((content) => `✓ ${numbered(content)}`).join('; ')}. ` +
            (next ? `Now in progress: ${numbered(next.content)}. ` : 'Every step is done. ') +
            'Your todo list already shows this — no todo_write needed for it.',
        }
      }

      const open = items.filter((item) => item.status !== 'completed')
      if (open.length === 0 || nudges >= MAX_STALE_NUDGES || actionsSinceUpdate < STALE_PLAN_ACTIONS * 2 ** nudges) return {}
      nudges += 1
      const staleFor = actionsSinceUpdate
      actionsSinceUpdate = 0
      const shown = open.slice(0, 4).map((item) => `${MARK[item.status]} ${items.indexOf(item) + 1}. ${clip(item.content, 80)}`)
      const current = open.find((item) => item.status === 'in_progress') ?? open[0]!
      return {
        nudge:
          `[elia] Your plan has not changed in ${staleFor} actions. Still open: ${shown.join('; ')}${open.length > shown.length ? `; +${open.length - shown.length} more` : ''}. ` +
          'If any of these is done, call todo_write now and mark it completed, with the next step in_progress — the user is watching this plan. ' +
          `If you are still on step ${items.indexOf(current) + 1}, carry on; no update is needed.`,
      }
    },
  }
}

/** The plan as the Ink panel reads it — the glyphs it draws. */
export function planChecklist(items: TodoItem[]): string {
  return items.map((item) => `${MARK[item.status]} ${item.content}`).join('\n')
}

export function planProgressTitle(items: TodoItem[]): string {
  const done = items.filter((item) => item.status === 'completed').length
  return done === items.length ? `Plan complete · ${done}/${items.length}` : `Plan · ${done}/${items.length} done`
}
