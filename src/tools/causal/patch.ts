// Patch generation: create concrete patches from repair plans.

import type { GeneratedPatch, RepairPlan } from './types.ts'
import { getFileAtHead, getFileAtCommit } from './gitProvenance.ts'
import { unifiedDiff } from '../../ui/diff.ts'

/** Generate a patch from a repair plan. */
export async function generatePatch(
  plan: RepairPlan,
  targetFile: string,
  rootCauseCommit: string,
  cwd: string,
): Promise<GeneratedPatch> {
  const currentContent = await getFileAtHead(targetFile, cwd)

  if (!currentContent) {
    return {
      filePath: targetFile,
      diff: '',
      filesAffected: [],
      linesChanged: 0,
      explanation: 'Could not read current file content',
      expectedBehavior: 'N/A',
      risks: ['Cannot generate patch without current file content'],
      confidence: 0,
      applied: false,
    }
  }

  // Get the content before the root cause commit
  const beforeContent = await getFileAtCommit(targetFile, rootCauseCommit, cwd)

  if (!beforeContent) {
    // Generate a simple revert diff
    return generateRevertPatch(targetFile, rootCauseCommit, plan, cwd)
  }

  // Generate a diff from before the commit to current
  const diff = unifiedDiff(beforeContent, currentContent, targetFile)

  const filesAffected = plan.steps.map((s) => s.filePath)
  const uniqueFiles = [...new Set(filesAffected)]
  const linesChanged = diff.added + diff.removed

  const risks: string[] = []
  if (plan.overallRisk === 'high') risks.push('High-risk changes involved')
  if (uniqueFiles.length > 3) risks.push('Multiple files affected')
  if (linesChanged > 100) risks.push('Large diff — review carefully')

  return {
    filePath: targetFile,
    diff: formatDiff(diff),
    filesAffected: uniqueFiles,
    linesChanged,
    explanation: `Patch to revert behavioral changes introduced in commit ${rootCauseCommit.slice(0, 8)}`,
    expectedBehavior: `After applying this patch, ${targetFile} should behave as it did before commit ${rootCauseCommit.slice(0, 8)}`,
    risks,
    confidence: plan.confidence,
    applied: false,
  }
}

/** Generate a patch by reverting a specific commit. */
async function generateRevertPatch(
  targetFile: string,
  rootCauseCommit: string,
  plan: RepairPlan,
  cwd: string,
): Promise<GeneratedPatch> {
  const { runGit } = await import('../../autonomy/worktree.ts')
  const result = await runGit(
    ['diff', `${rootCauseCommit}^..${rootCauseCommit}`, '--', targetFile],
    cwd,
  )

  const diff = result.exitCode === 0 ? result.stdout : ''
  const linesChanged = (diff.match(/^\+[^+]/gm)?.length ?? 0) + (diff.match(/^\-[^-]/gm)?.length ?? 0)

  return {
    filePath: targetFile,
    diff,
    filesAffected: [targetFile],
    linesChanged,
    explanation: `Revert diff for commit ${rootCauseCommit.slice(0, 8)} on ${targetFile}`,
    expectedBehavior: `Reverting commit ${rootCauseCommit.slice(0, 8)} should restore the previous behavior`,
    risks: ['Revert may have conflicts if file was modified after the commit'],
    confidence: plan.confidence,
    applied: false,
  }
}

/** Format a UnifiedDiff for display. */
function formatDiff(diff: { path: string; hunks: Array<{ lines: string[] }> }): string {
  const lines: string[] = []
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      lines.push(line)
    }
  }
  return lines.join('\n')
}

/** Apply a patch to a file. */
export async function applyPatch(
  patch: GeneratedPatch,
  cwd: string,
): Promise<{ success: boolean; output: string }> {
  if (!patch.diff) {
    return { success: false, output: 'No diff content to apply' }
  }

  const { runGit } = await import('../../autonomy/worktree.ts')

  // Write the patch to a temporary file
  const patchFile = `${cwd}/.elia/temp_patch_${Date.now()}.patch`
  const { writeFileSync, mkdirSync, existsSync } = await import('node:fs')
  const { dirname } = await import('node:path')

  const dir = dirname(patchFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(patchFile, patch.diff)

  try {
    const result = await runGit(['apply', '--check', patchFile], cwd)
    if (result.exitCode !== 0) {
      return { success: false, output: `Patch check failed: ${result.stderr}` }
    }

    const applyResult = await runGit(['apply', patchFile], cwd)
    if (applyResult.exitCode !== 0) {
      return { success: false, output: `Patch apply failed: ${applyResult.stderr}` }
    }

    patch.applied = true
    return { success: true, output: 'Patch applied successfully' }
  } finally {
    try {
      const { unlinkSync } = await import('node:fs')
      unlinkSync(patchFile)
    } catch { /* cleanup best effort */ }
  }
}
