import { expect, test } from 'bun:test'
import { todoWriteTool } from './todo.ts'
import { resetActiveTodoList } from '../autonomy/todoList.ts'

test('todo_write renders the list with status markers', async () => {
  resetActiveTodoList()
  const result = await todoWriteTool.execute({
    items: [
      { content: 'read the config', status: 'completed' },
      { content: 'add the new tool', status: 'in_progress' },
      { content: 'write tests', status: 'pending' },
    ],
  })
  expect(result).toBe('[x] read the config\n[~] add the new tool\n[ ] write tests')
})

test('todo_write replaces the previous list rather than appending', async () => {
  resetActiveTodoList()
  await todoWriteTool.execute({ items: [{ content: 'first plan', status: 'pending' }] })
  const result = await todoWriteTool.execute({ items: [{ content: 'revised plan', status: 'pending' }] })
  expect(result).toBe('[ ] revised plan')
  expect(result).not.toContain('first plan')
})

test('todo_write rejects more than one in_progress item', async () => {
  resetActiveTodoList()
  await expect(
    todoWriteTool.execute({
      items: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress' },
      ],
    }),
  ).rejects.toThrow('at most one item may be in_progress')
})

test('todo_write validates item shape', async () => {
  resetActiveTodoList()
  await expect(todoWriteTool.execute({ items: 'not-an-array' })).rejects.toThrow('items must be an array')
  await expect(todoWriteTool.execute({ items: [{ content: '', status: 'pending' }] })).rejects.toThrow('content must be a non-empty string')
  await expect(todoWriteTool.execute({ items: [{ content: 'x', status: 'bogus' }] })).rejects.toThrow('status must be one of')
})
