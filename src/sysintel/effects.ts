/**
 * How each System Intelligence action touches the world. The governor reads this table
 * without importing the engine, and the engine refuses to register an action whose
 * effect is not declared here.
 *
 *   compute       reads the org model or the record; writes nothing
 *   record        appends to the workspace-local record under .elia/sysintel
 *   git-read      reads git metadata (commit, branch) and records it
 *   process       runs a command; the command itself is gated as run_command
 *   project-write copies an artifact into the project tree
 *   signoff       records a decision only a person can make — always asks
 */

export type Effect = 'compute' | 'record' | 'git-read' | 'process' | 'project-write' | 'signoff'

export const SYSINTEL_TOOLS = ['si_org', 'si_work', 'si_artifact', 'si_record'] as const
export type SiTool = (typeof SYSINTEL_TOOLS)[number]

export const EFFECTS: Record<string, Effect> = {
  'si_org.roles': 'compute',
  'si_org.role': 'compute',
  'si_org.lifecycles': 'compute',
  'si_org.lifecycle': 'compute',
  'si_org.ownership': 'compute',
  'si_org.reviews': 'compute',
  'si_org.ladder': 'compute',
  'si_org.cadence': 'compute',
  'si_org.triage': 'compute',
  'si_org.structure': 'compute',
  'si_work.intake': 'record',
  'si_work.show': 'compute',
  'si_work.list': 'compute',
  'si_work.gate': 'compute',
  'si_work.advance': 'record',
  'si_work.plan': 'record',
  'si_work.item': 'record',
  'si_work.retriage': 'record',
  'si_work.block': 'record',
  'si_work.unblock': 'record',
  'si_work.depend': 'record',
  'si_work.assign': 'record',
  'si_work.link': 'record',
  'si_work.handoff': 'record',
  'si_work.close': 'record',
  'si_work.brief': 'compute',
  'si_work.report': 'compute',
  'si_artifact.template': 'compute',
  'si_artifact.write': 'record',
  'si_artifact.validate': 'compute',
  'si_artifact.show': 'compute',
  'si_artifact.list': 'compute',
  'si_artifact.export': 'project-write',
  'si_record.note': 'record',
  'si_record.link': 'record',
  'si_record.check': 'process',
  'si_record.commit': 'git-read',
  'si_record.branch': 'git-read',
  'si_record.review': 'record',
  'si_record.decide': 'record',
  'si_record.risk': 'record',
  'si_record.signoff': 'signoff',
}

export function sysintelEffect(tool: string, action: string): Effect | undefined {
  return EFFECTS[`${tool}.${action}`]
}

/** Only these actions change the record; read-only workers get the rest plus review and note. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(Object.entries(EFFECTS).filter(([, effect]) => effect === 'compute').map(([key]) => key))

/** The record lives here; the governor refuses direct writes to it. */
export const SYSINTEL_RECORD_DIR = '.elia/sysintel'
