import { writeSecureFile } from '../securePersistence.ts'

/**
 * A lightweight working task list for the current agent.
 *
 * Long coding tasks run for dozens of tool round-trips. Without an explicit,
 * externally-visible plan, a model tends to drift: it loses track of which
 * steps are done, forgets a step it meant to come back to, or declares
 * victory after finishing only part of what was asked. Making the model
 * write its plan down — and update it as steps complete — is a cheap,
 * well-established lever against exactly that failure mode.
 *
 * This mirrors the blackboard: append/replace-only, ambient via module state
 * so the tool stays context-free, and optionally persisted for visibility.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface TodoList {
  write(items: TodoItem[]): TodoItem[]
  read(): TodoItem[]
  /** Compact text rendering, suitable for a tool result or a prompt. */
  render(): string
}

const MAX_ITEMS = 50
const MAX_CONTENT_LENGTH = 300

export function createTodoList(persistPath?: string): TodoList {
  let items: TodoItem[] = []

  function persist(): void {
    if (!persistPath) return
    try {
      writeSecureFile(persistPath, JSON.stringify(items, null, 2))
    } catch {
      // The list is primarily in-memory; losing the on-disk copy is not fatal.
    }
  }

  return {
    write(next) {
      items = next.slice(0, MAX_ITEMS).map((item) => ({
        content: item.content.length > MAX_CONTENT_LENGTH ? `${item.content.slice(0, MAX_CONTENT_LENGTH)}…` : item.content,
        status: item.status,
      }))
      persist()
      return [...items]
    },

    read() {
      return [...items]
    },

    render() {
      if (items.length === 0) return '(todo list is empty)'
      const marker: Record<TodoStatus, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }
      return items.map((item) => `${marker[item.status]} ${item.content}`).join('\n')
    },
  }
}

// --- Ambient list for the current run ---
// Tools reach the list through this rather than a parameter, because the Tool
// interface is intentionally context-free. Outside a run there is still a
// list, so `todo_write` in a plain interactive session works instead of erroring.

let activeList: TodoList = createTodoList()

export function setActiveTodoList(list: TodoList): void {
  activeList = list
}

export function activeTodoList(): TodoList {
  return activeList
}

export function resetActiveTodoList(): void {
  activeList = createTodoList()
}
