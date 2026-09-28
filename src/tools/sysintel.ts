import { actionsFor, runAction } from '../sysintel/engine.ts'
import { SYSINTEL_TOOLS, type SiTool } from '../sysintel/effects.ts'
import type { Tool } from './types.ts'

/**
 * System Intelligence mode's tools. si_org is the organization model (hats, lifecycles,
 * reviews, cadence); si_work moves initiatives through their lifecycle; si_artifact keeps
 * the organization's documents; si_record attaches evidence, reviews, decisions, risks,
 * and sign-offs. Every call goes through the engine, which validates parameters and
 * returns the action's exact usage when a call is wrong.
 */

const DESCRIPTIONS: Record<SiTool, string> = {
  si_org: 'The organization model System Intelligence mode runs work through: every hat (CTO, chief scientist, research scientist/engineer, applied researcher, PM, designer, backend/frontend/full-stack/platform/infrastructure engineers, data engineer/scientist, ML/MLOps/AI engineers, SRE, security, QA, TPM, technical writer, staff/principal engineers) and the one question each owns; the lifecycles (feature, change, research, incident, vulnerability, data-pipeline, analysis, ml, llm, ux, rfc, planning) with their stages, owners, and exit gates; review kinds and who counts as independent; sign-off gates; the level ladders; the daily/research/weekly/quarterly cadence and where each forum lives; structure is the org chart with its teams (including the specialised teams of an autonomous-AI organization). triage previews how an intake would be scaled — nothing is recorded.',
  si_work: 'Initiatives through their lifecycle: intake (triage → fixed stages and gates), show, list (the board), gate (evaluate the current stage), advance (pass the gates, or loop back with a reason), plan (work breakdown with owner hats, priorities, dependencies, acceptance criteria), item, retriage (raise rigor on new facts), block/unblock, depend, assign (the owning team), link (existing initiatives as follow-ups), handoff (validated research → engineering), close (abandon), brief (a ready task call for the hat that owns the stage, or for an independent reviewer with review:…), report (board, priorities, week, quarter, flywheel, dependencies, risks, knowledge, digest).',
  si_artifact: "The organization's written memory: template (the required sections), write (a new version, validated against its template and hashed — an invalid one is kept but never satisfies a gate), validate, show, list (the knowledge index), export (copy a valid artifact into the project, e.g. docs/rfcs/). Kinds: PRD, roadmap, user stories, RFC, ADR, design doc, API spec, test plan, release plan, literature review, research proposal, experiment plan/results, benchmark report, paper, feasibility, SLO, runbook, incident report, postmortem, threat model, security review, vulnerability report, data contract, lineage, analysis report, model card, eval report, UX spec, strategy, OKRs, program plan, developer guide.",
  si_record: 'Evidence against the current stage of an initiative: note and link (findings — they end soft stages only), check (the engine runs the command, gated like run_command, and records the real exit status on the exact code — the only way a test counts), commit and branch (verified in git), review (counts only from an independent reviewer worker, and goes stale when the code or artifact changes), decide (decision log), risk (risk register), signoff (a decision only the person can make — the governor always asks them).',
}

/** Actions a delegated worker may use. The lead has every action. */
function workerActions(canWrite: boolean, canRun: boolean): (tool: SiTool, action: string) => boolean {
  const readOnlyWork = new Set(['show', 'list', 'gate', 'brief', 'report'])
  return (tool, action) => {
    if (tool === 'si_org') return true
    if (tool === 'si_work') return readOnlyWork.has(action) || (canWrite && action === 'item')
    if (tool === 'si_artifact') return ['template', 'validate', 'show', 'list'].includes(action) || (canWrite && action === 'write')
    // si_record — sign-offs are the lead's to ask for.
    if (action === 'signoff') return false
    if (action === 'check') return canRun
    if (action === 'decide' || action === 'risk') return canWrite
    return true
  }
}

function makeTool(name: SiTool, allow: (tool: SiTool, action: string) => boolean = () => true, restricted = false): Tool {
  const specs = actionsFor(name).filter((spec) => allow(name, spec.action))
  const actions = specs.map((spec) => spec.action)
  const properties: Record<string, unknown> = { action: { type: 'string', enum: actions, description: specs.map((spec) => `${spec.action}: ${spec.summary}`).join(' | ') } }
  for (const spec of specs) {
    for (const [param, doc] of Object.entries(spec.params)) {
      if (properties[param]) continue
      const type = doc.type === 'string[]' || doc.type === 'object[]' ? 'array' : doc.type
      properties[param] = {
        type,
        description: doc.description,
        ...(doc.type === 'string[]' ? { items: { type: 'string', ...(doc.enum ? { enum: [...doc.enum] } : {}) } } : doc.type === 'object[]' ? { items: { type: 'object' } } : {}),
        // Shared across actions: only constrain the schema when every action agrees on the values.
        ...(doc.enum && doc.type === 'string' && specs.every((candidate) => !candidate.params[param] || candidate.params[param]!.enum === doc.enum) ? { enum: [...doc.enum] } : {}),
      }
    }
  }
  return {
    name,
    description: `${DESCRIPTIONS[name]} Pass "action" plus that action's parameters; a wrong call returns the action's exact usage.${restricted ? ` As a delegated worker you have: ${actions.join(', ')}.` : ''}`,
    input_schema: { type: 'object', properties, required: ['action'] },
    async execute(input) {
      if (!actions.includes(String(input.action))) throw new Error(`${name} action "${String(input.action)}" is not available here (available: ${actions.join(', ')})`)
      return runAction(name, input)
    },
  }
}

export const SYSINTEL_TOOL_NAMES: readonly SiTool[] = SYSINTEL_TOOLS
export const sysintelTools: Tool[] = SYSINTEL_TOOLS.map((name) => makeTool(name))

/** The tool set a delegated worker gets in System Intelligence mode, by what its role may do. */
export function sysintelWorkerTools(canWrite: boolean, canRun: boolean): Tool[] {
  const allow = workerActions(canWrite, canRun)
  return SYSINTEL_TOOLS.map((name) => makeTool(name, allow, true))
}
