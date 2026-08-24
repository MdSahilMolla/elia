import type { Tool } from './types.ts'
import { currentAgent } from '../autonomy/context.ts'
import { detectProject } from '../project.ts'

export const projectProfileTool: Tool = {
  name: 'project_profile',
  description: 'Inspect the current project and report detected Python, TypeScript, Bun, and React stacks, package manager, manifest signals, and declared verification commands. Use before coding in an unfamiliar repository.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute() {
    const profile = detectProject(currentAgent().cwd ?? process.cwd())
    return JSON.stringify(profile, null, 2)
  },
}
