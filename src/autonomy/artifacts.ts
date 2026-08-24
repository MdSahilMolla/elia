import { join } from 'node:path'
import type { Proposal } from './types.ts'
import { renderProposalMarkdown } from './proposal.ts'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'

export { getArtifactsDir, listArtifacts, readArtifact } from './artifactReader.ts'
import { getArtifactsDir } from './artifactReader.ts'

/**
 * Saves a proposal as a Markdown artifact in .elia/artifacts/plan.md
 * as well as under the specific run directory (.elia/runs/<runId>/plan.md).
 */
export function savePlanArtifact(proposal: Proposal, runId?: string, cwd = process.cwd()): string {
  const artifactsDir = getArtifactsDir(cwd)
  ensureSecureDirectory(artifactsDir)

  const content = renderProposalMarkdown(proposal)
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
