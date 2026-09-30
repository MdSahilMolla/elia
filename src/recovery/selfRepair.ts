import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { diagnosticsPath } from '../diagnostics.ts'
import { paths, ELIA_ROOT } from '../statePaths.ts'
import { describeFault, groupFaults, readFaults, type FaultGroup } from './faults.ts'
import { describeUncleanExits, findUncleanExits, type UncleanExit } from './uncleanExits.ts'

/**
 * elia repairing elia.
 *
 * The recorded faults (faults.ts) say what broke, where in elia's source, and
 * how often. That is exactly the material a repair needs, and elia already has
 * the machinery to do a repair properly — plan, reproduce, fix, verify against
 * the real test suite, review (autonomy/loop.ts). So self-repair is not a new
 * engine. It is a goal written from the evidence, handed to `elia auto`, run on
 * elia's own source.
 *
 * Three constraints decide how, and they come from what could go wrong:
 *
 * - The fix must not land where the person is working. It runs in its own git
 *   worktree on its own branch, `elia/self-repair-<signature>`, off the
 *   checkout's HEAD. Nothing is merged, pushed or installed; the person reviews
 *   the branch and merges it, or does not.
 * - It must be asked for. A repair spends model money and edits code, so it runs
 *   from `elia doctor --repair`, never on its own after a crash.
 * - It needs a source checkout. An install from npm has no git history and no
 *   tests to prove a fix, so there it stops and says what to report instead of
 *   pretending.
 */

export interface SelfRepairTarget {
  /** elia's source root. */
  root: string
  /** Whether it is a git checkout a repair can branch from. */
  checkout: boolean
  branch: string
  worktree: string
}

export function selfRepairTarget(signature: string, root: string = ELIA_ROOT): SelfRepairTarget {
  return {
    root,
    checkout: existsSync(join(root, '.git')) && existsSync(join(root, 'package.json')),
    branch: `elia/self-repair-${signature}`,
    worktree: join(dirname(root), `${basename(root)}-self-repair-${signature}`),
  }
}

/**
 * The goal for the repair run. It asks for the reasoning in the order that
 * finds causes rather than symptoms: the failed assumption first, a reproduction
 * second, the fix third, proof last.
 */
export function repairBrief(group: FaultGroup): string {
  const record = group.latest
  const frames = record.frames.length > 0 ? record.frames.map((frame) => `    at ${frame}`).join('\n') : '    (no frame in elia\'s source was on the stack — start from where this error type can be thrown in the code that runs for this command)'
  const when = group.count === 1 ? `once, at ${group.firstAt}` : `${group.count} times between ${group.firstAt} and ${group.lastAt}`
  const how = group.fatal === 0
    ? `${group.count === 1 ? 'it was' : 'each time it was'} caught at the top and failed the work in progress`
    : group.count === 1 ? 'it ended the process' : `${group.fatal} of them ended the process`
  return [
    `Fix a bug in elia's own source code (${group.signature}). elia recorded this error ${when}, running \`elia ${group.commands.join('`, `elia ')}\` on version ${group.versions.join(', ')}; ${how}:`,
    '',
    `  ${record.name}: ${record.message}`,
    frames,
    '',
    'Work from first principles, not from the symptom:',
    record.frames.length > 0
      ? '1. Read the code at each frame above, innermost first. State the assumption that fails: which value is not what the code expects, and where that value comes from.'
      : '1. Find where this error can be thrown in the code that runs for that command. State the assumption that fails there: which value is not what the code expects, and where that value comes from.',
    '2. Reproduce it: write a test beside the innermost frame\'s module that fails with this error, for that reason.',
    '3. Fix the cause where the bad value is produced or accepted. A try/catch that hides the error is not a fix, and neither is a test that only asserts the error is gone.',
    '4. Run `NO_COLOR=1 ANTHROPIC_API_KEY=test-key-for-local-tests bun run typecheck` and the test you wrote, then the whole suite with `bun test`. It is done only when all of them pass.',
  ].join('\n')
}

export interface SelfRepairDeps {
  run?: (command: string[], options: { cwd: string; inherit?: boolean }) => { exitCode: number; stdout: string }
  log?: (text: string) => void
}

function defaultRun(command: string[], options: { cwd: string; inherit?: boolean }): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: process.env,
    stdin: options.inherit ? 'inherit' : 'ignore',
    stdout: options.inherit ? 'inherit' : 'pipe',
    stderr: options.inherit ? 'inherit' : 'pipe',
  })
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout ? new TextDecoder().decode(result.stdout) : '' }
}

export interface SelfRepairResult {
  status: 'not-a-checkout' | 'already-attempted' | 'worktree-failed' | 'ran'
  message: string
  exitCode?: number
}

/**
 * Runs the repair for one fault group. Blocking: it hands the terminal to the
 * `elia auto` run, then reports what reached the branch.
 */
export function runSelfRepair(group: FaultGroup, target: SelfRepairTarget, deps: SelfRepairDeps = {}): SelfRepairResult {
  const run = deps.run ?? defaultRun
  const log = deps.log ?? ((text: string) => process.stdout.write(`${text}\n`))
  if (!target.checkout) {
    return {
      status: 'not-a-checkout',
      message: `elia is installed at ${target.root}, which is not a source checkout, so there is nothing to branch and no test suite to prove a fix. Report it instead — this is what to include:\n\n${repairBrief(group)}`,
    }
  }
  const exists = run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`], { cwd: target.root })
  if (exists.exitCode === 0 || existsSync(target.worktree)) {
    return {
      status: 'already-attempted',
      message: `A repair for ${group.signature} already exists: branch ${target.branch}${existsSync(target.worktree) ? ` in ${target.worktree}` : ''}. Review it with \`git -C ${target.root} log -p HEAD..${target.branch}\`, or remove it (\`git -C ${target.root} worktree remove ${target.worktree}\` and \`git -C ${target.root} branch -D ${target.branch}\`) to try again.`,
    }
  }
  const base = run(['git', 'rev-parse', '--short', 'HEAD'], { cwd: target.root }).stdout.trim() || 'HEAD'
  const added = run(['git', 'worktree', 'add', '-b', target.branch, target.worktree, 'HEAD'], { cwd: target.root })
  if (added.exitCode !== 0) {
    return { status: 'worktree-failed', message: `Could not create the repair worktree at ${target.worktree} (git worktree add exited ${added.exitCode}). Nothing was changed.` }
  }
  // The checkout's dependencies, not a fresh install: the tests that prove the
  // fix must run against the same packages the bug happened with.
  const modules = join(target.root, 'node_modules')
  if (existsSync(modules) && !existsSync(join(target.worktree, 'node_modules'))) {
    try {
      symlinkSync(modules, join(target.worktree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // The run's own environment setup installs them if this did not work.
    }
  }

  log(`Repairing ${group.signature} — ${describeFault(group.latest)}`)
  log(`on branch ${target.branch} in ${target.worktree} (from ${base}); nothing will be merged or pushed.\n`)
  const autoRun = run([process.execPath, join(target.root, 'bin', 'elia.ts'), 'auto', repairBrief(group), '--unattended'], { cwd: target.worktree, inherit: true })

  const commits = run(['git', 'rev-list', '--count', `${base}..HEAD`], { cwd: target.worktree }).stdout.trim()
  const dirty = run(['git', 'status', '--porcelain'], { cwd: target.worktree }).stdout.split('\n').filter((line) => line.trim()).length
  const landed = Number.parseInt(commits, 10) > 0 || dirty > 0
  return {
    status: 'ran',
    exitCode: autoRun.exitCode,
    message: landed
      ? `The repair run ended (exit ${autoRun.exitCode}). On ${target.branch}: ${commits || '0'} commit(s), ${dirty} uncommitted file(s). Review with \`git -C ${target.root} diff ${base}...${target.branch}\` and read the run's receipt in ${join(target.worktree, '.elia', 'runs')}. Nothing was merged.`
      : `The repair run ended (exit ${autoRun.exitCode}) without changing anything on ${target.branch}. Its receipt in ${join(target.worktree, '.elia', 'runs')} says why.`,
  }
}

interface DiagnosticLine {
  scope?: string
  message?: string
  at?: string
}

/** The handled-error log (diagnostics.ts), counted by where it came from. Nothing read it before. */
export function summarizeDiagnostics(path: string = diagnosticsPath()): { total: number; scopes: Array<{ scope: string; count: number; last: string }> } {
  if (!existsSync(path)) return { total: 0, scopes: [] }
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { total: 0, scopes: [] }
  }
  const scopes = new Map<string, { count: number; last: string }>()
  let total = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: DiagnosticLine
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    total += 1
    const scope = parsed.scope ?? 'unknown'
    const entry = scopes.get(scope) ?? { count: 0, last: '' }
    entry.count += 1
    entry.last = parsed.message ?? entry.last
    scopes.set(scope, entry)
  }
  return { total, scopes: [...scopes.entries()].map(([scope, entry]) => ({ scope, ...entry })).sort((a, b) => b.count - a.count) }
}

export interface SelfCheck {
  groups: FaultGroup[]
  exits: UncleanExit[]
  diagnostics: ReturnType<typeof summarizeDiagnostics>
  target: Pick<SelfRepairTarget, 'root' | 'checkout'>
}

export function gatherSelfCheck(root: string = ELIA_ROOT): SelfCheck {
  return {
    groups: groupFaults(readFaults()),
    // Every unclean exit, reported or not — this is the full picture, not a notice.
    exits: findUncleanExits({ seen: new Set() }),
    diagnostics: summarizeDiagnostics(),
    target: { root, checkout: selfRepairTarget('x', root).checkout },
  }
}

/** The `elia doctor` section: what broke in elia itself, and what to do about it. */
export function renderSelfCheck(check: SelfCheck, now = Date.now()): string {
  const lines: string[] = ['', 'self-check']
  if (check.groups.length === 0) lines.push('internal errors    none recorded')
  else {
    const occurrences = check.groups.reduce((sum, group) => sum + group.count, 0)
    lines.push(`internal errors    ${check.groups.length} distinct bug(s), ${occurrences} occurrence(s) — ${paths.faults}`)
    for (const group of check.groups.slice(0, 8)) {
      const crash = group.fatal > 0 ? ` (${group.fatal} crash${group.fatal === 1 ? '' : 'es'})` : ''
      lines.push(`  ${group.signature}  ${group.count}×${crash}  ${describeFault(group.latest)}`)
      lines.push(`                last ${group.lastAt} · elia ${group.commands.join(', elia ')}`)
    }
    if (check.groups.length > 8) lines.push(`  … ${check.groups.length - 8} more`)
  }
  const exits = describeUncleanExits(check.exits, now)
  lines.push(exits ? `unclean exits      ${check.exits.length}` : 'unclean exits      none in the last 7 days')
  if (exits) lines.push(...exits.split('\n').slice(1).map((line) => `  ${line}`))
  if (check.diagnostics.total === 0) lines.push('handled errors     none logged')
  else {
    const top = check.diagnostics.scopes.slice(0, 4).map((entry) => `${entry.scope} ×${entry.count}`).join(', ')
    lines.push(`handled errors     ${check.diagnostics.total} degraded gracefully — ${top}`)
  }
  if (check.groups.length > 0) {
    lines.push(
      check.target.checkout
        ? `self-repair        elia doctor --repair [signature] — fixes the most frequent bug (or that one) on its own branch off ${check.target.root}, proved by the test suite; merges nothing`
        : `self-repair        unavailable — ${check.target.root} is an install, not a source checkout; elia doctor --repair prints what to report`,
    )
  }
  return lines.join('\n')
}
