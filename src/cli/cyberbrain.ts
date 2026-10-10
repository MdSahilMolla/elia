import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { installCorpus, readInstallReceipt } from '../cyberbrain/install.ts'
import { CORPUS_FILES, corpusDir } from '../cyberbrain/paths.ts'
import type { CyberManifest } from '../cyberbrain/types.ts'
import { formatReceipt, validateCorpus } from '../cyberbrain/validate.ts'
import { writeError, writeNotice, writeUsageLine } from '../ui/stream.ts'
import { positionals } from './argv.ts'

/**
 * `elia cyberbrain` — install and verify the read-only retrieval corpus.
 *
 * Retrieval itself lives behind `store`/`index`/`open`; this command only
 * manages the data those read. `install` delegates to `installCorpus`, which
 * refuses to report success without a validation receipt, and `verify` prints
 * the raw receipt so every gate is visible. A failed verify is a non-zero exit
 * so a script can gate on it.
 */
const USAGE = 'Usage: elia cyberbrain [install <dir|zip|url> | verify | status]'

export async function runCyberbrain(argv: string[] = positionals()): Promise<void> {
  const [action = 'status', source] = argv

  if (action === 'install') {
    const summary = await installCorpus(source)
    if (summary.startsWith('FAILED')) {
      writeError(summary)
      process.exitCode = 1
      return
    }
    writeNotice(summary)
    return
  }

  if (action === 'verify') {
    const receipt = await validateCorpus(corpusDir())
    for (const line of formatReceipt(receipt).split('\n')) {
      // Failures belong on stderr in human modes; passes are informational.
      if (line.startsWith('FAIL') || line.startsWith('RESULT: FAILED')) writeError(line)
      else writeUsageLine(line)
    }
    if (!receipt.ok) process.exitCode = 1
    return
  }

  if (action === 'status') {
    await printStatus()
    return
  }

  writeError(`Unknown cyberbrain action "${action}". ${USAGE}`)
  process.exitCode = 1
}

/** Whether a corpus is installed, where, its counts, and when it was generated. */
async function printStatus(): Promise<void> {
  const dir = corpusDir()
  writeNotice(`CyberBrain corpus: ${dir}`)

  if (!(await exists(join(dir, CORPUS_FILES.records)))) {
    writeUsageLine('  status: not installed')
    writeUsageLine('  install with: elia cyberbrain install <dir|zip|url>')
    return
  }

  const receipt = await readInstallReceipt(dir)
  const validation = await validateCorpus(dir)
  const verdict = validation.ok ? 'validated' : 'validation failed'
  if (receipt) {
    writeUsageLine(`  status: installed (${verdict}) — from ${receipt.source} at ${receipt.installedAt}`)
  } else {
    writeUsageLine(`  status: installed (${verdict}) — no .installed.json receipt`)
  }
  writeUsageLine(`  records=${validation.recordCount} chunks=${validation.chunkCount}`)
  writeUsageLine(`  generated_at=${(await manifestGeneratedAt(dir)) ?? 'unknown (no manifest.json)'}`)
}

async function manifestGeneratedAt(dir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(join(dir, CORPUS_FILES.manifest), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const manifest = parsed as CyberManifest
    return typeof manifest.generated_at === 'string' ? manifest.generated_at : null
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}
