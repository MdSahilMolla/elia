import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'
import { editFileTool } from './editFile.ts'
import { deleteFileTool } from './deleteFile.ts'
import { lspRefactorTool } from './lspRefactor.ts'
import { listFilesTool } from './listFiles.ts'
import { grepTool } from './grep.ts'
import { findSymbolTool } from './findSymbol.ts'
import { runCommandTool } from './runCommand.ts'
import { runProgramTool } from './runProgram.ts'
import { processTool } from './processTool.ts'
import { paperTool } from './paper.ts'
import { boardPostTool, boardReadTool } from './blackboard.ts'
import { newEngagementTool } from './engagement.ts'
import { runSecurityToolTool } from './securityScan.ts'
import { httpProbeTool } from './httpProbe.ts'
import { engagementReportTool, logFindingTool } from './findings.ts'
import { ctfToolchainTool } from './ctfToolchain.ts'
import { ctfPlaybookTool } from './ctfPlaybook.ts'
import { cyberBrainTool } from './cyberbrain.ts'
import { securityTriageTool } from './securityTriage.ts'
import { flagVerifyTool } from './flagVerify.ts'
import { askUserTool } from './askUser.ts'
import { webSearchTool } from './webSearch.ts'
import { webFetchTool } from './webFetch.ts'
import { readSpreadsheetTool } from './readSpreadsheet.ts'
import { spreadsheetTool } from './spreadsheet.ts'
import { presentationTool } from './presentation.ts'
import { recallTool } from './recall.ts'
import { brainTool } from './brain.ts'
import { createRationaleTool, createWhyTool } from '../autonomy/rationale.ts'
import { createDirectLessonsTool } from '../autonomy/lessons.ts'
import { browserTool } from './browser.ts'
import { communicationTool } from './communication.ts'
import { projectProfileTool } from './projectProfile.ts'
import { productionReadinessTool } from './productionReadiness.ts'
import { deploymentTool } from './deployment.ts'
import { financeTool } from './finance.ts'
import { dataScienceTool } from './dataScience.ts'
import { sportsTool } from './sports.ts'
import { fitnessTool } from './fitness.ts'
import { environmentTool } from './environment.ts'
import { provisionEnvironmentTool } from './provisionEnvironment.ts'
import { databaseTool } from './database.ts'
import { githubTool } from './github.ts'
import { todoWriteTool } from './todo.ts'
import { battmannTool } from './battmann.ts'
import { datascienceTools } from './dsMode.ts'
import { sysintelTools } from './sysintel.ts'
import { visualizeTool } from './visualize.ts'
import { causalDebugTool, causalFixTool, causalVerifyTool } from './causal/index.ts'
import { archDriftTool } from './archDrift.ts'
import { adversarialVerifyTool } from './adversarialVerify.ts'
import { codebaseMemoryTool } from './codebaseMemory.ts'
import { predictiveImpactTool } from './predictiveImpact.ts'
import { crossProjectLearnTool } from './crossProjectLearn.ts'
import { dependencyAuditTool } from './dependencyAudit.ts'
import { multiModalReviewTool } from './multiModalReview.ts'
import { selfHealingMonitorTool } from './selfHealingMonitor.ts'
import { federatedCollabTool } from './federatedCollab.ts'
import { specVerifyTool } from './specVerify.ts'
import { temporalAnalysisTool } from './temporalAnalysis.ts'
import type { Tool } from './types.ts'
import { missingCapabilityContracts } from '../autonomy/capabilityContract.ts'

/** The built-in file and shell tools. */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  lspRefactorTool,
  listFilesTool,
  grepTool,
  findSymbolTool,
  runCommandTool,
  runProgramTool,
  processTool,
  webSearchTool,
  webFetchTool,
  paperTool,
  visualizeTool,
  todoWriteTool,
  recallTool,
  brainTool,
  createWhyTool(),
  createRationaleTool(),
  createDirectLessonsTool(),
  projectProfileTool,
  productionReadinessTool,
  deploymentTool,
  financeTool,
  dataScienceTool,
  sportsTool,
  fitnessTool,
  environmentTool,
  provisionEnvironmentTool,
  databaseTool,
  githubTool,
  causalDebugTool,
  causalFixTool,
  causalVerifyTool,
  archDriftTool,
  adversarialVerifyTool,
  codebaseMemoryTool,
  predictiveImpactTool,
  crossProjectLearnTool,
  dependencyAuditTool,
  multiModalReviewTool,
  selfHealingMonitorTool,
  federatedCollabTool,
  specVerifyTool,
  temporalAnalysisTool,
]

/** Tools that let a fleet of sub-agents coordinate instead of working blind. */
export const collaborationTools: Tool[] = [boardPostTool, boardReadTool]

/** Browser observation is available to workers; mutations are governed at runtime. */
export const browserTools: Tool[] = [browserTool]

/** Durable draft/send/verify workflows for external communication; consequential actions remain governed. */
export const communicationTools: Tool[] = [communicationTool]

/** Only granted to the lead agent's own turn, and only in cyber mode — see agent.ts. */
export const cyberTools: Tool[] = [newEngagementTool, runSecurityToolTool, httpProbeTool, logFindingTool, engagementReportTool, ctfToolchainTool, ctfPlaybookTool, cyberBrainTool, securityTriageTool, askUserTool, flagVerifyTool]

/**
 * The one cyber tool that is also safe for worker roles. `cyberbrain` only reads
 * the local corpus — unlike the action-oriented tools in {@link cyberTools} it
 * spawns nothing and reaches no target — so a read-only scout fanned out during
 * RECON can consult prior art too. Positive allowlists still decide which roles
 * actually receive it (see src/autonomy/roles.ts).
 */
export const workerCyberTools: Tool[] = [cyberBrainTool]

/** Real external data for the Marketing/Finance personas — see src/agents/personas.ts. Tech's toolset is unchanged. */
export const businessTools: Tool[] = [readSpreadsheetTool, spreadsheetTool, presentationTool]
export const battmannTools: Tool[] = [battmannTool]
/** Data-science mode's execution engine — see src/datascience/engine.ts. Granted only in that mode. */
export { datascienceTools, readOnlyDatascienceTools } from './dsMode.ts'
/** System Intelligence mode's organization engine — see src/sysintel/engine.ts. Granted only in that mode. */
export { sysintelTools, sysintelWorkerTools } from './sysintel.ts'

/**
 * The complete static registry. Dynamic skills and MCP tools are intentionally
 * excluded: they must declare their own capability contract before autonomous
 * exposure rather than receiving a permissive built-in default.
 */
export function allBuiltinTools(): Tool[] {
  return [...tools, ...collaborationTools, ...browserTools, ...communicationTools, ...cyberTools, ...businessTools, ...battmannTools, ...datascienceTools, ...sysintelTools]
}

/** Fail closed when a newly registered built-in lacks a capability contract. */
export function assertBuiltinCapabilityContracts(): void {
  const missing = missingCapabilityContracts(allBuiltinTools())
  if (missing.length > 0) throw new Error(`Built-in tools missing capability contracts: ${missing.join(', ')}`)
}

assertBuiltinCapabilityContracts()

export const toolsByName: Record<string, Tool> = Object.fromEntries(
  tools.map((tool) => [tool.name, tool]),
)

// Tools elia wrote for itself, loaded at startup from ~/.elia/skills and
// .elia/skills. Kept in a mutable list because they arrive after this module is
// first imported, and every role's tool set has to pick them up.
const synthesizedTools: Tool[] = []

export function registerSynthesizedTool(tool: Tool): void {
  const index = synthesizedTools.findIndex((existing) => existing.name === tool.name)
  if (index === -1) synthesizedTools.push(tool)
  else synthesizedTools[index] = tool
}

export function getSynthesizedTools(): Tool[] {
  return [...synthesizedTools]
}

/**
 * Drops every synthesized tool. `loadSkills()` registers into a module-level
 * list, so a test that loads a skill leaves it visible to `allWorkerTools()`
 * for the rest of the process — `bun test` shares one module registry across
 * every file. Linux `readdir` is not sorted, so the leaked tool reached
 * governor.test.ts's "every registered tool declares a contract" assertion
 * there and not on Windows: a CI-only failure with no CI-only cause.
 * `loadSkills()` now calls this on entry so the registry can't accumulate
 * across reloads; call it directly only when a test needs isolation without
 * going through `loadSkills()`.
 */
export function clearSynthesizedTools(): void {
  synthesizedTools.length = 0
}

// Tools proxied from connected MCP servers (see src/mcp/registry.ts), populated
// once at startup. Kept mutable for the same reason as synthesizedTools above —
// discovery happens after this module is first imported.
const mcpTools: Tool[] = []

export function registerMcpTool(tool: Tool): void {
  const index = mcpTools.findIndex((existing) => existing.name === tool.name)
  if (index === -1) mcpTools.push(tool)
  else mcpTools[index] = tool
}

/** Drops every proxied MCP tool — used on `/mcp reload` before reconnecting, and by tests for isolation. */
export function clearMcpTools(): void {
  mcpTools.length = 0
}

/** @deprecated alias for {@link clearMcpTools}. */
export const clearMcpToolsForTests = clearMcpTools

export function getMcpTools(): Tool[] {
  return [...mcpTools]
}

/** Every tool available to a worker: built-ins, collaboration, the read-only cyber corpus reader, anything elia has synthesized, and connected MCP servers. */
export function allWorkerTools(): Tool[] {
  return [...tools, ...collaborationTools, ...browserTools, ...communicationTools, ...workerCyberTools, ...synthesizedTools, ...mcpTools]
}

export function findTool(name: string): Tool | undefined {
  return allWorkerTools().find((tool) => tool.name === name)
}
