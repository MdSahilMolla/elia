// Putting an approved plan on GitHub: a repository to hold it, the commits
// pushed, and the plan itself as issues under a milestone per stage — so the
// work is trackable where the rest of the team already looks, not only in a
// terminal that scrolled away.
//
// Creating a repository publishes the project under a new name on the user's
// account, so it goes through the governor like any other outward-facing act.
// In unattended mode that is one question, once — and if there is nobody to ask
// (CI, the scheduler), the run keeps everything local rather than publishing on
// a guess. Nothing here is fatal: a project that cannot reach GitHub still has
// its full local history.
import { basename } from 'node:path'
import { execCapture } from '../github/exec.ts'
import { planWaves } from './fleet.ts'
import type { ActionGovernor } from './governor.ts'
import type { Proposal } from './types.ts'

export interface PublishOptions {
  cwd: string
  proposal: Proposal
  governor: ActionGovernor
  signal?: AbortSignal
  /** Repository name; defaults to a slug of the directory name. */
  name?: string
  /** Create issues and milestones from the plan (default true). */
  track?: boolean
}

export interface PublishResult {
  /** `created` a new repo, `pushed` to one that already existed, or `skipped`. */
  status: 'created' | 'pushed' | 'skipped'
  /** Why nothing was published, when skipped. Always worth showing the user. */
  reason?: string
  url?: string
  issues: number
  milestones: number
  warnings: string[]
}

/** GitHub repository names allow letters, digits, dot, dash and underscore. */
export function repositoryName(cwd: string, proposal: Proposal): string {
  const fromDirectory = basename(cwd).trim()
  const candidate = fromDirectory && !/^[.\s]*$/.test(fromDirectory) ? fromDirectory : proposal.goal
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return slug || 'elia-project'
}

export async function publishProject(options: PublishOptions): Promise<PublishResult> {
  const { cwd, proposal, governor, signal } = options
  const result: PublishResult = { status: 'skipped', issues: 0, milestones: 0, warnings: [] }

  const auth = await execCapture('gh', ['auth', 'status'], cwd, signal)
  if (auth.missing) {
    result.reason = 'the GitHub CLI is not installed, so the project stays local (install gh and re-run to publish).'
    return result
  }
  if (!auth.ok) {
    result.reason = 'the GitHub CLI is not authenticated, so the project stays local (run `gh auth login` to publish).'
    return result
  }

  const origin = await execCapture('git', ['remote', 'get-url', 'origin'], cwd, signal)
  if (origin.ok && origin.stdout.trim()) {
    const push = await pushCurrentBranch(cwd, governor, signal)
    if (push.warning) result.warnings.push(push.warning)
    result.status = push.pushed ? 'pushed' : 'skipped'
    if (!push.pushed) result.reason = push.warning
  } else {
    const name = options.name ?? repositoryName(cwd, proposal)
    const gate = await governor.check({ name: 'github', input: { action: 'repo_create', name } })
    if (!gate.allowed) {
      result.reason = gate.message ?? 'creating a GitHub repository was not authorised; the project stays local.'
      return result
    }
    // Private by default: the run has no way to know whether this code is meant
    // to be public, and only one of those two mistakes can be undone.
    const created = await execCapture(
      'gh',
      ['repo', 'create', name, '--private', '--source=.', '--remote=origin', '--push', '--description', proposal.goal.slice(0, 350)],
      cwd,
      signal,
    )
    if (!created.ok) {
      result.reason = `could not create the GitHub repository: ${created.stderr || created.stdout}`
      return result
    }
    result.status = 'created'
  }

  const url = await execCapture('gh', ['repo', 'view', '--json', 'url', '-q', '.url'], cwd, signal)
  if (url.ok && url.stdout.trim()) result.url = url.stdout.trim()

  if (options.track !== false) {
    const tracked = await trackPlan(cwd, proposal, governor, signal)
    result.issues = tracked.issues
    result.milestones = tracked.milestones
    result.warnings.push(...tracked.warnings)
  }

  return result
}

async function pushCurrentBranch(cwd: string, governor: ActionGovernor, signal?: AbortSignal): Promise<{ pushed: boolean; warning?: string }> {
  const gate = await governor.check({ name: 'github', input: { action: 'push' } })
  if (!gate.allowed) return { pushed: false, warning: gate.message ?? 'push was not authorised' }

  const branch = await execCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, signal)
  const name = branch.ok ? branch.stdout.trim() : 'HEAD'
  const push = await execCapture('git', ['push', '--set-upstream', 'origin', name], cwd, signal)
  if (!push.ok) return { pushed: false, warning: `could not push to origin: ${push.stderr || push.stdout}` }
  return { pushed: true }
}

/**
 * The plan as trackable work: a milestone per stage, an issue per step, each
 * issue carrying the instructions the worker was actually given so the record
 * on GitHub matches what was built.
 */
async function trackPlan(
  cwd: string,
  proposal: Proposal,
  governor: ActionGovernor,
  signal?: AbortSignal,
): Promise<{ issues: number; milestones: number; warnings: string[] }> {
  const warnings: string[] = []
  const { waves } = planWaves(proposal.steps)
  if (waves.length === 0) return { issues: 0, milestones: 0, warnings }

  const milestoneGate = await governor.check({ name: 'github', input: { action: 'milestone_create' } })
  if (!milestoneGate.allowed) {
    return { issues: 0, milestones: 0, warnings: [milestoneGate.message ?? 'issue tracking was not authorised'] }
  }

  // Milestones first: an issue can only join one that already exists.
  const milestoneTitles: (string | undefined)[] = []
  let milestones = 0
  for (const [index, wave] of waves.entries()) {
    const title = `Stage ${index + 1}`
    const created = await execCapture(
      'gh',
      ['api', 'repos/{owner}/{repo}/milestones', '-f', `title=${title}`, '-f', `description=${wave.length} step(s) that can be built in parallel`],
      cwd,
      signal,
    )
    if (created.ok) {
      milestones += 1
      milestoneTitles.push(title)
    } else {
      // A milestone that already exists is fine to reuse; anything else means
      // the issues in this stage simply go without one.
      milestoneTitles.push(/already_exists|already exists/i.test(created.stderr) ? title : undefined)
      if (!/already_exists|already exists/i.test(created.stderr)) {
        warnings.push(`could not create milestone "${title}": ${created.stderr || created.stdout}`)
      }
    }
  }

  const issueGate = await governor.check({ name: 'github', input: { action: 'issue_create' } })
  if (!issueGate.allowed) return { issues: 0, milestones, warnings: [...warnings, issueGate.message ?? 'issue creation was not authorised'] }

  let issues = 0
  for (const [index, wave] of waves.entries()) {
    for (const step of wave) {
      const args = ['issue', 'create', '--title', `${step.id}: ${step.title}`, '--body', issueBody(step, proposal)]
      const milestone = milestoneTitles[index]
      if (milestone) args.push('--milestone', milestone)
      const created = await execCapture('gh', args, cwd, signal)
      if (created.ok) issues += 1
      else warnings.push(`could not create an issue for ${step.id}: ${created.stderr || created.stdout}`)
    }
  }

  return { issues, milestones, warnings }
}

function issueBody(step: Proposal['steps'][number], proposal: Proposal): string {
  return [
    step.instructions,
    '',
    `**Role:** ${step.role}`,
    `**Files:** ${step.files.length > 0 ? step.files.map((file) => `\`${file}\``).join(', ') : '_unspecified_'}`,
    step.dependsOn.length > 0 ? `**Depends on:** ${step.dependsOn.join(', ')}` : '',
    '',
    '---',
    `Part of: ${proposal.goal}`,
    'Created from the approved plan. See `docs/PRD.md` and `docs/ARCHITECTURE.md`.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}
