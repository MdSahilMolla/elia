import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A shared whiteboard for a fleet of sub-agents.
 *
 * Sub-agents are normally hermetic: isolated context, no way to talk to each
 * other, so two of them investigating the same repo rediscover the same facts
 * and burn the same tokens twice. Real teams don't work that way — one person
 * finds the migration script and says so out loud, and nobody else goes looking.
 *
 * The blackboard is that. It's append-only and tiny on purpose: notes, not
 * conversation. Sub-agents post findings the moment they have them and read the
 * board before starting expensive work, which turns a parallel fleet from N
 * independent workers into one that actually cooperates.
 */

export interface BoardNote {
  at: number
  from: string
  topic: string
  note: string
}

export interface Blackboard {
  post(from: string, topic: string, note: string): BoardNote
  read(topic?: string): BoardNote[]
  /** Compact text rendering, suitable for dropping straight into a prompt. */
  render(topic?: string): string
  size(): number
}

const MAX_NOTES = 200
const MAX_NOTE_LENGTH = 2000

export function createBlackboard(persistPath?: string): Blackboard {
  const notes: BoardNote[] = []

  function persist(): void {
    if (!persistPath) return
    try {
      mkdirSync(dirname(persistPath), { recursive: true })
      writeFileSync(persistPath, JSON.stringify(notes, null, 2))
    } catch {
      // The board is primarily in-memory; losing the on-disk copy is not fatal.
    }
  }

  return {
    post(from, topic, note) {
      const entry: BoardNote = {
        at: Date.now(),
        from,
        topic: topic.trim() || 'general',
        note: note.length > MAX_NOTE_LENGTH ? `${note.slice(0, MAX_NOTE_LENGTH)}…` : note,
      }
      notes.push(entry)
      // Oldest notes fall off rather than letting a long run grow the board
      // without bound — it gets injected into prompts.
      if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES)
      persist()
      return entry
    },

    read(topic) {
      if (!topic) return [...notes]
      const needle = topic.toLowerCase()
      return notes.filter((note) => note.topic.toLowerCase().includes(needle))
    },

    render(topic) {
      const selected = this.read(topic)
      if (selected.length === 0) return '(the board is empty)'
      return selected.map((note) => `- [${note.topic}] ${note.from}: ${note.note}`).join('\n')
    },

    size() {
      return notes.length
    },
  }
}

// --- Ambient board for the current run ---
// Tools reach the board through this rather than a parameter, because the Tool
// interface is intentionally context-free. Outside a run there is still a board,
// so `board_post` in a plain interactive session works instead of erroring.

let activeBoard: Blackboard = createBlackboard()

export function setActiveBlackboard(board: Blackboard): void {
  activeBoard = board
}

export function activeBlackboard(): Blackboard {
  return activeBoard
}

export function resetActiveBlackboard(): void {
  activeBoard = createBlackboard()
}
