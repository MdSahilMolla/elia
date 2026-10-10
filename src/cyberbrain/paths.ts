import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the CyberBrain corpus lives.
 *
 * The corpus is a versioned release asset, not a committed artifact (it is tens
 * of megabytes of scraped CTF/VAPT records). It is shared across every project
 * on the machine, so the default is under the user's home, and `ELIA_CYBERBRAIN_DIR`
 * points it somewhere else — a checkout during development, or a mounted volume.
 */
export function corpusDir(): string {
  const override = process.env.ELIA_CYBERBRAIN_DIR
  if (override && override.trim().length > 0) return override.trim()
  return join(homedir(), '.elia', 'cyberbrain')
}

/** Paths inside a corpus directory. Kept in one place so load/validate/install agree. */
export const CORPUS_FILES = {
  records: 'records.jsonl',
  chunks: 'chunks/chunks.jsonl',
  coverage: 'coverage.json',
  manifest: 'manifest.json',
  deadends: 'deadends.jsonl',
  rejected: 'rejected.jsonl',
  taxonomyDir: 'taxonomy',
  indexesDir: 'indexes',
} as const
