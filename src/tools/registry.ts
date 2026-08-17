import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'
import { editFileTool } from './editFile.ts'
import { listFilesTool } from './listFiles.ts'
import { grepTool } from './grep.ts'
import { runCommandTool } from './runCommand.ts'
import { boardPostTool, boardReadTool } from './blackboard.ts'
import type { Tool } from './types.ts'

/** The built-in file and shell tools. */
export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  grepTool,
  runCommandTool,
]

/** Tools that let a fleet of sub-agents coordinate instead of working blind. */
export const collaborationTools: Tool[] = [boardPostTool, boardReadTool]

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

/** Every tool available to a worker: built-ins, collaboration, and anything elia has synthesized. */
export function allWorkerTools(): Tool[] {
  return [...tools, ...collaborationTools, ...synthesizedTools]
}

export function findTool(name: string): Tool | undefined {
  return allWorkerTools().find((tool) => tool.name === name)
}
