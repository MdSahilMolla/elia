/**
 * Human-readable rendering of a `/quickchat` command result for the REPL.
 *
 * `handleQuickchatCommand` returns structured results; this file turns them
 * into one string per kind so the interactive and classic REPLs can print them
 * without duplicating shape-handling. Pure.
 */
import type { QuickchatDelegationResult } from '../session/types.ts'

/** Formats `handleQuickchatCommand`'s `result` into a single printable string. */
export function formatQuickchatResult(result: unknown): string {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result

  const asRecord = result as Record<string, unknown>

  if ('answer' in asRecord && typeof asRecord.answer === 'string') {
    return asRecord.answer
  }
  if ('error' in asRecord && typeof asRecord.error === 'string') {
    return `quickchat: ${asRecord.error}`
  }

  // /quickchat delegate confirmation.
  const delegation = result as Partial<QuickchatDelegationResult>
  if (delegation.confirmation) {
    return delegation.confirmation
  }

  // /quickchat status.
  if ('status' in asRecord && 'taskQueue' in asRecord) {
    const tasks = Array.isArray(asRecord.taskQueue) ? (asRecord.taskQueue as Array<{ status?: string; goal?: string }>) : []
    if (tasks.length === 0) return `session ${String(asRecord.status)} · queue empty`
    const lines = tasks.map((task) => `- [${task.status ?? 'queued'}] ${task.goal ?? ''}`.trimEnd())
    return `session ${String(asRecord.status)}\n${lines.join('\n')}`
  }

  return JSON.stringify(result)
}