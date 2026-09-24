/**
 * Dependency-light bridge between the /quickchat command parser and the
 * delegation engine. Resolves a session reference (id or unambiguous name, or
 * the active session), then runs `delegateTask`. Never throws across the
 * bridge — soft failures come back as `{ ok: false, error }`.
 */
import type { DelegationMode, DelegationRecord, SessionBus, SessionId } from '../session/types.ts'
import { getSessionBus } from '../session/bus.ts'
import { delegateTask } from '../session/delegation.ts'

export interface QuickchatDelegateOptions {
  goal: string
  mode: DelegationMode
  /** Bare session id or name; defaults to the active session. */
  sessionRef?: string
  bus?: SessionBus
}

export type QuickchatDelegateResult =
  | { ok: true; result: { record: DelegationRecord; confirmation: string } }
  | { ok: false; error: string }

export async function handleQuickchatDelegate(opts: QuickchatDelegateOptions): Promise<QuickchatDelegateResult> {
  const bus = opts.bus ?? getSessionBus()
  const goal = opts.goal?.trim() ?? ''
  if (!goal) {
    return { ok: false, error: 'A delegate goal is required.' }
  }
  try {
    let target: SessionId | undefined
    if (opts.sessionRef && opts.sessionRef.trim().length > 0) {
      const handle = bus.resolve(opts.sessionRef)
      if (!handle) {
        return { ok: false, error: `Unknown session "${opts.sessionRef}".` }
      }
      target = handle.id
    }
    const { record, confirmation } = await delegateTask({ goal, mode: opts.mode, target, bus, source: 'quickchat' })
    return { ok: true, result: { record, confirmation } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}