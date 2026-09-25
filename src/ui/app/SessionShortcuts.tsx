import { useInput } from 'ink'
import { getSessionBus } from '../../session/bus.ts'
import type { SessionBus, SessionHandle } from '../../session/types.ts'
import { sessionKeyAction } from './sessionActions.ts'
import { sessionKeyCombo } from './sessionShortcuts.ts'

export interface SessionShortcutsProps {
  bus?: SessionBus
  /** While a modal or menu owns the screen, the combos stand down. */
  disabled?: boolean
  /** ctrl+shift+n (or ctrl+n — the terminal can't tell them apart). */
  onSpawnSession?: () => void
  /** ctrl+tab / ctrl+shift+tab — the session that was just made active. */
  onCycle?: (handle: SessionHandle) => void
}

/**
 * Global parallel-session shortcuts for the Ink REPL. Renders nothing; each
 * registered combo is dispatched through `sessionKeyAction` from
 * `sessionActions.ts`. Mounting it in App.tsx is what makes the pure helper's
 * decisions reach the running terminal.
 */
export function SessionShortcuts({ bus = getSessionBus(), disabled = false, onSpawnSession, onCycle }: SessionShortcutsProps) {
  useInput(
    (input, key) => {
      const combo = sessionKeyCombo(input, key)
      if (combo === undefined) return
      const sessions = bus.list()
      const activeIndex = sessions.findIndex((session) => session.id === bus.activeSession)
      const action = sessionKeyAction(combo, activeIndex, sessions.length)
      if (action.type === 'spawn') {
        onSpawnSession?.()
        return
      }
      if (action.type === 'cycle-next' || action.type === 'cycle-prev') {
        // The pure helper already vetted active/count; guard the wrap math anyway.
        if (sessions.length < 2 || activeIndex < 0) return
        const delta = action.type === 'cycle-next' ? 1 : -1
        const target = sessions[(activeIndex + delta + sessions.length) % sessions.length]!
        bus.setActiveSession(target.id)
        onCycle?.(target)
      }
    },
    { isActive: !disabled },
  )
  return null
}