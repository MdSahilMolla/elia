import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'
import { editFileTool } from './editFile.ts'
import { listFilesTool } from './listFiles.ts'
import { grepTool } from './grep.ts'
import { runCommandTool } from './runCommand.ts'
import { boardPostTool, boardReadTool } from './blackboard.ts'
import { newEngagementTool } from './engagement.ts'
import { runSecurityToolTool } from './securityScan.ts'
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
import { githubTool } from './github.ts'
import { todoWriteTool } from './todo.ts'
import type { Tool } from './types.ts'

/** The built-in file and shell tools. */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  grepTool,
  runCommandTool,
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
  githubTool,
]

/** Tools that let a fleet of sub-agents coordinate instead of working blind. */
export const collaborationTools: Tool[] = [boardPostTool, boardReadTool]

/** Browser observation is available to workers; mutations are governed at runtime. */
export const browserTools: Tool[] = [browserTool]

/** Durable draft/send/verify workflows for external communication; consequential actions remain governed. */
export const communicationTools: Tool[] = [communicationTool]

/** Only granted to the lead agent's own turn, and only in cyber mode — see agent.ts. */
export const cyberTools: Tool[] = [newEngagementTool, runSecurityToolTool]

/** Real external data for the Marketing/Finance personas — see src/agents/personas.ts. Tech's toolset is unchanged. */
export const businessTools: Tool[] = [webSearchTool, webFetchTool, readSpreadsheetTool, spreadsheetTool, presentationTool]

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

// Tools proxied from connected MCP servers (see src/mcp/registry.ts), populated
// once at startup. Kept mutable for the same reason as synthesizedTools above —
// discovery happens after this module is first imported.
const mcpTools: Tool[] = []

export function registerMcpTool(tool: Tool): void {
  const index = mcpTools.findIndex((existing) => existing.name === tool.name)
  if (index === -1) mcpTools.push(tool)
  else mcpTools[index] = tool
}

/** Test-only: clears MCP tool registrations so one test file's fixture servers don't leak into another's assertions. */
export function clearMcpToolsForTests(): void {
  mcpTools.length = 0
}

export function getMcpTools(): Tool[] {
  return [...mcpTools]
}

/** Every tool available to a worker: built-ins, collaboration, anything elia has synthesized, and connected MCP servers. */
export function allWorkerTools(): Tool[] {
  return [...tools, ...collaborationTools, ...browserTools, ...communicationTools, ...synthesizedTools, ...mcpTools]
}

export function findTool(name: string): Tool | undefined {
  return allWorkerTools().find((tool) => tool.name === name)
}
