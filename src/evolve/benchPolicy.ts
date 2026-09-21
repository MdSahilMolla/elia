/**
 * The benchmark's approval channel.
 *
 * `benchTask.ts` installed no governor, so every task ran under the default one
 * — unattended, with no approver attached. That mode refuses the whole critical
 * band outright, which is right for a scheduled run and wrong for a fixture. And
 * the critical band is where nearly all of git lives: `shell.unknown` is the
 * catch-all for anything outside the read-only command policy, so `git clone`,
 * `git checkout -b`, `git add`, `git commit` and `git push` were all refused,
 * along with `git remote -v` and `git config --list`, which read and nothing
 * else. A task that asks elia to work in a second repository could not take its
 * first step.
 *
 * That is exactly what happened. `field-external-contribution` scored 0/3 with
 * "the fork has no branch besides main — nothing was pushed to it", while every
 * other task in the suite sat at 100%. The one task with headroom was measuring
 * the policy, so the promotion gate had nothing real left to compare and six
 * generations in a row were decided by token and timing noise.
 *
 * `fieldSuite.ts` already states the rule this file implements — a task stays
 * unscored "until the benchmark has a sanctioned way" to take the action it
 * needs. This is that sanction, and it is the narrowest one that makes the
 * offline tasks winnable: git, run inside the task's own temporary repository,
 * reaching nothing outside it. The fork in that task is a bare repo on disk, so
 * pushing to it reaches nobody. A remote at github.com is refused here exactly
 * as it is in a scheduled run, and so is the rest of the critical band — `rm
 * -rf`, `curl | sh`, `npm publish`, a message to a person, a forced push.
 *
 * Immutable (`sandbox.ts` IMMUTABLE_FILES), and self-contained on purpose: a
 * candidate that could widen this, or could edit something it imports, could
 * approve its own way onto the network in the middle of being measured. Only
 * types are imported; everything they describe is checked again here.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ActionApproval, ActionAssessment, ActionRequest } from '../autonomy/governor.ts'

/**
 * The only intents a fixture may approve.
 *
 * `shell` and `shell.unknown` are where git lands — the first for the commands
 * the critical pattern names outright (`push`, `reset --hard`, `clean -fd`), the
 * second for everything the read-only policy simply does not recognise, which is
 * most of git. Both are narrowed to git alone below. The other shell intents
 * keep their refusal by being absent: `shell.composed` is a pasted script,
 * `shell.sensitive-read` a credential read, `shell.external-write` and
 * `shell.remote` reach off the machine, `shell.code-exec` runs a package's build
 * scripts. None of those is a step in an offline fixture.
 *
 * `github.push` is the tool route to the same act as `git push`.
 * `github.push.force` is absent, and so is `github.contribute`: forking happens
 * on GitHub, and a benchmark that reaches GitHub is not offline.
 */
const APPROVABLE_INTENTS: ReadonlySet<string> = new Set(['shell', 'shell.unknown', 'github.push'])

/**
 * Flags that name a program for git to run on the other end of a transfer.
 * Against a local repository git executes it here, which turns `git push` into
 * "run this" — the one thing this channel exists to not be. Refused outright
 * rather than stepped over, whatever the program is and wherever it sits.
 */
const EXEC_FLAGS: ReadonlySet<string> = new Set(['--receive-pack', '--upload-pack', '--exec'])

/**
 * Push flags whose separate value is not a remote. `--repo <name>` is absent on
 * purpose: its value *is* the remote, so reading it as one is correct.
 */
const PUSH_FLAG_WITH_VALUE: ReadonlySet<string> = new Set(['-o', '--push-option'])

/** The flag's name, with any inline `=value` removed. */
function flagName(token: string): string {
  return token.split('=')[0] ?? ''
}

/** Long flags that rewrite history. */
const FORCING_LONG_FLAGS: ReadonlySet<string> = new Set(['--force', '--force-with-lease', '--force-if-includes'])

/**
 * Whether this push rewrites history: `--force`, `--force-with-lease`, a short
 * flag cluster containing `f`, or a `+refs/…` refspec. Refused even against a
 * fixture, for the reason the governor refuses it anywhere — the act is not
 * reversible, so no task gets to practise it. The rule is identical on both
 * routes, so a candidate cannot reach through `run_command` for something the
 * `github` tool denies it.
 *
 * Clusters are why this reads tokens instead of matching the raw command. git's
 * parse-options accepts combined short flags, so `-uf` is `--set-upstream
 * --force` — and a pattern looking for a whitespace-delimited `-f` never sees
 * it, which left the looser route open on exactly the act both routes name.
 */
function isForcedPush(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (token.startsWith('--')) {
      if (FORCING_LONG_FLAGS.has(flagName(token))) return true
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      // `-o` swallows the rest of its cluster as a value, so an `f` after one is
      // that value rather than the force flag.
      const cluster = token.slice(1)
      const valueAt = cluster.indexOf('o')
      if ((valueAt < 0 ? cluster : cluster.slice(0, valueAt)).includes('f')) return true
      continue
    }
    if (token.startsWith('+') && token.includes(':')) return true
  }
  return false
}

/** Writes that land in the user's own config rather than in the fixture. */
const OUT_OF_TREE_CONFIG = /^--(?:global|system)$/i

/** A remote that is somewhere else entirely: `https://…`, `git://…`, or `git@host:owner/repo`. */
const NETWORK_REMOTE = /^[a-z][a-z0-9+.-]*:\/\//i
const SCP_REMOTE = /^[^/\\]+@[^/\\:]+:/

function isNetwork(target: string): boolean {
  return NETWORK_REMOTE.test(target) || SCP_REMOTE.test(target)
}

/** 8.3 short names and symlinks make two spellings of one directory; compare the resolved form. */
function real(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/** Whether `target` is `root` itself or sits underneath it. */
export function within(root: string, target: string): boolean {
  const rel = relative(real(root), real(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function git(args: string[], cwd: string): string | undefined {
  try {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
    if (run.status !== 0) return undefined
    const out = run.stdout.trim()
    return out || undefined
  } catch {
    return undefined
  }
}

/**
 * Where a `git push` run in `cwd` would actually send commits.
 *
 * Returns the destination as a path or URL, or undefined when that cannot be
 * answered — an unresolvable remote is refused rather than assumed local, since
 * the whole point of this check is that the approval names a real place.
 */
export function pushDestination(command: string, cwd: string): string | undefined {
  const tokens = shellTokens(command)
  const pushAt = tokens.findIndex((token) => token === 'push')
  if (pushAt < 0) return undefined
  // The first bare word after `push` is the remote. Flags are stepped over, and
  // the few taking a separate value have that value stepped over with them:
  // without it `git push --receive-pack ./x origin` reads `./x` as the
  // destination and vets somewhere the push was never going.
  let named: string | undefined
  for (let i = pushAt + 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (token.startsWith('-') && token.length > 1) {
      if (PUSH_FLAG_WITH_VALUE.has(token)) i += 1
      continue
    }
    named = token
    break
  }
  if (named) return resolveRemote(named, cwd)
  // A bare `git push` follows the current branch's upstream.
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd)
  const remote = upstream?.split('/')[0]
  return remote ? resolveRemote(remote, cwd) : undefined
}

/** A remote given as a name, a path, or a URL, resolved to what git would use. */
function resolveRemote(nameOrPath: string, cwd: string): string | undefined {
  if (isNetwork(nameOrPath)) return nameOrPath
  const configured = git(['remote', 'get-url', nameOrPath], cwd)
  if (configured) return isNetwork(configured) ? configured : resolve(cwd, configured)
  const asPath = resolve(cwd, nameOrPath)
  return existsSync(asPath) ? asPath : undefined
}

/**
 * Split a command the way a shell would, keeping quoted runs whole.
 *
 * Naive whitespace splitting is not good enough here: this machine's temp
 * directory sits under a home folder with spaces in it, so `git clone "C:\Users\MD
 * SAHIL MOLLA\...\fork.git" workspace/fork` would otherwise arrive as three
 * tokens, two of which look like absolute paths outside the fixture — and the
 * approval would be refused for a command that is entirely inside it.
 */
export function shellTokens(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let quoted = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      quoted = true
      continue
    }
    if (/\s/.test(char)) {
      if (current || quoted) tokens.push(current)
      current = ''
      quoted = false
      continue
    }
    current += char
  }
  if (current || quoted) tokens.push(current)
  return tokens
}

function stringInput(request: ActionRequest, key: string): string | undefined {
  const value = request.input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Whether a token names somewhere outside the fixture.
 *
 * Bare words are left alone: they are subcommands, branch names, remote names
 * and messages, and a remote name is resolved properly where it matters (the
 * push destination). What is checked here is anything that could point out of
 * the tree — a URL, an absolute path, or a relative path that climbs past the
 * task root, whether it is a clone source, a `--work-tree`, or a file argument.
 */
function escapesFixture(token: string, root: string, cwd: string): boolean {
  if (isNetwork(token)) return true
  if (token.startsWith('-')) return false
  if (!isAbsolute(token) && !/[\\/]/.test(token)) return false
  return !within(root, resolve(cwd, token))
}

/** The directory a git command really runs in, once `-C` is taken into account. */
function effectiveCwd(tokens: string[], cwd: string): string {
  let current = cwd
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] === '-C' && tokens[i + 1]) {
      current = resolve(current, tokens[i + 1]!)
      i += 1
      continue
    }
    const inline = /^--(?:git-dir|work-tree)=(.+)$/.exec(tokens[i] ?? '')
    if (inline) current = resolve(current, inline[1]!)
  }
  return current
}

/**
 * The approval a benchmark task runs under.
 *
 * `root` is the task's temporary repository — the directory `benchTask.ts` was
 * spawned in. Everything the approver says yes to has to stay inside it.
 */
export function createBenchApproval(root: string): ActionApproval {
  return async (assessment: ActionAssessment, request: ActionRequest): Promise<boolean> => {
    if (!APPROVABLE_INTENTS.has(assessment.intent)) return false
    // A resource the assessment named that lies outside the fixture is decisive
    // on its own: a protected path or a file above the task directory is never
    // this task's business, whatever the command looks like.
    if (assessment.resources.some((resource) => resource && !within(root, resolve(root, resource)))) return false

    if (request.name === 'github') return approveGithubPush(root, request)
    if (request.name !== 'run_command') return false

    const command = stringInput(request, 'command')
    if (!command) return false

    const tokens = shellTokens(command)
    // Only git. The approvable intents also hold `rm -rf`, `npm publish` and
    // every unrecognised command; approving those because they happen to run in
    // a temp directory would make this a hole rather than a channel.
    if (!/^git(\.exe)?$/i.test(tokens[0] ?? '')) return false
    if (tokens.some((token) => OUT_OF_TREE_CONFIG.test(token))) return false
    if (tokens.some((token) => EXEC_FLAGS.has(flagName(token)))) return false

    const declared = stringInput(request, 'cwd')
    const base = declared ? resolve(root, declared) : root
    if (!within(root, base)) return false
    const cwd = effectiveCwd(tokens, base)
    if (!within(root, cwd)) return false
    if (tokens.slice(1).some((token) => escapesFixture(token, root, cwd))) return false

    if (!tokens.includes('push')) return true
    if (isForcedPush(tokens)) return false
    const destination = pushDestination(command, cwd)
    if (!destination || isNetwork(destination)) return false
    return within(root, destination)
  }
}

/** `github push` goes to the checkout's `origin`, so that is what has to be local. */
function approveGithubPush(root: string, request: ActionRequest): boolean {
  if (request.input.force === true) return false
  const dirInput = stringInput(request, 'dir')
  const dir = dirInput ? resolve(root, dirInput) : root
  if (!within(root, dir)) return false
  const origin = resolveRemote(stringInput(request, 'remote') ?? 'origin', dir)
  if (!origin || isNetwork(origin)) return false
  return within(root, origin)
}
