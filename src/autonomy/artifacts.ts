import { join } from 'node:path'
import type { Proposal } from './types.ts'
import { renderProposalMarkdown, type PlanApprovalState } from './proposal.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'

export { getArtifactsDir, listArtifacts, readArtifact } from './artifactReader.ts'
import { getArtifactsDir } from './artifactReader.ts'

/**
 * Saves a proposal as a Markdown artifact in .elia/artifacts/plan.md
 * as well as under the specific run directory (.elia/runs/<runId>/plan.md).
 *
 * Written as soon as a valid proposal is captured (state `draft`), then
 * re-written with the outcome once the user decides — so a rejected or amended
 * plan still leaves a durable record, not just scrollback.
 */
export function savePlanArtifact(
  proposal: Proposal,
  runId?: string,
  cwd = process.cwd(),
  approvalState: PlanApprovalState = 'draft',
): string {
  const artifactsDir = getArtifactsDir(cwd)
  ensureSecureDirectory(artifactsDir)

  const content = renderProposalMarkdown(proposal, { state: approvalState, runId, at: Date.now() })
  const mainPlanPath = join(artifactsDir, 'plan.md')
  writeSecureFile(mainPlanPath, content)

  if (runId) {
    const runDir = join(cwd, '.elia', 'runs', runId)
    try {
      ensureSecureDirectory(runDir)
      writeSecureFile(join(runDir, 'plan.md'), content)
    } catch {
      // Non-fatal
    }
  }

  return mainPlanPath
}
