import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_ARTIFACT_PATHS } from '../battmann/artifactPaths.ts'
import { DATASCIENCE_TOOLS, datascienceEffect } from '../datascience/effects.ts'
import { skillCapability } from '../skills/capabilities.ts'
import { currentAgent, isPathWithinWorkspace, resolveWorkspacePath } from './context.ts'
import { assertWriteWithinSessionScope, currentSessionScope } from '../session/scope.ts'
import { commandMayReadSensitiveData } from './sensitivePaths.ts'
import { pauseToolSpinner, resumeToolSpinner } from '../ui/stream.ts'
import { applyPolicy } from './policy.ts'
import { assessDatabaseRequest } from '../devdb/policy.ts'
import { addAllowRule, canPersistPrefixRule, isAllowlisted, ruleFor, type AllowScope } from './allowStore.ts'
import { consumePreauth, currentBranch, isPreauthorized, preauthPath } from './preauth.ts'
import { approveSelfEditFile, needsSelfEditApproval, SELF_EDIT_INTENT, selfEditLabel, selfEditRefusal, setSelfEditAllowed } from './selfEdit.ts'
import { resolve as resolvePath } from 'node:path'
import { REPORTING_TOOLS } from './reportingTools.ts'

export type ActionRisk = 'safe' | 'review' | 'critical'
export type ActionDecision = 'allow' | 'approve' | 'block'
export type GovernanceMode = 'supervised' | 'unattended'

export interface ActionRequest {
  name: string
  input: Record<string, unknown>
}

export interface ActionAssessment {
  risk: ActionRisk
  decision: ActionDecision
  reason: string
  intent: string
  resources: string[]
  reversible: boolean
}

export interface ActionGateResult {
  allowed: boolean
  message?: string
  assessment: ActionAssessment
  /**
   * Refused because there is no approval channel at all (unattended, no
   * terminal). No person was asked and none can be later in this run, so the
   * refusal is a policy block — not a decision left waiting on someone.
   */
  noApprover?: boolean
}

/**
 * What an approver hands back. A bare `boolean` still works (that is the whole
 * legacy surface); an object lets the interactive approver also say "and
 * remember this" or "no — here is what to do instead".
 */
export interface ApprovalOutcome {
  approved: boolean
  /**
   * Persist a rule so this class of action stops prompting:
   *   - `session` → in memory, this run only
   *   - `project` → `.elia/allow.json`
   *   - `global`  → `~/.elia/allow.json`
   */
  remember?: 'session' | AllowScope
  /** On a denial: operator guidance to surface back to the model. */
  feedback?: string
}

export type ApprovalResult = boolean | ApprovalOutcome

export type ActionApproval = (assessment: ActionAssessment, request: ActionRequest) => Promise<ApprovalResult>

export interface ActionGovernorStats {
  maxActions: number
  consumed: number
  exhausted: boolean
  blockedByBudget: number
}

export interface ActionGovernor {
  check(request: ActionRequest): Promise<ActionGateResult>
  stats(): ActionGovernorStats
  /**
   * The governance mode this governor enforces. Exposed so durable-action
   * approvals (goalGraph.ts) can be scoped to the mode that granted them — an
   * approval from a supervised session must not fund an unattended resume.
   */
  mode: GovernanceMode
}

const CRITICAL_COMMAND = /\b(rm\s+-rf|rm\s+--no-preserve-root|mkfs|dd\s+if=|shutdown|reboot|poweroff|drop\s+(database|table)|truncate\s+table|git\s+(push|reset\s+--hard|clean\s+-fd)|force[- ]push|sudo\b|chmod\s+777|chown\s+-R|kill\s+-9|kubectl\s+(apply|delete|rollout|scale)|helm\s+(install|upgrade|uninstall)|docker\s+(push|rm|system\s+prune|deploy)|terraform\s+(apply|destroy)|prisma\s+migrate\s+(deploy|reset)|alembic\s+upgrade|drizzle-kit\s+push|npm\s+publish|pnpm\s+publish|bun\s+publish|vercel\s+(?:deploy|.*--prod)|(?:firebase|netlify|amplify|serverless|now|wrangler|edgio|fastlane)\s+(?:deploy|release|publish)|fly\s+(?:deploy|release|migrate)|railway\s+up|az\s+.*\bdeploy\b|gcloud\s+.*\bdeploy\b|aws\s+(cloudformation|ecs|rds|lambda)|gh\s+pr\s+(create|merge|close|reopen|ready|comment|review|edit|draft|delete|lock|unlock|unresolve)|curl[^\n|]*\|\s*(sh|bash)|wget[^\n|]*\|\s*(sh|bash)|deploy\s+(to\s+)?prod(uction)?|send\s+.*(email|message)|publish\b|tweet\b|buy\b|purchase\b|checkout\b|transfer\b|wire\b)\b/i
/**
 * Unattended mode auto-allows the review band by design — the code comment at
 * the SETTLEABLE_ONCE declaration below calls it "local, reversible work get a
 * standing yes". The verbs below are NOT that, which is why each is pulled OUT
 * of REVIEW_COMMAND and classified critical instead. They must never be
 * auto-allowed by an unattended run; reaching one requires an exact approval
 * boundary (or an explicit `--authorize` pre-grant), because each executes
 * arbitrary code on the host, runs inside a container that can mount the host
 * filesystem, or opens an unvalidated network channel. Deploy/PR publishing
 * verbs (firebase/netlify/fly/gh pr merge/…) were previously swallowed by the
 * broad `deploy\b`/`gh\s+pr` review matches; they are classified critical here
 * so an unattended run can never silently push changes at other people.
 */
// Package-manager installs run arbitrary build scripts (setup.py, postinstall,
// prebuild) on the host as the current user. A package a model installs is
// supply-chain code by definition.
// Start-anchored (like REMOTE_FETCH_COMMAND below) so a command that merely
// mentions these verbs as an argument — `echo npm install later` — is not
// misclassified; only the command actually being run counts. `sudo` is an
// allowed prefix modifier (it still runs the named verb, just elevated), not
// an arbitrary preceding word.
const CODE_EXEC_COMMAND = /^(?:\S+=\S+\s+)*(?:command\s+)?(?:sudo\s+)?(?:pip3?\s+install|npm\s+(?:add|install|i|ci)|pnpm\s+(?:add|install|i|ci)|yarn\s+(?:(?:global|dlx)\s+)?(?:add|install|set\s+version)|bun\s+(?:add|install|i))\b/i
// Docker build/run/exec/compose/deploy and scp/rsync/rcp/sftp execute arbitrary
// code (RUN steps, container entrypoint, remote shell) with the ability to
// mount the host filesystem or devices, or move data across a network. None of
// these are local or reversible. Start-anchored for the same reason as above.
const REMOTE_SHELL_COMMAND = /^(?:\S+=\S+\s+)*(?:command\s+)?(?:sudo\s+)?(?:docker\s+(?:build|run|exec|compose|rm|push|deploy)|ssh|scp|rsync|rcp|sftp)\b/i
// Bare curl/wget are an unvalidated data channel: even a plain GET rides data
// out of the machine in the query string, and wget writes an arbitrary
// downloaded file to disk. The model has the URL-validated, response-bounded
// http_probe/web_fetch tools for legitimate HTTP work; shell curl/wget stays
// critical. (curl/wget with --data/-d/--upload-file etc. are already caught
// by EXTERNAL_WRITE_COMMAND further down; this catches the bare GET form.)
const REMOTE_FETCH_COMMAND = /^(?:\S+=\S+\s+)*(?:command\s+)?(?:curl|wget)\b/i
// `git commit` is local, reversible work that the review band exists to
// cover. Publishing actions are NOT: `deploy` used to be classified review
// here, but "deploy" is never what starts a deployment in practice, and
// `gh\s+pr` matched every subcommand including `pr merge`. Both are dangerous
// when auto-allowed — a silent publish to people outside the project — so
// each deployment/PR verb is classified critical (CRITICAL_COMMAND) instead
// of riding the unattended review-band auto-allow.
const REVIEW_COMMAND = /\bgit\s+commit\b/i

/**
 * `git add` / `git mv` of paths inside the repository: the rest of a commit,
 * local, and undone with `git restore --staged` or another `git mv`. They were
 * classed critical (shell.unknown), so every unattended run — and the live
 * session's search attempts — was refused `git add` and could never commit its
 * own work (seen live: four refused `git add`s in a row, then a turn spinning
 * on retries). Anything else stays critical: a forced add or move (`git add -f
 * .env` is how an ignored secret gets committed; `git mv -f` overwrites), `-C`
 * or any path that leaves the tree (absolute, `~`, or through `..`).
 */
function isLocalGitStaging(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  const start = tokens[0] === 'command' ? 1 : 0
  if (tokens[start] !== 'git' || (tokens[start + 1] !== 'add' && tokens[start + 1] !== 'mv')) return false
  return tokens.slice(start + 2).every((token) => {
    if (token === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(token)) return false
    if (token.startsWith('/') || token.startsWith('~') || /^[A-Za-z]:[\\/]/.test(token)) return false
    return !token.split(/[\\/]/).includes('..')
  })
}
// Checks and builds that run the project's own code and write only inside it.
// `go build`, `cargo check` and `gradlew build` were here while `npm run build`
// and a bare `tsc --noEmit` were not, so an unattended Vite app could never be
// built: its run spent every repair on a blocked build. Installing packages
// stays critical (CODE_EXEC_COMMAND, matched first); only `--authorize` lifts it.
const READ_ONLY_COMMAND = /^(?:command\s+)?(?:pwd|ls|find|grep|rg|git\s+(?:status|diff|log|show|branch)|gh\s+pr\s+(?:view|list|checks|status|diff)|(?:bun|npm|pnpm|yarn)\s+(?:test|run\s+(?:test|typecheck|type-check|tsc|check-types|lint|format\s+--check|check|build))|(?:npx\s+(?:--no-install\s+)?)?tsc\s+--noEmit|cargo\s+(?:check|test|clippy)|go\s+(?:build|test|vet)\b[^\n]*|mvn\s+(?:-[^\s]+\s+)*(?:compile|test-compile|test)\b[^\n]*|(?:\.\/)?gradlew(?:\.bat)?\s+(?:build|test|check|compileJava|compileTestJava)\b[^\n]*|gradle\s+(?:build|test|check|compileJava|compileTestJava)\b[^\n]*|ctest\b[^\n]*|(?:(?:python3?|py)(?:\.exe)?\s+-m\s+)?(?:pytest|mypy)\b[^\n]*|(?:python3?|py)(?:\.exe)?\s+-m\s+unittest\b[^\n]*|node\s+--version|bun\s+--version|npm\s+--version|printf|echo|cat|head|tail|sed|awk|dir|type|findstr)\b/i
// `sed`/`awk` are allowed above only for their plain print-to-stdout form.
// Both also support in-place file rewriting (`sed -i`, `sed --in-place`,
// `awk -i inplace`) which overwrites the target file — a write, not a read.
// Matched separately so assessCommand can exclude it from the read-only
// allowance the same way it already excludes mv/cp/chmod etc. below.
const SED_AWK_INPLACE_EDIT = /\b(?:sed|gsed|awk|gawk)\b[\s\S]*?(?:(?:^|\s)-i(?:[^\s]*)?(?:\s|$)|--in-place\b)/i
// `git branch` is read-only-by-default (no args, or a listing flag), but the
// same subcommand also deletes (-d/-D/--delete), force-renames (-M), or
// otherwise mutates a branch — none of which READ_ONLY_COMMAND's word-level
// match can tell apart from a plain listing. Allow-list the genuinely
// read-only invocations instead of trying to deny-list every destructive flag.
const GIT_BRANCH_LIST_ONLY = /^(?:command\s+)?git\s+branch(?:\s+(?:-a|-r|-v|-vv|--list|--all|--remotes|--verbose|--show-current|--sort=\S+|--contains(?:=\S+|\s+\S+)?|--merged(?:=\S+|\s+\S+)?|--no-merged(?:=\S+|\s+\S+)?))*\s*$/i
// CR/LF anywhere means a chain or a pasted script, not one verified
// invocation. Rejecting it syntactically here (up front in assessCommand,
// before any other gate) means a harmless first line can never carry a
// harmful tail past the start-anchored read-only allowance.
const SHELL_CONTROL_SYNTAX = /[;&|<>`$]|[\r\n]|\$\(|\b(?:eval|exec|source)\b/i
const SECRET_KEY = /(password|passwd|token|secret|api[-_]?key|authorization|cookie|credential)/i
// Every data-upload form of curl/wget transmits local content to a remote
// host — inline `-d`/`--data`, `-d@file`/`--data @file` (payload read from a
// file), `-F`/`--form` (multipart, typically a file upload), and `-T`/
// `--upload-file`. The old pattern required whitespace on both sides of `-d`,
// so `curl -d@secret.txt` and the whole `-F`/`-T` families fell through to the
// merely-`review` bucket and were auto-allowed in unattended runs. The short
// options are matched in an explicit case-sensitive pass so that curl's
// harmless lowercase `-f`/`-t` flags are not swept up by /i.
const EXTERNAL_WRITE_COMMAND = /\b(curl|wget)\b[^\n]*(\s-X\s*(?:POST|PUT|PATCH|DELETE)|--data(?:-raw|-binary|-urlencode)?|--upload-file|--form|--post-file|--post-data|--body-data|--request\s+(?:POST|PUT|PATCH|DELETE)|-d@)/i
const EXTERNAL_WRITE_SHORT_OPTIONS = /\b(curl|wget)\b[^\n]*(?:^|\s)-(?:[a-zA-Z]*[FT]|d\s|d@)/
// Values that a tool interpolates, unquoted, into a shell command line. Unlike
// run_command (whose whole command is assessed), causal_debug's `file` and
// causal_verify's `test_file`/`test_pattern` become tokens inside strings the
// tool builds, so any of these characters can escape the intended command. The
// governor rejects them at the boundary rather than trusting shell quoting.
const SHELL_TOKEN_BREAK = /[;&|<>`$'"\\\r\n]/
// A newline in a whole reproduction command silently splits it into a second
// command line in both `sh -c` and `cmd /c`.
const COMMAND_NEWLINE = /[\r\n]/
const DESTRUCTIVE_SHELL_VERBS = /\b(?:rm|mv|cp|mkdir|touch|chmod|chown|kill|shutdown|reboot|publish|push|apply|delete|destroy|install|add|upgrade|send|curl|wget|ssh|scp)\b/i
const SHELL_SIDE_EFFECT = /[<>]/i
/**
 * Tools that only hand a structured answer back to the harness that asked for
 * it: they close over a local variable, return a string, and touch no file, no
 * process and no network. They are named here because the fallthrough at the
 * bottom of `assessAction` treats an unrecognised tool as critical — correct for
 * anything that might reach a real system, and fatal for a reporter, which in an
 * unattended run is refused outright and leaves the phase with no answer.
 *
 * That is not hypothetical. `submit_hypothesis` and `submit_strategy` were
 * missing from this list, so every `elia evolve` proposer did its analysis, went
 * to submit, and was blocked by elia's own unattended policy — which is why the
 * self-improvement loop had proposed nothing in its entire history. The list is
 * built from the canonical `REPORTING_TOOLS` (a leaf module, so there is no
 * import cycle to work around) plus the two governor-only reporting tools that
 * the goal graph does not deduplicate.
 */
const INTERNAL_SAFE_TOOLS = new Set<string>([
  ...REPORTING_TOOLS,
  'flag_risk',
  'delegate_tasks',
])
export const MAX_GOVERNED_ACTIONS = 10_000

/**
 * Roles whose workers get no write tools — `canWrite: false` in roles.ts. Kept
 * here as a literal because importing roles.ts would pull the tool registry
 * (and with it the `task` tool, which imports this module) into a cycle;
 * governor.test.ts fails if the two lists drift.
 */
export const READ_ONLY_ROLES: ReadonlySet<string> = new Set(['scout', 'designer', 'accessibility', 'critic', 'security', 'bughunter'])

const DATASCIENCE_TOOL_NAMES: ReadonlySet<string> = new Set(DATASCIENCE_TOOLS)

/** Secret-bearing paths as analysis code names them (open('.env'), Path.home() / '.aws' / …). */
const PYTHON_SECRET_PATH = /(?:^|[\s'"/\\(])\.env(?:\.[\w.-]+)?\b|\.(?:ssh|aws|azure|kube|gnupg|docker)\b|\.(?:netrc|npmrc|pypirc|git-credentials)\b|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\.config[\\/]gcloud|battmann[\w.-]*\.sqlite|\.(?:pem|p12|pfx)\b/i

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * Data-science mode actions, assessed from the effect table the engine itself is checked
 * against (datascience/effects.ts). Analysis and workspace-local writes proceed on their own —
 * they only add new versioned datasets, models, records, and artifacts under .elia/datascience
 * and never modify a source. Anything that reaches a live database, sends a stored credential,
 * runs model-written code, writes into the project, or installs packages asks first.
 */
function assessDataScience(name: string, input: Record<string, unknown>, cwd: string): ActionAssessment {
  const action = typeof input.action === 'string' ? input.action : ''
  const intent = `${name}.${action || 'unknown'}`
  const effect = datascienceEffect(name, action, input)
  if (!effect) return assessment('safe', 'allow', `${name} has no action "${action}"; the engine refuses it and lists the valid actions without running anything`, intent, [], true)
  const paths = ['path', 'geojson'].map((key) => input[key]).filter((value): value is string => typeof value === 'string' && value.length > 0)
  const outside = paths.filter((path) => !isPathWithinWorkspace(path, cwd))
  if (outside.length) return assessment('critical', 'approve', `${intent} names a path outside the active workspace`, intent, outside, false)
  if (intent === 'ds_data.export' && paths.length) return assessment('review', 'approve', `${intent} writes an exported file into the project at ${paths[0]} (never over a registered source file)`, intent, paths, false)
  switch (effect) {
    case 'compute':
      return assessment('safe', 'allow', `${intent} is deterministic analysis of workspace datasets; it writes only its execution record`, intent, [], true)
    case 'local-write':
      return assessment('safe', 'allow', `${intent} adds a new versioned dataset, model, or plan under .elia/datascience; sources and earlier versions are never modified`, intent, paths, true)
    case 'artifact-write':
      return assessment('safe', 'allow', `${intent} writes derived files under .elia/datascience/artifacts`, intent, [], true)
    case 'network-read': {
      const url = typeof input.url === 'string' ? input.url : ''
      const headerEnv = input.headers && typeof input.headers === 'object' ? Object.values(input.headers as Record<string, unknown>).flatMap((value) => typeof value === 'string' ? [...value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((match) => match[1]!) : []) : []
      const credentials = [...headerEnv, ...(typeof input.urlEnv === 'string' ? [input.urlEnv] : [])]
      const target = url ? [url.replace(/\?.*$/, '')] : []
      if (url.startsWith('s3://')) return assessment('review', 'approve', `${intent} reads an object storage key with the ambient cloud credentials`, intent, target, true)
      if (credentials.length) return assessment('review', 'approve', `${intent} sends the stored credential${credentials.length > 1 ? 's' : ''} ${credentials.map((env) => `$${env}`).join(', ')} to ${url ? hostOf(url) : 'the URL in that variable'}`, intent, target, true)
      if (input.allowLocal === true) return assessment('review', 'approve', `${intent} reads from an API on a local or private network address`, intent, target, true)
      return assessment('safe', 'allow', `${intent} is a bounded read-only GET restricted to public http(s) addresses; the response becomes a new workspace dataset`, intent, target, true)
    }
    case 'database-read': {
      const connection = typeof input.connection === 'string' ? input.connection : 'database'
      const credential = typeof input.dsnEnv === 'string' ? ` with the credential in $${input.dsnEnv}` : ''
      return assessment('review', 'approve', `${intent} queries a live ${connection} database${credential}; only SELECT/WITH passes the SQL guard and it runs read-only, but the query reaches the system of record`, intent, [], true)
    }
    case 'process':
      if (action === 'capabilities') return assessment('safe', 'allow', `${intent} probes the Python interpreter for installed packages`, intent, [], true)
      return typeof input.code === 'string' && PYTHON_SECRET_PATH.test(input.code)
        ? assessment('critical', 'approve', `${intent} runs Python that names a credential or secret-bearing path`, intent, [], false)
        : assessment('review', 'approve', `${intent} runs model-written Python in a separate process (scrubbed environment, time and memory limits; a container only when ELIA_SANDBOX=container)`, intent, [], true)
    case 'install':
      return assessment('critical', 'approve', `${intent} downloads and installs third-party packages from PyPI into .elia/datascience/venv`, intent, [], false)
  }
  return assessment('critical', 'approve', `${intent} has an unrecognised effect`, intent, paths, false)
}

export function assessAction(request: ActionRequest, cwd = currentAgent().cwd ?? process.cwd()): ActionAssessment {
  const { name, input } = request
  if (INTERNAL_SAFE_TOOLS.has(name)) return assessment('safe', 'allow', `${name} records structured control-flow metadata`, name, [], true)
  const values = Object.values(input).filter((value): value is string => typeof value === 'string')
  const joined = values.join(' ')
  const resources = values.filter((value) => /[\\/]|https?:\/\//i.test(value)).slice(0, 4)

  if (name === 'run_command') return assessCommand(joined, cwd)
  if (name === 'run_program') {
    const program = typeof input.program === 'string' ? input.program : ''
    const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : []
    return assessCommand([program, ...args].join(' '), cwd)
  }
  // `process start` launches a shell command exactly as run_command does — it
  // just doesn't wait for it — so it gets the same command assessment. The
  // other actions only read or stop processes this session itself started.
  if (name === 'process') {
    const action = typeof input.action === 'string' ? input.action : ''
    if (action === 'start') return assessCommand(typeof input.command === 'string' ? input.command : '', cwd)
    if (action === 'logs' || action === 'list' || action === 'stop') {
      return assessment('safe', 'allow', `process ${action} only touches processes this session started`, `process.${action}`, [], action !== 'stop')
    }
    return assessment('critical', 'approve', `process ${action || '(no action)'} is not a known process action`, 'process', resources, false)
  }

  if (name === 'presentation') {
    return assessment('review', 'approve', 'presentation generation creates a derived document artifact', 'presentation.from_workbook', resources, true)
  }

  if (name === 'project_profile') {
    return assessment('safe', 'allow', 'project profiling is a local, read-only repository inspection', 'project_profile', resources, true)
  }

  if (name === 'production_readiness') {
    return assessment('safe', 'allow', 'production readiness is a repository-only, read-only evidence audit', 'production_readiness', resources, true)
  }

  if (name === 'deployment') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    const target = typeof input.target === 'string' ? input.target : 'unknown'
    if (action === 'plan' || action === 'build' || action === 'verify') {
      return assessment('review', 'approve', `deployment ${action} is a bounded release workflow step`, `deployment.${action}`, resources, true)
    }
    if (action === 'deploy' && target === 'preview') {
      return assessment('review', 'approve', 'preview deployment publishes an external build artifact for testing', 'deployment.preview', resources, true)
    }
    return assessment('critical', 'approve', 'production deployment changes the user-facing external application', 'deployment.production', resources, false)
  }

  if (name === 'environment') {
    return assessment('safe', 'allow', 'environment discovery is a local, read-only capability snapshot', 'environment.inspect', resources, true)
  }

  if (name === 'database') return assessDatabaseRequest(input, cwd)

  if (name === 'provision_environment') {
    return assessment('review', 'approve', 'provisioning installs dependencies and starts local services from a fixed setup-command allowlist', 'environment.provision', resources, true)
  }

  if (name === 'github') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    if (action === 'status' || action === 'pr_view' || action === 'pr_list' || action === 'pr_checks' || action === 'pr_checks_log' || action === 'pr_reviews' || action === 'pr_unresolved_reviews' || action === 'issue_list' || action === 'issue_view') {
      return assessment('safe', 'allow', `github ${action} only reads local git and GitHub state`, `github.${action}`, resources, true)
    }
    if (action === 'contribute_status') {
      return assessment('safe', 'allow', 'github contribute_status only reads elia’s own record of external contributions', 'github.contribute_status', resources, true)
    }
    if (action === 'branch' || action === 'commit' || action === 'sync') {
      return assessment('safe', 'allow', `github ${action} is a local, checkpointable change to version control`, `github.${action}`, resources, true)
    }
    // Starting a contribution forks the target repository, which creates a new
    // repository under the user's own GitHub account and is visible to anyone
    // looking at the source project's fork list. The clone that follows is
    // local and harmless; the fork is the part that needs a person's yes, so
    // the whole action is asked for once, naming the repository.
    if (action === 'contribute') {
      const ref = typeof input.ref === 'string' ? input.ref : typeof input.repo === 'string' ? input.repo : 'a repository'
      return assessment('review', 'approve', `github contribute forks ${ref} to the user's GitHub account and clones it locally`, 'github.contribute', resources, true)
    }
    if (action === 'push') {
      return input.force === true
        ? assessment('critical', 'approve', 'github force-push can overwrite remote history and is not safely reversible', 'github.push.force', resources, false)
        : assessment('review', 'approve', 'github push publishes local commits to the origin remote', 'github.push', resources, true)
    }
    if (action === 'pr_create') {
      // A PR into a repository this checkout does not belong to is a public act
      // inside someone else's project: maintainers are notified, CI runs on
      // their account, and closing it afterwards does not unsend any of that.
      // It is a different thing from proposing a branch in the user's own repo,
      // so it gets its own contract and its own approval rather than inheriting
      // that one's standing yes.
      if (typeof input.repo === 'string' && input.repo.trim()) {
        return assessment('critical', 'approve', `github pr_create opens a public pull request on ${input.repo.trim()}, a repository outside this project`, 'github.pr_create.upstream', resources, false)
      }
      return assessment('review', 'approve', 'github pr_create opens a pull request on the remote', 'github.pr_create', resources, true)
    }
    // Creating a repository publishes the whole project under a new name on the
    // user's account. It is a one-time, clearly describable act — repo name and
    // visibility — so it is asked once rather than refused, but never assumed.
    if (action === 'repo_create') {
      return assessment('critical', 'approve', 'github repo_create publishes this project as a new repository on the user’s account', 'github.repo_create', resources, false)
    }
    // Issues and milestones are project bookkeeping in a repository the run is
    // already pushing to, and they are reversible — closing one costs nothing.
    if (action === 'issue_create' || action === 'milestone_create') {
      return assessment('review', 'approve', `github ${action} records planned work in the project's own tracker`, `github.${action}`, resources, true)
    }
    // pr_comment posts publicly; pr_merge changes a shared branch — both need an exact boundary.
    return assessment('critical', 'approve', `github ${action} writes to the shared repository and needs an authorization record`, `github.${action}`, resources, false)
  }

  if (name === 'finance') {
    return assessment('safe', 'allow', 'finance calculations are deterministic and do not mutate external state', 'finance.analysis', resources, true)
  }

  if (name === 'sports') {
    return assessment('safe', 'allow', 'sports calculations analyze user-supplied data without mutating external state', 'sports.analysis', resources, true)
  }

  if (name === 'fitness') {
    return assessment('safe', 'allow', 'fitness planning and tracking summaries are bounded deterministic support, not medical action', 'fitness.support', resources, true)
  }

  if (name === 'data_science') {
    const path = typeof input.path === 'string' ? input.path : ''
    return path && !isPathWithinWorkspace(path, cwd)
      ? assessment('critical', 'approve', 'data-science analysis targets data outside the active workspace or uses an invalid path', 'data_science', [path], false)
      : assessment('safe', 'allow', 'data-science analysis is read-only and does not mutate the dataset', 'data_science', resources, true)
  }

  if (DATASCIENCE_TOOL_NAMES.has(name)) return assessDataScience(name, input, cwd)

  if (name === 'spreadsheet') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    if (action === 'write') return assessment('review', 'approve', 'spreadsheet write changes a workbook and creates an output artifact', 'spreadsheet.write', resources, true)
    return assessment('safe', 'allow', `spreadsheet ${action} is read-only analysis or audit`, `spreadsheet.${action}`, resources, true)
  }

  if (name === 'communication') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    if (action === 'send') return assessment('critical', 'approve', 'communication send creates an external message or event', 'communication.send', resources, false)
    if (action === 'verify') return assessment('review', 'approve', 'communication verification reads external delivery state', 'communication.verify', resources, true)
    return assessment('safe', 'allow', `communication ${action} only manages a durable draft locally`, `communication.${action}`, resources, true)
  }

  if (name === 'browser') {
    const action = typeof input.action === 'string' ? input.action : 'unknown'
    // `console` and `network` read back what the page already logged — the same
    // kind of read as `snapshot`. Classed as page-changing, each was refused in
    // unattended runs, left a pending approval, and held a finished, verified
    // invoice fix at `blocked` on two log reads its orientation scout had tried.
    if (['status', 'navigate', 'refresh', 'back', 'forward', 'snapshot', 'extract', 'console', 'network', 'scroll', 'wait', 'wait_for'].includes(action)) {
      return assessment('safe', 'allow', `browser ${action} is observational or navigation-only`, `browser.${action}`, resources, true)
    }
    return assessment('critical', 'approve', `browser ${action} changes page state and needs an authorization record`, `browser.${action}`, resources, false)
  }

  if (name === 'write_file' || name === 'edit_file' || name === 'lsp_refactor' || name === 'delete_file') {
    const path = typeof input.path === 'string' ? input.path : ''
    const outside = path.length === 0 || !isPathWithinWorkspace(path, cwd)
    if (outside) return assessment('critical', 'approve', `${name} targets a path outside the active workspace or uses an invalid path`, name, path ? [path] : [], false)
    // Inside the workspace, but the workspace is elia's own checkout — see selfEdit.ts.
    if (needsSelfEditApproval(resolvePath(cwd, path))) {
      return assessment(
        'critical',
        'approve',
        `This changes ${selfEditLabel(resolvePath(cwd, path))} — part of elia's OWN source, not a project it is building. The session was started inside elia's repository.`,
        SELF_EDIT_INTENT,
        [path],
        true,
      )
    }
    return assessment('safe', 'allow', `${name} is workspace-scoped and checkpointable`, name, path ? [path] : [], true)
  }

  if (name === 'read_file' || name === 'list_files' || name === 'grep' || name === 'find_symbol' || name === 'recall' || name === 'brain' || name === 'board_read' || name === 'board_post' || name === 'todo_write' || name === 'why' || name === 'record_rationale' || name === 'note_lesson') {
    const path = typeof input.path === 'string' ? input.path : ''
    return path && !isPathWithinWorkspace(path, cwd)
      ? assessment('critical', 'approve', `${name} may access data outside the active workspace or through an invalid path`, name, [path], false)
      : assessment('safe', 'allow', `${name} is read-only or coordination-only`, name, resources, true)
  }

  // Retrieval is read-only, but the query or URL does leave the machine, so it
  // is declared explicitly rather than left to fall through to the fail-closed
  // unknown-tool branch. web_fetch is further constrained at the tool itself:
  // http(s) only, public addresses only, redirects refused, response bounded.
  if (name === 'web_search') {
    return assessment('safe', 'allow', 'web search is read-only retrieval; the query leaves the machine but no external state changes', 'web_search', resources, true)
  }

  if (name === 'paper') {
    return assessment('safe', 'allow', 'paper lookup is read-only retrieval from public scholarly indexes; no external state changes', 'paper', resources, true)
  }
  if (name === 'web_fetch') {
    // Redirects are followed now, but each hop is re-validated against the
    // public-address policy before the socket opens, so the constraint that
    // made this safe still holds per hop rather than by refusing to move.
    return assessment('safe', 'allow', 'web fetch is a bounded read-only GET restricted to public http(s) addresses, with every redirect hop re-validated', 'web_fetch', resources, true)
  }

  if (name === 'visualize') {
    const slug = typeof input.slug === 'string' ? input.slug : ''
    if (slug && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
      return assessment('critical', 'approve', 'visualization slug is invalid and cannot be mapped to a safe workspace artifact path', 'visualize', [], false)
    }
    const artifactPaths = slug ? [`.elia/artifacts/${slug}.svg`, `.elia/artifacts/${slug}.md`] : ['.elia/artifacts']
    return assessment('safe', 'allow', 'visualize creates deterministic, workspace-scoped SVG and Markdown artifacts from bounded structured data', 'visualize', artifactPaths, true)
  }

  if (name === 'causal_debug') {
    const file = typeof input.file === 'string' ? input.file : ''
    if (file && SHELL_TOKEN_BREAK.test(file)) {
      return assessment('critical', 'approve', 'causal_debug file path contains shell metacharacters that would be interpolated unsafely', 'causal_debug', [file], false)
    }
    return assessment('safe', 'allow', 'causal_debug performs read-only git history analysis to trace causal chains', 'causal_debug', resources, true)
  }

  if (name === 'causal_fix') {
    const apply = typeof input.apply === 'boolean' ? input.apply : false
    return apply
      ? assessment('review', 'approve', 'causal_fix with apply=true writes a patch to the workspace', 'causal_fix.apply', resources, true)
      : assessment('safe', 'allow', 'causal_fix without apply is read-only analysis and plan generation', 'causal_fix', resources, true)
  }

  if (name === 'causal_verify') {
    const reproduction = typeof input.reproduction_command === 'string' ? input.reproduction_command : ''
    const testFile = typeof input.test_file === 'string' ? input.test_file : ''
    const testPattern = typeof input.test_pattern === 'string' ? input.test_pattern : ''
    // The tool turns these three inputs into shell commands (verify.ts), so the
    // "read-only" claim only holds for inputs that cannot escape the commands it
    // builds. Reject quote/control breakouts at the boundary, then assess the
    // exact command each input becomes with the same shell risk model run_command
    // uses — a reproduction_command may never smuggle an unassessed shell through.
    if (COMMAND_NEWLINE.test(reproduction) || SHELL_TOKEN_BREAK.test(testFile) || SHELL_TOKEN_BREAK.test(testPattern)) {
      return assessment('critical', 'approve', 'causal_verify input contains characters that break out of the commands it runs', 'causal_verify', resources, false)
    }
    if (!reproduction.trim() && !testFile.trim() && !testPattern.trim()) {
      return assessment('safe', 'allow', 'causal_verify with no test or reproduction inputs runs only built-in typecheck and lint checks', 'causal_verify', resources, true)
    }
    const commands: string[] = []
    if (reproduction.trim()) commands.push(reproduction)
    if (testFile.trim()) commands.push(`bun test --timeout=10000 "${testFile}"`)
    if (testPattern.trim()) commands.push(`bun test --timeout=20000 "${testPattern}"`)
    const results = commands.map((command) => assessCommand(command, cwd))
    const worst = results.find((result) => result.risk === 'critical') ?? results.find((result) => result.risk === 'review') ?? results[0]!
    return { ...worst, resources }
  }

  if (name === 'arch_drift') {
    return assessment('safe', 'allow', 'arch_drift performs read-only structural analysis to detect architectural violations', 'arch_drift', resources, true)
  }

  if (name === 'adversarial_verify') {
    return assessment('review', 'approve', 'adversarial_verify generates edge cases and tests against code changes to find vulnerabilities', 'adversarial_verify', resources, true)
  }

  if (name === 'codebase_memory') {
    const action = typeof input.action === 'string' ? input.action : 'query'
    if (action === 'record' || action === 'update') {
      return assessment('review', 'approve', 'codebase_memory write operations persist semantic recall entries to the local store', 'codebase_memory.write', resources, true)
    }
    return assessment('safe', 'allow', 'codebase_memory query is read-only semantic recall from the local store', 'codebase_memory.query', resources, true)
  }

  if (name === 'predictive_impact') {
    return assessment('safe', 'allow', 'predictive_impact performs read-only diff analysis and dependency tracing to forecast change impact', 'predictive_impact', resources, true)
  }

  if (name === 'cross_project_learn') {
    const action = typeof input.action === 'string' ? input.action : 'query'
    if (action === 'sync' || action === 'record') {
      return assessment('review', 'approve', 'cross_project_learn sync/record writes anonymized patterns to the shared store', 'cross_project_learn.write', resources, true)
    }
    return assessment('safe', 'allow', 'cross_project_learn query retrieves patterns from other projects without exposing source code', 'cross_project_learn.query', resources, true)
  }

  if (name === 'dependency_audit') {
    return assessment('safe', 'allow', 'dependency_audit inspects local package manifests and lock files without modifying them', 'dependency_audit', resources, true)
  }

  if (name === 'multi_modal_review') {
    return assessment('safe', 'allow', 'multi_modal_review performs read-only code and diff analysis for comprehensive review', 'multi_modal_review', resources, true)
  }

  if (name === 'self_healing_monitor') {
    const action = typeof input.action === 'string' ? input.action : 'status'
    if (action === 'deploy_monitor' || action === 'auto_fix') {
      return assessment('critical', 'approve', 'self_healing_monitor deploy_monitor/auto_fix can modify running systems', 'self_healing_monitor.write', resources, false)
    }
    return assessment('safe', 'allow', 'self_healing_monitor status/analyze are read-only observability operations', 'self_healing_monitor.read', resources, true)
  }

  if (name === 'federated_collab') {
    const action = typeof input.action === 'string' ? input.action : 'query'
    if (action === 'share' || action === 'broadcast') {
      return assessment('review', 'approve', 'federated_collab share/broadcast publishes anonymized patterns to the federation', 'federated_collab.write', resources, true)
    }
    return assessment('safe', 'allow', 'federated_collab query retrieves shared patterns from the federation', 'federated_collab.query', resources, true)
  }

  if (name === 'spec_verify') {
    return assessment('safe', 'allow', 'spec_verify analyzes code against specifications and generates verification reports', 'spec_verify', resources, true)
  }

  if (name === 'temporal_analysis') {
    return assessment('safe', 'allow', 'temporal_analysis performs read-only historical trend analysis of code metrics', 'temporal_analysis', resources, true)
  }

  if (name === 'battmann') {
    const action = typeof input.action === 'string' ? input.action : ''
    if (action === 'report' || action === 'report_from_store' || action === 'dashboard') {
      const path = typeof input.outputPath === 'string' && input.outputPath ? input.outputPath : DEFAULT_ARTIFACT_PATHS[action]!
      return path && isPathWithinWorkspace(path, cwd)
        ? assessment('review', 'approve', 'Battmann report and dashboard actions write checkpointed local Markdown, JSON, and HTML artifacts', 'battmann', [path], true)
        : assessment('critical', 'approve', 'Battmann artifact output is missing or outside the active workspace', 'battmann', path ? [path] : [], false)
    }
    const storePath = typeof input.storePath === 'string' ? input.storePath : '.elia/battmann.sqlite'
    if (!isPathWithinWorkspace(storePath, cwd)) return assessment('critical', 'approve', 'Battmann store path is outside the active workspace or invalid', `battmann.${action || 'unknown'}`, [storePath], false)
    if (action === 'stage_deployment') {
      const reportPath = typeof input.reportPath === 'string' ? input.reportPath : ''
      return reportPath && isPathWithinWorkspace(reportPath, cwd)
        ? assessment('review', 'approve', 'Battmann stage_deployment writes a versioned deployment manifest into .elia/artifacts/deploy; nothing leaves the machine', 'battmann.stage_deployment', ['.elia/artifacts/deploy'], true)
        : assessment('critical', 'approve', 'Battmann stage_deployment needs an existing report path inside the active workspace', 'battmann.stage_deployment', reportPath ? [reportPath] : [], false)
    }
    if (action === 'feed_query') return assessment('safe', 'allow', 'Battmann feed_query is a bounded GET to a fixed public statistics API (ECB rates, World Bank, IMF, UN Comtrade, GDELT, WITS) and appends one code-fetched evidence row to the workspace-local store', 'battmann.feed_query', [storePath], true)
    if (action === 'ingest_feed' || action === 'resolve_due') return assessment('safe', 'allow', `Battmann ${action} reads a fixed public statistics API and appends code-fetched records to the workspace-local intelligence store`, `battmann.${action}`, [storePath], true)
    const readOnly = new Set([
      'forecast', 'ensemble', 'backtest', 'risk_assessment', 'consequence_chain', 'exposure_assessment', 'alternatives', 'question_detail', 'list_questions', 'scorecard', 'workspace_snapshot',
      'object_detail', 'list_objects', 'find_path', 'explain_causality', 'list_datasets', 'dataset_lineage', 'list_action_proposals', 'geo_query', 'situation_snapshot', 'deployment_status', 'audit_trail', 'list_indicators', 'indicator_series', 'list_feeds', 'supplier_concentration', 'list_claims',
    ])
    return readOnly.has(action)
      ? assessment('safe', 'allow', `Battmann ${action} is a deterministic calculation or workspace-local read`, `battmann.${action}`, [storePath], true)
      : assessment('safe', 'allow', `Battmann ${action} is an append-only or versioned write to the workspace-local intelligence store`, `battmann.${action || 'unknown'}`, [storePath], true)
  }

  if (name === 'read_spreadsheet') {
    const path = typeof input.path === 'string' ? input.path : ''
    return path && !isPathWithinWorkspace(path, cwd)
      ? assessment('critical', 'approve', 'read_spreadsheet targets a workbook outside the active workspace or uses an invalid path', 'read_spreadsheet', [path], false)
      : assessment('safe', 'allow', 'read_spreadsheet is a read-only workbook inspection inside the active workspace', 'read_spreadsheet', resources, true)
  }

  // Cyber-mode tools. new_engagement only writes the local authorization
  // record; run_security_tool runs a real scanner against a live target, which
  // is consequential and irreversible from that target's point of view.
  if (name === 'new_engagement') {
    return assessment('review', 'approve', 'new_engagement writes the local scope and authorization record for an engagement', 'new_engagement', resources, true)
  }

  if (name === 'run_security_tool') {
    return assessment('critical', 'approve', 'run_security_tool executes an active security tool against a live target and needs an authorization record', 'run_security_tool', resources, false)
  }

  // http_probe sends a live request to a target the engagement's SCOPE.md
  // already authorizes (the tool refuses an out-of-scope host itself), but it
  // still reaches a real system and can carry an exploit payload, so it needs
  // the same authorization boundary as run_security_tool.
  if (name === 'http_probe') {
    return assessment('critical', 'approve', 'http_probe sends a live HTTP request to an engagement target and needs an authorization record', 'http_probe', resources, false)
  }

  // log_finding and engagement_report only write inside the engagement folder
  // under workspace/ — no target is touched. engagement_report produces a
  // document artifact, so it is a review-level write like the other reporters.
  if (name === 'log_finding') {
    return assessment('safe', 'allow', 'log_finding appends a workspace-local finding record backed by existing recon evidence', 'log_finding', resources, true)
  }
  if (name === 'engagement_report') {
    return assessment('review', 'approve', 'engagement_report compiles a workspace-local Markdown report from logged findings', 'engagement_report', resources, true)
  }

  // A read-only worker (a scout researching, a critic reviewing) cannot change
  // anything itself, and every action it takes still passes this governor on
  // its own — so approving the hand-off added a prompt that guarded nothing.
  // It was the first thing a "build me an app" request showed: "Start a
  // subagent?" before any plan existed. Writers still ask.
  if (name === 'task' && READ_ONLY_ROLES.has(typeof input.role === 'string' ? input.role : 'builder')) {
    return assessment('safe', 'allow', 'a read-only subagent; each action it takes is still checked on its own', 'task.read-only', resources, true)
  }

  if (name === 'preview' || name === 'task') {
    return assessment('review', 'approve', `${name} can create an external process or delegate work`, name, resources, true)
  }

  // Hands a whole task off to a real, separately-authenticated external agent
  // (the actual OpenAI Codex CLI) that can read, write, and run shell commands
  // under its own sandbox — elia's governor has no visibility into what it
  // does once delegated, unlike task's own governed sub-agents, so this is
  // stricter than task/preview: critical, not just review. Distinct names for
  // the two ways it happens: `codex_delegate` is another model reaching for the
  // tool mid-task (surprising — full critical prompt); `codex_subscription` is
  // the user having selected the ChatGPT subscription as their model, which the
  // agent loop confirms once per session, not on every message.
  if (name === 'codex_delegate') {
    return assessment('critical', 'approve', 'codex_delegate runs a real external coding agent with its own file and shell access, outside elia\'s per-action governance', name, resources, false)
  }
  if (name === 'codex_subscription') {
    return assessment('critical', 'approve', 'the ChatGPT subscription (Codex) runs in this workspace with its own file and shell access — Elia governs the hand-off, not each action Codex then takes', name, resources, false)
  }

  // Tools proxied from a connected MCP server (see src/mcp/registry.ts, tool
  // names are prefixed mcp_<server>_...): the server is a third-party process
  // whose actual capability isn't known ahead of time, so it gets one explicit,
  // named contract instead of silently falling through the generic unknown-tool
  // branch below. Same practical effect (critical risk, approval required,
  // not assumed reversible) but documented as an intentional choice for the
  // whole family rather than an accident of "we forgot to add it."
  if (name.startsWith('mcp_')) {
    return assessment('critical', 'approve', `${name} is proxied from a third-party MCP server with no built-in safety contract`, name, resources, false)
  }

  // A loaded skill — a tool elia wrote for itself, or one the user dropped in
  // `~/.elia/skills`. Classified once when it loads by reading its own source
  // (skills/capabilities.ts), because otherwise every skill fell through to the
  // unknown-tool branch below: an unattended run refused a read-only scanner
  // outright, and a supervised one asked about it on every single call. That is
  // why the skills subsystem could be complete and still unusable.
  //
  // Only a skill whose source shows no way to reach outside the process is
  // allowed through unasked. Anything that shells out, writes or opens the
  // network keeps the full critical treatment, and so does anything the scan
  // could not read — it fails closed.
  const capability = skillCapability(name)
  if (capability === 'read-only') {
    return assessment('safe', 'allow', `${name} is a loaded skill whose source only reads — no shell, no writes, no network`, name, resources, true)
  }
  if (capability === 'effectful') {
    return assessment('critical', 'approve', `${name} is a loaded skill that can reach outside this process`, name, resources, false)
  }

  return assessment('critical', 'approve', `unknown tool ${name} has no declared safety contract`, name, resources, false)
}

/**
 * The only critical classes where one answer can settle the rest of the run.
 *
 * These are local, repeatable, and confined to the project: a compound shell
 * command, a command with no recognised read-only contract. They are what makes
 * an unattended run feel like a wall — the plan needs one, gets refused, and
 * burns its budget failing on it.
 *
 * Everything else critical stays refused in unattended mode: sending a message,
 * deploying, force-pushing, commenting on or merging a PR, driving a browser,
 * probing a live host, delegating to an external agent, or touching a path
 * outside the workspace. Those reach other people or the world beyond this
 * project, and there one "yes" must never authorize the next one. That is the
 * distinction the old blanket refusal was protecting, and it is kept.
 */
const SETTLEABLE_ONCE = new Set(['shell', 'shell.composed', 'shell.unknown', 'github.repo_create', 'github.contribute', SELF_EDIT_INTENT])

/**
 * Review-band intents that still publish to or mutate state beyond this project
 * and a shared remote. Unattended mode auto-allows the whole review band by
 * design (local, reversible work get a standing "yes"); these are the exceptions
 * — pushing to origin, opening a PR, creating issues/milestones on the remote,
 * or publishing a preview deployment sends something out where other people or
 * systems see it, and no silent auto-allow is a recorded authorization for that.
 * They fall through to the approval/refusal path: refused when no approver is
 * attached, asked once per run (and remembered) when one is.
 */
const OUTBOUND_REVIEW_INTENTS = new Set([
  'github.push',
  'github.pr_create',
  'github.issue_create',
  'github.milestone_create',
  'github.contribute',
  'deployment.preview',
])

/**
 * Session-isolated runs (a session agent in its own worktree) must never write
 * outside that worktree, even if its cwd were misconfigured. This is a
 * defensive boundary on the file-writing tools: it only activates when a
 * session scope is present and returns a block reason for anything that
 * resolves outside the scope's worktree.
 */
function sessionScopeWriteBlock(request: ActionRequest): string | undefined {
  const scope = currentSessionScope()
  if (!scope) return undefined
  const path = request.input.path
  if (!SESSION_SCOPE_FILE_WRITES.has(request.name) || typeof path !== 'string') return undefined
  try {
    assertWriteWithinSessionScope(resolveWorkspacePath(path))
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const SESSION_SCOPE_FILE_WRITES = new Set(['write_file', 'edit_file', 'lsp_refactor', 'delete_file'])

export interface ActionGovernorOptions {
  mode?: GovernanceMode
  approve?: ActionApproval
  cwd?: string
  maxActions?: number
  /**
   * Local, reversible work — the review band: edits, commits, mkdir,
   * provisioning — runs without asking, as it does unattended. Only critical
   * actions, and review-band actions that reach other people (a push, a PR,
   * a preview deploy), still go to `approve`. The interactive session's
   * default posture ("autonomous") sets this; "ask first" does not.
   */
  reviewRunsFreely?: boolean
}

export function createActionGovernor(options: ActionGovernorOptions = {}): ActionGovernor {
  const mode = options.mode ?? 'unattended'
  const cwd = options.cwd ?? process.cwd()
  // Resolved at most once per governor, and only the first time a
  // pre-authorization check actually needs it — most governors (most tests,
  // supervised mode, unattended runs that never hit an excluded-critical
  // intent) never need a branch at all, so eagerly shelling out to git on
  // every governor construction would be pure waste. A branch switch mid-run
  // just means the branch resolved here no longer matches the grant, which
  // fails isPreauthorized closed (falls through to the normal refusal), never open.
  let branchPromise: Promise<string> | undefined
  const resolvedBranch = (): Promise<string> => (branchPromise ??= currentBranch(cwd))
  const requestedMaxActions = options.maxActions ?? 0
  const maxActions = Number.isFinite(requestedMaxActions) && requestedMaxActions > 0
    ? Math.max(1, Math.min(Math.floor(requestedMaxActions), MAX_GOVERNED_ACTIONS))
    : 0
  let actionCount = 0
  let blockedByBudget = 0
  let approvalQueue = Promise.resolve()
  /** One remembered decision per class of action, for the life of this run. Unattended mode only. */
  const classDecisions = new Map<string, boolean>()
  /** "Allow for this session" choices from the supervised approval menu. */
  const sessionAllow = new Set<string>()
  const sessionKey = (request: ActionRequest, assessment: ActionAssessment): string =>
    request.name === 'run_command' || (request.name === 'process' && request.input.action === 'start')
      ? `${request.name}:${String(request.input.command ?? '').trim().split(/[\s;|&]+/, 1)[0] ?? ''}`
      : request.name === 'run_program'
        ? `run_program:${String(request.input.program ?? '').trim()}:${Array.isArray(request.input.args) && typeof request.input.args[0] === 'string' ? request.input.args[0].trim() : ''}:${assessment.intent}`
      : `${request.name}:${assessment.intent}`

  const decide = async (request: ActionRequest): Promise<ActionGateResult> => {
      const scopeBlock = sessionScopeWriteBlock(request)
      if (scopeBlock !== undefined) {
        return {
          allowed: false,
          assessment: {
            risk: 'critical',
            decision: 'block',
            reason: `file write is outside the session worktree: ${scopeBlock}`,
            intent: 'session-scope',
            resources: typeof request.input.path === 'string' ? [request.input.path] : [],
            reversible: false,
          },
          message: `Path blocked by session worktree scope: ${scopeBlock}`,
        }
      }
      const baseAssessment = assessAction(request, options.cwd)
      // A checked-in .elia/policy.json can only tighten this: block the action
      // outright, or raise its decision from allow to approve. Applied before
      // the budget check so a policy-blocked action never consumes budget.
      const policied = applyPolicy(baseAssessment, request, options.cwd)
      const assessment = policied.assessment
      if (policied.blocked) {
        return { allowed: false, assessment, message: policied.message }
      }
      if (maxActions > 0 && actionCount >= maxActions) {
        blockedByBudget += 1
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: `Action budget exhausted after ${maxActions} tool requests. Resume with a larger bounded budget or split the goal into smaller tasks.`,
        }
      }
      // Only an action that actually happened counts against the budget — a
      // blocked or denied request consumes nothing, otherwise every command a
      // policy blocks would silently burn the run's maxActions.
      if (assessment.decision === 'allow') {
        actionCount += 1
        return { allowed: true, assessment }
      }

      // A standing "always allow" — persisted (.elia/allow.json or ~/.elia/allow.json)
      // or chosen for this session at the approval menu — clears the prompt.
      // Supervised only: an unattended run keeps its strict per-run boundary, so
      // a critical action never rides in on a rule written during some past
      // interactive session.
      if (
        mode === 'supervised' &&
        (sessionAllow.has(sessionKey(request, assessment)) || isAllowlisted(request, assessment, options.cwd))
      ) {
        actionCount += 1
        return { allowed: true, assessment: { ...assessment, decision: 'allow' } }
      }

      // Unattended mode used to refuse every critical action outright. That is
      // a wall, not a safeguard: a run whose plan needs one such action spends
      // its entire budget failing on it, and the user is told to start over in
      // a different mode. When somebody is reachable, ask them once for this
      // *kind* of action and then carry on unattended — one boundary per run
      // rather than one per call. With no approval channel at all (a scheduled
      // run, CI, nobody at the terminal) it still refuses, because a question
      // nobody will hear is not consent.
      //
      // The one other way past this wall: a human explicitly pre-authorized
      // this exact intent, for this exact project + branch, before the run
      // started (`elia auto --authorize`, preauth.ts) — a real advance "yes"
      // recorded by a person, never something the model can grant itself.
      if (mode === 'unattended' && assessment.risk === 'critical' && !SETTLEABLE_ONCE.has(assessment.intent)) {
        const branch = await resolvedBranch()
        if (isPreauthorized(assessment.intent, cwd, branch)) {
          const grant = consumePreauth(assessment.intent, cwd, branch)
          actionCount += 1
          return {
            allowed: true,
            assessment: { ...assessment, decision: 'allow', reason: `${assessment.reason} (pre-authorized: ${preauthPath()} grant for "${assessment.intent}", use #${grant?.usedCount ?? '?'})` },
          }
        }
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: `Action blocked by Elia’s unattended policy: ${assessment.reason}. This kind of action reaches outside the project, so one approval can never stand for the next — resume in supervised mode for an exact per-action boundary, or start this run with "elia auto --authorize ${assessment.intent}" to pre-authorize it.`,
        }
      }
      if (mode === 'unattended' && assessment.risk === 'critical' && !options.approve) {
        if (assessment.intent === SELF_EDIT_INTENT) {
          const target = resolvePath(options.cwd ?? currentAgent().cwd ?? process.cwd(), assessment.resources[0] ?? '')
          return {
            allowed: false,
            assessment: { ...assessment, decision: 'block' },
            message: selfEditRefusal(target) ?? assessment.reason,
            noApprover: true,
          }
        }
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: `Action blocked by Elia’s unattended policy: ${assessment.reason}. No terminal is attached, so there is nobody to ask.`,
          noApprover: true,
        }
      }
      if (assessment.risk === 'review' && (mode === 'unattended' || options.reviewRunsFreely) && !OUTBOUND_REVIEW_INTENTS.has(assessment.intent)) {
        actionCount += 1
        return { allowed: true, assessment: { ...assessment, decision: 'allow' } }
      }

      // Unattended means asked once, not asked repeatedly: a decision about a
      // class of action stands for the rest of the run. Supervised mode
      // deliberately does not remember — a per-action boundary is the whole
      // point of it.
      //
      // The settleable family (`shell`, `shell.composed`, `shell.unknown`) is
      // keyed by the EXACT command, not just by intent: an approved
      // `git push origin main` must never stand in for `git push -f …` or an
      // unrelated `pip install …`. Each distinct command in the family needs
      // its own "yes" — that is the one-approval-per-boundary property A2-03
      // checks for. Everything else keeps its risk:intent class key.
      const scopedCommand = (() => {
        if (!SETTLEABLE_ONCE.has(assessment.intent)) return undefined
        let raw: string | undefined
        if (request.name === 'run_command') {
          raw = typeof request.input.command === 'string' ? request.input.command : undefined
        } else if (request.name === 'run_program') {
          const program = typeof request.input.program === 'string' ? request.input.program : ''
          const args = Array.isArray(request.input.args) ? request.input.args.filter((a): a is string => typeof a === 'string') : []
          raw = [program, ...args].join(' ')
        } else if (request.name === 'process' && request.input.action === 'start') {
          raw = typeof request.input.command === 'string' ? request.input.command : undefined
        } else if (request.name === 'github') {
          // Keyed by the repository, for the same reason the shell family is
          // keyed by the command: a yes to forking one project is not a yes to
          // forking the next one. Each repository is a separate account-visible
          // act and asks for itself.
          const ref = typeof request.input.ref === 'string' ? request.input.ref : typeof request.input.repo === 'string' ? request.input.repo : ''
          raw = ref ? `github ${String(request.input.action)} ${ref}` : undefined
        }
        const normalized = raw?.trim().replace(/\s+/g, ' ')
        return normalized ? normalized : undefined
      })()
      const decisionKey = scopedCommand ?? `${assessment.risk}:${assessment.intent}`
      if (mode === 'unattended') {
        const remembered = classDecisions.get(decisionKey)
        if (remembered === true) {
          actionCount += 1
          return { allowed: true, assessment: { ...assessment, decision: 'allow' } }
        }
        if (remembered === false) {
          return {
            allowed: false,
            assessment: { ...assessment, decision: 'block' },
            // Naming the right scope matters to the model reading this. The
            // settleable families are keyed by the exact command, so telling it
            // that "every shell.unknown action" is denied when one `mkdir` was
            // refused reads as a closed door: an agent that believes the whole
            // shell is gone stops trying the command that would have worked.
            message: scopedCommand
              ? `Action denied earlier in this run for this exact command (${scopedCommand}): ${assessment.reason}. Only that command is settled — a different one is still worth trying.`
              : `Action denied earlier in this run for every "${assessment.intent}" action: ${assessment.reason}.`,
          }
        }
      }

      if (!options.approve) {
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: `Action blocked by Elia’s autonomy governor: ${assessment.reason}. No approval channel is available for this run.`,
        }
      }

      // Terminal prompts must never interleave when several workers request an
      // approval at once. Queue the decision without serialising the work itself.
      const previous = approvalQueue
      let release!: () => void
      approvalQueue = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      // The tool's own writeToolCall already started the "running…" spinner
      // for this action; a per-action approval prompt printed while that
      // spinner is still ticking would get its lines clobbered by the
      // spinner's next redraw. Pause it for exactly this prompt, then let it
      // resume — the tool itself hasn't finished, so its line is still owed.
      pauseToolSpinner()
      try {
        const outcome = await options.approve(assessment, request)
        const approved = outcome === true || (typeof outcome === 'object' && outcome.approved)
        const remember = typeof outcome === 'object' ? outcome.remember : undefined
        const feedback = typeof outcome === 'object' ? outcome.feedback : undefined
        if (mode === 'unattended') classDecisions.set(decisionKey, approved)
        if (approved && remember === 'session') sessionAllow.add(sessionKey(request, assessment))
        // "Don't ask again" for elia's own source covers every file tool for the
        // session, not just the tool that asked — the same state as /self on.
        if (approved && remember && assessment.intent === SELF_EDIT_INTENT) setSelfEditAllowed(true)
        if (approved && (remember === 'project' || remember === 'global') && canPersistPrefixRule(request)) {
          try {
            addAllowRule(ruleFor(request, assessment), remember, options.cwd)
          } catch {
            // A write failure (read-only fs, permissions) must not block the
            // action the user just approved — it just won't be remembered.
            // A command chained with shell control syntax is never persisted
            // at all (canPersistPrefixRule): a `bun` prefix must not come to
            // stand for `bun run x & curl …`.
          }
        }
        if (approved) {
          actionCount += 1
          return { allowed: true, assessment: { ...assessment, decision: 'allow' } }
        }
        return {
          allowed: false,
          assessment: { ...assessment, decision: 'block' },
          message: feedback
            ? `Action declined by the user. Their guidance: ${feedback}`
            : `Action denied by the user: ${assessment.reason}`,
        }
      } finally {
        resumeToolSpinner()
        release()
      }
  }

  return {
    mode,
    stats: () => ({ maxActions, consumed: actionCount, exhausted: maxActions > 0 && actionCount >= maxActions, blockedByBudget }),
    async check(request) {
      const result = await decide(request)
      // Every way a self_edit gets through — a yes at the prompt, a remembered
      // class decision, an allow rule — opens that file at the tool-level
      // backstop too, or the write the governor just allowed would be refused.
      if (result.allowed && result.assessment.intent === SELF_EDIT_INTENT) {
        approveSelfEditFile(resolvePath(options.cwd ?? currentAgent().cwd ?? process.cwd(), result.assessment.resources[0] ?? ''))
      }
      return result
    },
  }
}

const governorStorage = new AsyncLocalStorage<ActionGovernor>()
const defaultGovernor = createActionGovernor({ mode: 'unattended' })

export function withActionGovernor<T>(governor: ActionGovernor, fn: () => Promise<T>): Promise<T> {
  return governorStorage.run(governor, fn)
}

export function activeActionGovernor(): ActionGovernor {
  return governorStorage.getStore() ?? defaultGovernor
}

/**
 * Whether an unattended run will refuse this command outright. Unattended mode
 * blocks the `critical` band rather than queueing it for approval, so a plan
 * that names such a command as its verification gate can never go green.
 * Exported so the plan can be checked against the policy before the run commits
 * to it, instead of discovering at verification time that the gate is unwinnable.
 */
export function blockedInUnattendedMode(command: string, cwd = process.cwd()): boolean {
  return assessCommand(command, cwd).risk === 'critical'
}

/**
 * Classify a shell command by what it *does*, not where it runs.
 *
 * `_cwd` is deliberately unread. Every branch below is a pattern match on the
 * command string — network egress, package installs, remote execution,
 * irreversible side effects — and none of those change meaning with the
 * working directory. Path scoping is a separate gate (workspace-path and
 * protected-file checks); folding it in here would give one classifier two
 * jobs and make each harder to reason about. The parameter stays so the
 * signature matches `blockedInUnattendedMode`, which is exported for
 * plan-time checking.
 */
function assessCommand(command: string, _cwd: string): ActionAssessment {
  if (!command.trim()) return assessment('critical', 'approve', 'shell command is empty or invalid', 'shell', [], false)
  // CR/LF anywhere means a chain or a pasted script, not one verified
  // invocation, and is rejected before any other gate can run. A harmless
  // lead-in ("echo ok\nbash /tmp/p.sh") must never ride a start-anchored
  // read-only match past the rest of this classifier.
  if (SHELL_CONTROL_SYNTAX.test(command)) {
    return assessment('critical', 'approve', 'shell control syntax or interpreter evaluation requires an exact approval boundary', 'shell.composed', [], false)
  }
  if (commandMayReadSensitiveData(command)) {
    return assessment('critical', 'approve', 'shell command may read credentials or protected system data', 'shell.sensitive-read', [], false)
  }
  // The named hazard intents are checked BEFORE the generic CRITICAL_COMMAND
  // (and before the settleable-once classification those matches fall into).
  // Order matters: `sudo pip install` and `docker exec` and `curl --data …`
  // would otherwise be caught by `\bsudo\b`, CRITICAL_COMMAND's broad shell
  // match, or EXTERNAL_WRITE below — and an unattended run's "asked once"
  // memory is keyed per exact command, so a settled `sudo pip install` must
  // not stand in for an unrelated critical. A command belongs to exactly one
  // intent here precisely so the least-settling classification wins.
  //
  // The exfil forms stay ahead of the bare-GET branch below: an upload
  // (`-d@file`, `-F`, `-T`, `--data-binary`, …) can sit anywhere in the line,
  // including past a prefix that REMOTE_FETCH_COMMAND's start anchor would
  // miss, and it deserves the transmit-data reason rather than the weaker
  // "opens a channel" one.
  if (EXTERNAL_WRITE_COMMAND.test(command) || EXTERNAL_WRITE_SHORT_OPTIONS.test(command)) {
    return assessment('critical', 'approve', 'shell command may transmit data to an external system', 'shell.external-write', [], false)
  }
  if (REMOTE_FETCH_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command opens an unvalidated network channel (a bare GET already rides data out of the machine); use web_fetch/http_probe for safe bounded retrieval', 'shell.external-write', [], false)
  }
  // Supply-chain installs, container/SSH execution are critical with a
  // dedicated intent — they execute arbitrary code, so no unattended run may
  // auto-allow them, and no settled sibling may ever cover commander.
  if (CODE_EXEC_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command installs packages whose build scripts can execute arbitrary code on the host', 'shell.code-exec', [], false)
  }
  if (REMOTE_SHELL_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command executes code on a remote host or inside a container that may mount the host filesystem', 'shell.remote', [], false)
  }
  if (CRITICAL_COMMAND.test(command)) {
    return assessment('critical', 'approve', 'shell command may cause an irreversible or external side effect', 'shell', [], false)
  }
  if (REVIEW_COMMAND.test(command) || isLocalGitStaging(command)) {
    return assessment('review', 'approve', 'shell command changes dependencies, reaches a remote system, or creates a durable artifact', 'shell', [], true)
  }
  if (/^(?:command\s+)?git\s+branch\b/i.test(command) && !GIT_BRANCH_LIST_ONLY.test(command)) {
    return assessment('critical', 'approve', 'git branch command may create, delete, rename, or force-move a branch and is not a safe read-only operation', 'shell.unknown', [], false)
  }
  if (READ_ONLY_COMMAND.test(command) && !SED_AWK_INPLACE_EDIT.test(command) && !DESTRUCTIVE_SHELL_VERBS.test(command)) {
    return assessment('safe', 'allow', 'shell command matches the restricted read-only command policy', 'shell.read-only', [], !SHELL_SIDE_EFFECT.test(command))
  }
  if (isWorkspaceMkdir(command)) {
    return assessment('review', 'approve', 'mkdir creates directories under the directory it runs in', 'shell', [], true)
  }
  return assessment('critical', 'approve', 'shell command is not in the restricted read-only policy and may cause an unreviewed side effect', 'shell.unknown', [], false)
}

/**
 * `mkdir` of plain relative paths: no absolute path, no `~`, no `..` segment, no
 * option but `-p`/`-v`. It creates directories under the directory it runs in,
 * which run_command keeps inside the workspace, and write_file can already
 * create any directory there. Classed critical, it was refused in every
 * unattended run, and models spent steps working around it with placeholder
 * files. Control syntax never reaches here: it is refused at the top.
 */
function isWorkspaceMkdir(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] !== 'mkdir') return false
  let paths = 0
  for (const token of tokens.slice(1)) {
    if (/^-[pv]+$/.test(token)) continue
    if (!/^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/.test(token) || token.split('/').includes('..')) return false
    paths += 1
  }
  return paths > 0
}

function assessment(
  risk: ActionRisk,
  decision: ActionDecision,
  reason: string,
  intent: string,
  resources: string[],
  reversible: boolean,
): ActionAssessment {
  return { risk, decision, reason, intent, resources, reversible }
}


export function redactActionInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY.test(key) || (tool === 'browser' && input.action === 'type' && key === 'text') || (tool === 'communication' && ['body', 'recipient', 'cc', 'bcc', 'attachments'].includes(key))) {
      output[key] = '[REDACTED]'
      continue
    }
    if (typeof value === 'string') output[key] = value.length > 2000 ? `${value.slice(0, 2000)}…` : value
    else if (Array.isArray(value)) output[key] = value.slice(0, 20)
    else output[key] = value
  }
  return output
}
