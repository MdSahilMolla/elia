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
    if (typeof input.topic !== 'string' || input.topic.trim().length === 0) throw new Error('topic must be a non-empty string')
    if (typeof input.note !== 'string' || input.note.trim().length === 0) throw new Error('note must be a non-empty string')
    const topic = input.topic.trim().slice(0, 200)
    const note = input.note.trim().slice(0, 2_000)
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
    if (input.topic !== undefined && (typeof input.topic !== 'string' || input.topic.trim().length === 0)) throw new Error('topic must be a non-empty string when provided')
    const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, 200) : undefined
    return activeBlackboard().render(topic)
  },
}
