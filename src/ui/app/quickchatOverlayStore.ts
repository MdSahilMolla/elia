import { createOverlay, withEscapeHandler, withIdleTimeout, QUICKCHAT_TIMEOUT_MS, type QuickchatOverlay } from '../../quickchat/overlay.ts'

/**
 * The React-facing face of the non-blocking quickchat overlay.
 *
 * Owns the one `createOverlay` instance per store, wires the escape hook and
 * the idle timeout, and exposes a `useSyncExternalStore`-friendly surface so
 * the Ink panel just reads the snapshot. The overlay itself stays React-free
 * and deterministic (see `quickchat/overlay.ts`) — this file only adapts it to
 * a subscribe/getSnapshot shape. The idle timeout is closed BEFORE listeners
 * are told, so nobody observes a supposedly-open panel that is already shut.
 */

export interface QuickchatOverlaySnapshot {
  /** Whether the panel is on screen right now. */
  status: 'open' | 'closed'
  /** The question the overlay was opened with. */
  question: string
  /** Everything streamed since open, in order. */
  answer: string
  /** Short label of the session being observed. */
  contextLabel: string
}

export interface QuickchatOverlayStore {
  open(question: string, contextLabel?: string): void
  /** Feed model output; also resets the idle window. */
  appendText(text: string): void
  /** The Ink escape-hook contract from `withEscapeHandler`. */
  handleEscape(key: string): { consumed: boolean }
  /** Programmatic close (idle timeout, layout teardown, …). */
  requestClose(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): QuickchatOverlaySnapshot
}

export interface QuickchatOverlayStoreOptions {
  /** Idle window before auto-close. Defaults to QUICKCHAT_TIMEOUT_MS (60s). */
  idleMs?: number
}

export function createQuickchatOverlayStore({ idleMs = QUICKCHAT_TIMEOUT_MS }: QuickchatOverlayStoreOptions = {}): QuickchatOverlayStore {
  const overlay: QuickchatOverlay = createOverlay()
  const escape = withEscapeHandler(overlay)
  const listeners = new Set<() => void>()

  // A static snapshot object is required by useSyncExternalStore: getSnapshot
  // must be referentially stable between state changes, or React 19 treats
  // every render's fresh object as "the store changed" and re-renders forever.
  let latest: QuickchatOverlaySnapshot = {
    status: overlay.status,
    question: overlay.question,
    answer: overlay.buffer,
    contextLabel: overlay.contextLabel,
  }
  const sync = (): void => {
    latest = {
      status: overlay.status,
      question: overlay.question,
      answer: overlay.buffer,
      contextLabel: overlay.contextLabel,
    }
    for (const listener of listeners) listener()
  }
  const schedule = withIdleTimeout(overlay, idleMs, () => {
    overlay.close()
    sync()
  })

  return {
    open(question: string, contextLabel?: string): void {
      overlay.open(question, contextLabel ?? '')
      // No idle window while the answer is still on its way: it started here,
      // so a slow model's answer arrived after the panel had closed itself and
      // was dropped. The call has its own ceiling (QUICKCHAT_TIMEOUT_MS) and
      // always ends in an answer or a failure line; the window starts then.
      sync()
    },
    appendText(text: string): void {
      overlay.appendChunk(text)
      sync()
    },
    handleEscape(key: string): { consumed: boolean } {
      const result = escape(key)
      if (result.consumed) sync()
      return result
    },
    requestClose(): void {
      overlay.close()
      schedule.reset()
      sync()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot(): QuickchatOverlaySnapshot {
      return latest
    },
  }
}

/** The store the running REPL renders (module singleton, like getSessionBus). */
export const quickchatStore = createQuickchatOverlayStore()