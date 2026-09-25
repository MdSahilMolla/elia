import type { SessionStatus } from '../../session/types.ts'

export type SessionKeyAction =
  | { type: 'none' }
  | { type: 'cycle-next' }
  | { type: 'cycle-prev' }
  | { type: 'spawn' }

export function sessionKeyAction(keyCombo: string, active: number, count: number): SessionKeyAction {
  if (keyCombo === 'ctrl-shift-n') return { type: 'spawn' }
  if (keyCombo === 'ctrl-tab' || keyCombo === 'ctrl-shift-tab') {
    if (count < 1 || active < 0 || active >= count) return { type: 'none' }
    return keyCombo === 'ctrl-shift-tab' ? { type: 'cycle-prev' } : { type: 'cycle-next' }
  }
  return { type: 'none' }
}

export function shouldAutoFocus(statuses: SessionStatus[]): number | undefined {
  const index = statuses.findIndex((status) => status === 'waiting-input')
  return index === -1 ? undefined : index
}

export interface SessionActivity {
  running: boolean
}

export function isIdle(handle: SessionActivity): boolean {
  return !handle.running
}