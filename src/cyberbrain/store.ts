/**
 * Loading the CyberBrain corpus: one read-only pass over the release files,
 * held in a cache that dies when the files move.
 *
 * The corpus is tens of megabytes of JSONL that a retrieval turn may touch many
 * times (search, open, validate), so the parsed view lives in a module-level
 * cache keyed by a fingerprint of the directory plus the mtimes of the three
 * files that matter — the same idea as brain/store.ts. Two tolerances are
 * deliberate: a file that is missing parses as an empty list, because a machine
 * without the corpus installed must get "0 records" from the browse path rather
 * than a stack trace, and a manifest that is absent or unparsable is simply
 * `null`. Corruption reporting belongs to validate.ts, so a torn JSONL line is
 * skipped here instead of thrown.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { registerCache } from '../cacheRegistry.ts'
import { CORPUS_FILES, corpusDir } from './paths.ts'
import type { CyberChunk, CyberCorpus, CyberManifest, CyberRecord } from './types.ts'

function parseJsonl<T>(path: string): T[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  const out: T[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value as T)
    } catch {
      // A torn line is skipped, not fatal: validate.ts is the gate that fails on it.
    }
  }
  return out
}

function loadManifest(path: string): CyberManifest | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as CyberManifest
  } catch {
    // Missing or unparsable manifest reads as "no manifest".
  }
  return null
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function fingerprint(dir: string): string {
  return [
    dir,
    mtime(join(dir, CORPUS_FILES.records)),
    mtime(join(dir, CORPUS_FILES.chunks)),
    mtime(join(dir, CORPUS_FILES.manifest)),
  ].join(':')
}

let cache: { fingerprint: string; corpus: CyberCorpus } | undefined

export async function loadCorpus(opts: { dir?: string; force?: boolean } = {}): Promise<CyberCorpus> {
  const dir = opts.dir ?? corpusDir()
  const fp = fingerprint(dir)
  if (!opts.force && cache && cache.fingerprint === fp) return cache.corpus

  const records = parseJsonl<CyberRecord>(join(dir, CORPUS_FILES.records))
  const chunks = parseJsonl<CyberChunk>(join(dir, CORPUS_FILES.chunks))

  const recordById = new Map<string, CyberRecord>(records.map((record) => [record.id, record]))

  const chunksByRecord = new Map<string, CyberChunk[]>()
  for (const chunk of chunks) {
    const group = chunksByRecord.get(chunk.record_id)
    if (group) group.push(chunk)
    else chunksByRecord.set(chunk.record_id, [chunk])
  }

  const categoryCounts = new Map<string, number>()
  for (const record of records) categoryCounts.set(record.category, (categoryCounts.get(record.category) ?? 0) + 1)

  const corpus: CyberCorpus = {
    dir,
    records,
    chunks,
    recordById,
    chunksByRecord,
    manifest: loadManifest(join(dir, CORPUS_FILES.manifest)),
    categoryCounts,
    loadedAt: Date.now(),
  }

  cache = { fingerprint: fp, corpus }
  return corpus
}

/** Drops the in-process corpus cache. Used by tests, `clearAllCaches()`, and a reinstall. */
export function resetCorpusCache(): void {
  cache = undefined
}

registerCache('cyberbrain', resetCorpusCache, () => (cache ? cache.corpus.records.length : 0))
