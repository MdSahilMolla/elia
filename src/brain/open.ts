import { openRecording } from '../autonomy/recordingIndex.ts'

const MAX_BOOK_CHARS = 12_000

/**
 * The record behind a brain hit. Hits from a recording or a playbook end in a
 * pointer — `recording:<session>#<from>-<to>` or `book:<id>` — and this turns
 * one back into what it points at: the raw recorded events, or the whole
 * playbook. Shared by the `brain` tool (`action: "open"`) and `/brain open`.
 */
export async function openBrainReference(ref: string, cwd = process.cwd()): Promise<string> {
  const pointer = ref.trim()
  if (!pointer) return 'Nothing to open — pass the recording:… or book:… pointer shown beside a search hit.'
  if (!pointer.startsWith('book:')) return openRecording(pointer, cwd)

  const id = pointer.slice('book:'.length)
  const { readEliaBook, renderEliaBook } = await import('../eliaBook.ts')
  try {
    const book = readEliaBook(id, cwd)
    if (!book) return `There is no Elia Book "${id}".`
    const text = renderEliaBook(book)
    return text.length > MAX_BOOK_CHARS ? `${text.slice(0, MAX_BOOK_CHARS)}\n…[the playbook continues; read .elia/books/${book.id}.md for all of it]` : text
  } catch (error) {
    return `Could not open ${pointer}: ${error instanceof Error ? error.message : String(error)}`
  }
}
