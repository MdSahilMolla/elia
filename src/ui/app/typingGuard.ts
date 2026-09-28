// A prompt that pops up while the person is typing must not take their keys as
// an answer. Seen live: an approval menu appeared mid-sentence, the "e" of
// "make sure" opened the command editor, and the Enter meant to send the note
// would have approved a command nobody read (Enter picks "Yes" there).
//
// The fix is the one browsers use on security dialogs: a prompt is armed only
// once the keyboard has been quiet for a moment since it appeared. A key before
// that — or a text key the prompt has no use for — is typing: it goes on into
// the message being written, and the wait starts over.
import { useEffect, useRef, useState } from 'react'
import type { Key } from 'ink'

/** How long the keyboard must be quiet, after a prompt appears or after the last key typed through it, before a key counts as an answer. */
export const ARM_MS = 800

/** Keys that edit a line of text rather than choose: characters, deletion, moving the caret. */
export function isTypingKey(input: string, key: Key): boolean {
  if (key.ctrl || key.meta) return false
  if (key.backspace || key.delete || key.leftArrow || key.rightArrow) return true
  if (key.return || key.escape || key.tab || key.upArrow || key.downArrow) return false
  return input.length > 0
}

/**
 * Whether a prompt is armed yet, and `press()` to call on every key it sees:
 * true when that key may count as an answer. A key that is not an answer should
 * call `rest()` so the prompt waits again for the keyboard to go quiet.
 */
export function useArming(ms: number = ARM_MS): { armed: boolean; press(): boolean; rest(): void } {
  const since = useRef(Date.now())
  const [armed, setArmed] = useState(ms <= 0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wait = () => {
    if (ms <= 0) return
    if (timer.current) clearTimeout(timer.current)
    setArmed(false)
    timer.current = setTimeout(() => setArmed(true), ms)
  }
  useEffect(() => {
    wait()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // Once, on mount: the prompt has just appeared.
  }, [])
  return {
    armed,
    // Timestamps, not the rendered flag, decide: a timer that fires a little late must not swallow a deliberate answer.
    press: () => ms <= 0 || Date.now() - since.current >= ms,
    rest: () => {
      since.current = Date.now()
      wait()
    },
  }
}
