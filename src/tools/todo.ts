import type { Tool } from './types.ts'
import { activeTodoList, type TodoStatus } from '../autonomy/todoList.ts'

const VALID_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed']
const MAX_ITEMS = 50

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description:
    'Replace your working task list with the given items. Use it to plan a multi-step task before starting and to keep the plan current as you go: mark exactly one item in_progress at a time, mark items completed the moment they are actually done, and add items if scope changes. Skip this for a single simple action — it is for tasks with several real steps.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The full task list, replacing whatever was there before',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative description of the step' },
            status: { type: 'string', enum: VALID_STATUSES, description: 'pending, in_progress, or completed' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async execute(input) {
    if (!Array.isArray(input.items)) throw new Error('items must be an array')
    if (input.items.length > MAX_ITEMS) throw new Error(`items must not exceed ${MAX_ITEMS} entries`)

    let inProgressCount = 0
    const items = input.items.map((raw, i) => {
      if (typeof raw !== 'object' || raw === null) throw new Error(`items[${i}] must be an object`)
      const content = (raw as Record<string, unknown>).content
      const status = (raw as Record<string, unknown>).status
      if (typeof content !== 'string' || content.trim().length === 0) throw new Error(`items[${i}].content must be a non-empty string`)
      if (typeof status !== 'string' || !VALID_STATUSES.includes(status as TodoStatus)) throw new Error(`items[${i}].status must be one of: ${VALID_STATUSES.join(', ')}`)
      if (status === 'in_progress') inProgressCount += 1
      return { content: content.trim(), status: status as TodoStatus }
    })
    if (inProgressCount > 1) throw new Error('at most one item may be in_progress at a time')

    activeTodoList().write(items)
    return activeTodoList().render()
  },
}
