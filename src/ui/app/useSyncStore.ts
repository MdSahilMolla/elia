import { useSyncExternalStore } from 'react'
import type { Snapshot, TranscriptStore } from './store.ts'

/** Subscribes a component to the transcript store; re-renders on every mutation. */
export function useTranscript(store: TranscriptStore): Snapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
