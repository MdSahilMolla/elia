import { cpSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { escapeShellArg, runShell } from '../shell.ts'
import { CORPUS_FILES, corpusDir } from './paths.ts'
import type { ValidationReceipt } from './types.ts'
import { validateCorpus } from './validate.ts'

/**
 * Installing the CyberBrain corpus from a release asset.
 *
 * The corpus is scraped data, not code, and it ships as a zip (or an already
 * extracted directory). Two rules shape this module:
 *
 * - Nothing is claimed until a receipt proves it. `validateCorpus` runs after
 *   the files land, and its verdict — including the manifest sha256 gate — is
 *   the only thing that turns an install into a success. A failing corpus is
 *   kept on disk (so a human can inspect it) but reported as FAILED, never OK.
 * - No silent fallbacks. A failed download, a missing `tar`/`unzip`, or a
 *   network error is a named failure, never a quiet success.
 *
 * Bun has no built-in unzip, so extraction shells out to `tar` (present on
 * modern Windows/macOS/Linux) and then `unzip`. When neither exists the manual
 * step is named rather than the install pretending to have worked.
 */

/** The files and directories copied out of a source that is already a directory. */
const COPY_TARGETS = [
  CORPUS_FILES.records,
  'chunks',
  CORPUS_FILES.taxonomyDir,
  CORPUS_FILES.indexesDir,
  CORPUS_FILES.manifest,
  CORPUS_FILES.coverage,
  CORPUS_FILES.deadends,
  CORPUS_FILES.rejected,
] as const

export const INSTALL_RECEIPT_FILE = '.installed.json'

export interface InstallReceipt {
  installedAt: string
  source: string
  ok: boolean
  recordCount: number
  chunkCount: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Install the corpus into {@link corpusDir} and prove it with a validation
 * receipt. `source` is a directory that already contains `records.jsonl`, a
 * local `.zip`, or an `http(s)` URL to one. Returns a human summary; a summary
 * beginning with `FAILED` means the corpus must not be treated as installed.
 */
export async function installCorpus(source?: string): Promise<string> {
  const dir = corpusDir()
  const trimmed = source?.trim() ?? ''
  if (trimmed.length === 0) {
    return 'FAILED: no corpus source given. Usage: elia cyberbrain install <dir|zip|url>'
  }

  try {
    if (/^https?:\/\//i.test(trimmed)) return await installFromUrl(trimmed, dir)

    const stat = await fs.stat(trimmed).catch(() => null)
    if (stat === null) return `FAILED: source not found: ${trimmed}`
    if (stat.isDirectory()) return await installFromDirectory(trimmed, dir)
    if (stat.isFile()) return await installFromZip(trimmed, dir, trimmed)
    return `FAILED: source is neither a directory nor a file: ${trimmed}`
  } catch (error) {
    return `FAILED: install aborted: ${errorMessage(error)}`
  }
}

/** Copies a directory that already holds the corpus, then validates what landed. */
async function installFromDirectory(from: string, dir: string): Promise<string> {
  if (!(await exists(join(from, CORPUS_FILES.records)))) {
    return `FAILED: ${from} is not a corpus directory — it has no ${CORPUS_FILES.records}`
  }
  await fs.mkdir(dir, { recursive: true })
  for (const relative of COPY_TARGETS) {
    const src = join(from, relative)
    if (!(await exists(src))) continue
    const dest = join(dir, relative)
    await fs.mkdir(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
  return await finishInstall(dir, from)
}

/** Downloads a zip to a temp file, then extracts and validates it. */
async function installFromUrl(url: string, dir: string): Promise<string> {
  const work = await fs.mkdtemp(join(tmpdir(), 'elia-cyberbrain-download-'))
  const zipPath = join(work, 'corpus.zip')
  try {
    let response: Response
    try {
      response = await fetch(url)
    } catch (error) {
      return `FAILED: could not download ${url}: ${errorMessage(error)}. Nothing was installed.`
    }
    if (!response.ok) {
      return `FAILED: download of ${url} returned HTTP ${response.status} ${response.statusText}. Nothing was installed.`
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0) {
      return `FAILED: download of ${url} returned no bytes. Nothing was installed.`
    }
    await fs.writeFile(zipPath, bytes)
    return await installFromZip(zipPath, dir, url)
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

/** Extracts a local zip into the corpus dir, flattening a single `kb_export/` wrapper. */
async function installFromZip(zipPath: string, dir: string, source: string): Promise<string> {
  const extracted = await extractZip(zipPath, dir)
  if (!extracted.ok) {
    return `FAILED: could not extract ${source}: ${extracted.message}. Extract it into ${dir} manually, then run: elia cyberbrain verify`
  }
  await flattenSingleTopFolder(dir)
  return await finishInstall(dir, source)
}

/** `tar`, then `unzip`; if neither can do it, says so instead of guessing. */
async function extractZip(zipPath: string, dir: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await fs.mkdir(dir, { recursive: true })
  const hasTar = Bun.which('tar') !== null
  const hasUnzip = Bun.which('unzip') !== null

  if (hasTar) {
    const result = await runShell(`tar -xf ${escapeShellArg(zipPath)} -C ${escapeShellArg(dir)}`)
    if (result.exitCode === 0) return { ok: true }
  }
  if (hasUnzip) {
    const result = await runShell(`unzip -o ${escapeShellArg(zipPath)} -d ${escapeShellArg(dir)}`)
    if (result.exitCode === 0) return { ok: true }
    return { ok: false, message: (result.stderr || result.stdout || 'unzip exited non-zero').trim() }
  }
  if (hasTar) return { ok: false, message: 'tar could not extract this zip' }
  return { ok: false, message: 'neither `tar` nor `unzip` is available on PATH' }
}

/**
 * A release zip extracts to a single `kb_export/` folder; the corpus loader
 * expects the files at the top. When exactly one directory is present and it
 * holds `records.jsonl`, its children are moved up and the wrapper removed.
 */
async function flattenSingleTopFolder(dir: string): Promise<void> {
  if (await exists(join(dir, CORPUS_FILES.records))) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return
  const inner = join(dir, entries[0]!.name)
  if (!(await exists(join(inner, CORPUS_FILES.records)))) return
  for (const entry of await fs.readdir(inner, { withFileTypes: true })) {
    await fs.rename(join(inner, entry.name), join(dir, entry.name))
  }
  await fs.rm(inner, { recursive: true, force: true })
}

/**
 * Validates the placed files, writes the install receipt, and reports the
 * verdict. The receipt is written either way so `status` can explain a failed
 * install; a failed validation is never rounded up to a success.
 */
async function finishInstall(dir: string, source: string): Promise<string> {
  const receipt = await validateCorpus(dir)
  const installed: InstallReceipt = {
    installedAt: new Date().toISOString(),
    source,
    ok: receipt.ok,
    recordCount: receipt.recordCount,
    chunkCount: receipt.chunkCount,
  }
  await fs.writeFile(join(dir, INSTALL_RECEIPT_FILE), `${JSON.stringify(installed, null, 2)}\n`)

  const digest = manifestDigestOutcome(receipt)
  if (receipt.ok) {
    return `OK: CyberBrain corpus installed at ${dir} — records=${receipt.recordCount} chunks=${receipt.chunkCount}; ${digest}`
  }
  const failures = receipt.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`)
  return `FAILED: files were placed at ${dir} but validation failed — ${failures.join('; ')}. ${digest}`
}

/** The manifest sha256 verdict, the gate that proves the bytes match the manifest. */
function manifestDigestOutcome(receipt: ValidationReceipt): string {
  const gate = receipt.checks.find((check) => check.name === 'manifest sha256')
  if (!gate) return 'manifest sha256: not checked'
  return `manifest sha256: ${gate.ok ? 'PASS' : 'FAIL'} (${gate.detail})`
}

/** Reads a prior install receipt, or null when the corpus was placed by hand. */
export async function readInstallReceipt(dir: string): Promise<InstallReceipt | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(join(dir, INSTALL_RECEIPT_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as InstallReceipt
  } catch {
    return null
  }
}
