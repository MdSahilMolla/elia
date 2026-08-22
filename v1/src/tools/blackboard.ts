import type { Tool } from './types.ts'
import { activeBlackboard } from '../autonomy/blackboard.ts'
import { currentAgent } from '../autonomy/context.ts'

export const boardPostTool: Tool = {
  name: 'board_post',
  description:
    'Publish a finding to the shared blackboard so the rest of the fleet can use it. Post anything another worker would otherwise have to rediscover: where a thing lives, an API shape, a gotcha, a decision you made. Keep each note to one or two sentences.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Short subject to file this under, e.g. "auth-flow", "build-config", "gotchas"',
      },
      note: { type: 'string', description: 'The finding itself, in one or two sentences' },
    },
    required: ['topic', 'note'],
  },
  async execute(input) {
    const topic = input.topic as string
    const note = input.note as string
    const entry = activeBlackboard().post(currentAgent().name, topic, note)
    return `Posted to blackboard under "${entry.topic}".`
  },
}

export const boardReadTool: Tool = {
  name: 'board_read',
  description:
    'Read the shared blackboard to see what the rest of the fleet has already found. Check this before starting an expensive investigation — someone may have answered it already.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'Optional topic filter (substring match). Omit to read the whole board.',
      },
    },
  },
  async execute(input) {
    const topic = input.topic as string | undefined
    return activeBlackboard().render(topic)
  },
}
