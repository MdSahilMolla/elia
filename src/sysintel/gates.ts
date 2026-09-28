import type { Requirement } from './lifecycles.ts'
import { REVIEW_KINDS, SIGNOFF_GATES } from './org.ts'
import type { ArtifactRecord, Initiative, ReviewRecord, StageState, SysintelStore } from './store.ts'
import { treeFingerprint } from './tree.ts'

/**
 * Whether a stage is really finished. Every requirement is judged only from evidence the
 * engine produced or verified: artifacts that pass their template, checks it ran itself,
 * commits and branches it found in git, reviews recorded by someone other than the author,
 * and sign-offs a person approved. What the lead says about its own work is a note — it
 * can end a discovery stage, never a review or a release.
 */

export interface RequirementStatus {
  requirement: Requirement
  met: boolean
  detail: string
  /** What would satisfy it. */
  hint?: string
}

export interface GateContext {
  store: SysintelStore
  /** Lazily computed working-tree fingerprint; undefined outside git. */
  tree: () => string | undefined
}

export function gateContext(store: SysintelStore): GateContext {
  let cached: { value: string | undefined } | undefined
  return {
    store,
    tree: () => (cached ??= { value: treeFingerprint(store.cwd) }).value,
  }
}

const since = (at: string, entered: string | undefined): boolean => !entered || at >= entered

export function latestArtifact(initiative: Initiative, kind: string): ArtifactRecord | undefined {
  return initiative.artifacts.filter((artifact) => artifact.kind === kind).sort((a, b) => b.version - a.version)[0]
}

/** A review of an older version of the code or artifact no longer speaks for the current one. */
export function reviewIsFresh(review: ReviewRecord, initiative: Initiative, context: GateContext): boolean {
  if (review.subject.type === 'untracked') return true
  if (review.subject.type === 'tree') return review.subject.ref === context.tree()
  const [artifactId, sha] = review.subject.ref.split(':')
  const kind = initiative.artifacts.find((artifact) => artifact.id === artifactId)?.kind
  const latest = kind ? latestArtifact(initiative, kind) : undefined
  return latest !== undefined && latest.id === artifactId && latest.sha256 === sha
}

function describe(requirement: Requirement): string {
  switch (requirement.type) {
    case 'note': return 'a recorded finding (note, link, artifact, or check) for this stage'
    case 'artifact': return `a valid ${requirement.artifact}`
    case 'check': return requirement.fresh ? 'a passing check on the current code' : 'a passing check run in this stage'
    case 'change': return 'a real change to the code (verified in git)'
    case 'branch': return 'work on a non-default branch'
    case 'review': return `an independent ${requirement.review} approval${requirement.hat ? ` from the ${requirement.hat}` : ''}${requirement.subject === 'artifact' ? ' of the design' : ''}`
    case 'signoff': return `the person's ${requirement.gate} sign-off`
    case 'plan': return 'a work breakdown with owners and acceptance criteria'
    case 'items': return 'every work item done or dropped'
    case 'followups': return 'follow-up initiatives for the action items (or accepted residual risk)'
    case 'dependencies': return 'every initiative this depends on finished'
    case 'children': return 'every linked initiative finished'
    case 'teams': return 'every linked initiative owned by a team'
  }
}

export function requirementLabel(requirement: Requirement): string {
  return describe(requirement)
}

function evaluate(requirement: Requirement, initiative: Initiative, stage: StageState, context: GateContext): RequirementStatus {
  const entered = stage.enteredAt
  const status = (met: boolean, detail: string, hint?: string): RequirementStatus => ({ requirement, met, detail, ...(met ? {} : { hint }) })
  switch (requirement.type) {
    case 'note': {
      const found = initiative.evidence.find((item) => item.stage === stage.id && item.kind !== 'signoff' && since(item.at, entered))
        ?? initiative.artifacts.find((artifact) => artifact.stage === stage.id && since(artifact.at, entered))
      if (!found) return status(false, 'nothing recorded for this stage yet', 'si_record note (or link / check), or si_artifact write')
      return status(true, `recorded: ${'summary' in found ? found.summary : `${found.kind} v${found.version}`}`.slice(0, 160))
    }
    case 'artifact': {
      const kind = requirement.artifact!
      const latest = latestArtifact(initiative, kind)
      if (!latest) return status(false, `no ${kind} yet`, `si_artifact template artifact:"${kind}", then si_artifact write`)
      const intact = context.store.artifactIntact(latest)
      if (intact !== 'ok') return status(false, `${latest.id} is ${intact} on disk since it was recorded`, `rewrite it with si_artifact write artifact:"${kind}"`)
      if (!latest.valid) return status(false, `${latest.id} fails its template: ${latest.errors.slice(0, 3).join('; ')}`, `fix the sections and si_artifact write artifact:"${kind}" again`)
      return status(true, `${latest.id} is valid`)
    }
    case 'check': {
      const passing = initiative.evidence.filter((item) => item.kind === 'check' && item.passed)
      if (requirement.fresh) {
        const tree = context.tree()
        if (tree === undefined) {
          const recent = passing.find((item) => since(item.at, entered))
          return recent
            ? status(true, `"${recent.command}" passed (not a git repository, so freshness is by time: after this stage began)`)
            : status(false, 'no passing check since this stage began', 'si_record check command:"<the project test command>"')
        }
        const fresh = passing.find((item) => item.tree === tree)
        if (fresh) return status(true, `"${fresh.command}" passed on the current code`)
        const stale = passing.length > 0
        return status(false, stale ? 'checks passed on an earlier version of the code, not the current one' : 'no passing check yet', 'si_record check command:"<the project test command>" (re-run after the last edit)')
      }
      const recent = passing.find((item) => item.stage === stage.id && since(item.at, entered))
      return recent ? status(true, `"${recent.command}" passed`) : status(false, 'no passing check in this stage yet', 'si_record check command:"<the command that runs it>"')
    }
    case 'change': {
      const commit = initiative.evidence.find((item) => item.kind === 'commit' && item.newCommit === true)
      if (commit) return status(true, `commit ${commit.sha?.slice(0, 12)} — ${commit.summary}`.slice(0, 160))
      const tree = context.tree()
      if (tree !== undefined && initiative.baseTree !== undefined) {
        return tree !== initiative.baseTree
          ? status(true, 'the working tree differs from when the work began')
          : status(false, 'nothing in the code has changed since the initiative began (commits that already existed then do not count)', 'make the change (delegate with task), then si_record commit ref:"<sha>" if you commit it')
      }
      const check = initiative.evidence.find((item) => item.kind === 'check' && item.passed && item.stage === stage.id && since(item.at, entered))
      return check
        ? status(true, `not a git repository — no diff to verify; accepted the passing check "${check.command}"`)
        : status(false, 'not a git repository, so the change cannot be verified from a diff', 'si_record check command:"<a command that exercises the change>"')
    }
    case 'branch': {
      const branch = [...initiative.evidence].reverse().find((item) => item.kind === 'branch')
      if (!branch) return status(false, 'no branch recorded', 'create a branch (github tool), then si_record branch')
      return branch.isDefaultBranch ? status(false, `"${branch.branch}" is the default branch`, 'work on a feature branch and si_record branch') : status(true, `on branch ${branch.branch}`)
    }
    case 'review': {
      const kind = requirement.review!
      const spec = REVIEW_KINDS[kind]
      // A design review does not stand in for a code review of the same kind, nor a staff review for a principal one.
      const onDesign = (requirement.subject ?? spec.subject) === 'artifact'
      const all = initiative.reviews.filter((item) => item.kind === kind && (item.subject.type === 'artifact') === onDesign && (!requirement.hat || item.hat === requirement.hat))
      const independent = all.filter((item) => item.independent)
      const fresh = independent.filter((item) => reviewIsFresh(item, initiative, context)).sort((a, b) => a.at.localeCompare(b.at))
      const latest = fresh.at(-1)
      const how = `si_work brief id:"${initiative.id}" review:"${kind}"${requirement.hat ? ` hat:"${requirement.hat}"` : ''} → task role:"${spec.workers[0]}"; the worker records si_record review kind:"${kind}"${requirement.hat ? ` hat:"${requirement.hat}"` : ''}${onDesign ? ' artifact:"<the design document>"' : ''}`
      if (latest?.verdict === 'approve') return status(true, `approved by ${latest.by.name} (${latest.hat})${onDesign ? ` on ${latest.subject.ref.split(':')[0]}` : ''}`)
      if (latest) return status(false, `${latest.verdict} by ${latest.by.name}: ${latest.findings.slice(0, 3).join('; ') || latest.summary}`.slice(0, 300), `address the findings, then ${how}`)
      if (independent.length) return status(false, `the approval was for an earlier version — the ${onDesign ? 'document' : 'code'} has changed since`, `re-review: ${how}`)
      if (all.length) return status(false, 'only self-review recorded — the author cannot approve their own work', how)
      return status(false, `no ${requirement.hat ? `${requirement.hat} ` : ''}${onDesign ? 'design ' : ''}review yet`, how)
    }
    case 'signoff': {
      const gate = requirement.gate!
      const signoff = [...initiative.evidence].reverse().find((item) => item.kind === 'signoff' && item.gate === gate && item.stage === stage.id && since(item.at, entered))
      if (!signoff) return status(false, `awaiting the person's ${gate} sign-off (${SIGNOFF_GATES[gate]})`, `when every other requirement is met, si_record signoff gate:"${gate}" — it asks the person; or they run: elia si signoff ${initiative.id} ${gate}`)
      if ((gate === 'release' || gate === 'production') && signoff.tree !== undefined && signoff.tree !== context.tree()) {
        return status(false, `the ${gate} sign-off was for an earlier version of the code`, `ask again with si_record signoff gate:"${gate}"`)
      }
      return status(true, `signed off by ${signoff.by.name} via ${signoff.via}`)
    }
    case 'plan': {
      if (!initiative.items.length) return status(false, 'no work breakdown', 'si_work plan with owned items, each with acceptance criteria')
      const weak = initiative.items.filter((item) => !item.acceptance.length)
      return weak.length ? status(false, `items without acceptance criteria: ${weak.map((item) => item.id).join(', ')}`, 'si_work plan again with acceptance for every item') : status(true, `${initiative.items.length} owned item(s)`)
    }
    case 'items': {
      if (!initiative.items.length) return status(false, 'no work items', 'si_work plan')
      const open = initiative.items.filter((item) => item.status !== 'done' && item.status !== 'dropped')
      return open.length ? status(false, `open: ${open.map((item) => `${item.id} ${item.title}`).join('; ')}`.slice(0, 300), 'si_work item status:"done" as each is finished') : status(true, 'every item is done or dropped')
    }
    case 'followups': {
      if (initiative.children.length) return status(true, `follow-ups: ${initiative.children.join(', ')}`)
      const accepted = initiative.evidence.find((item) => item.kind === 'signoff' && item.gate === 'accept-risk' && item.stage === stage.id)
      if (accepted) return status(true, 'residual risk accepted by the person')
      // Follow-ups are often opened before they are linked; point at them rather than at a risk sign-off.
      const unlinked = context.store.ids().filter((other) => other !== initiative.id && Number(other.slice(3)) > Number(initiative.id.slice(3)) && !context.store.read(other).parent)
      return unlinked.length
        ? status(false, `no follow-ups linked — ${unlinked.join(', ')} were opened after this without a parent`, `if they are this initiative's action items: si_work link id:"${initiative.id}" children:[${unlinked.map((other) => `"${other}"`).join(', ')}]`)
        : status(false, 'no follow-up initiatives yet', `si_work intake parent:"${initiative.id}" for each action item; only if the person accepts the residual risk instead: si_record signoff gate:"accept-risk"`)
    }
    case 'dependencies': {
      if (!initiative.dependsOn.length) return status(true, 'no dependencies')
      const open = initiative.dependsOn.filter((id) => !context.store.exists(id) || context.store.read(id).status !== 'done')
      return open.length ? status(false, `waiting on ${open.join(', ')}`, 'finish those initiatives first') : status(true, `dependencies done: ${initiative.dependsOn.join(', ')}`)
    }
    case 'teams': {
      if (!initiative.children.length) return status(false, 'no linked initiatives to staff', `si_work intake parent:"${initiative.id}" team:"…"`)
      const unowned = initiative.children.filter((id) => !context.store.exists(id) || !context.store.read(id).team)
      return unowned.length ? status(false, `no team yet: ${unowned.join(', ')}`, 'si_work assign id:"SI-n" team:"…" (si_org structure lists the teams)') : status(true, 'every linked initiative has a team')
    }
    case 'children': {
      if (!initiative.children.length) return status(false, 'no linked initiatives', `si_work intake parent:"${initiative.id}"`)
      const open = initiative.children.filter((id) => {
        const child = context.store.exists(id) ? context.store.read(id) : undefined
        return !child || (child.status !== 'done' && child.status !== 'abandoned')
      })
      return open.length ? status(false, `still open: ${open.join(', ')}`) : status(true, 'every linked initiative is finished')
    }
  }
}

export function evaluateStage(initiative: Initiative, stage: StageState, context: GateContext): RequirementStatus[] {
  return stage.requirements.map((requirement) => evaluate(requirement, initiative, stage, context))
}

export function currentStage(initiative: Initiative): StageState | undefined {
  return initiative.stages.find((stage) => stage.id === initiative.current)
}
