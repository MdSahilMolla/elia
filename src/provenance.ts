/**
 * What made a change, carried on the change itself.
 *
 * elia's loop measures its own work: the evolve gate promotes a candidate only
 * when the record says that candidate helped. That record is worth no more than
 * its ability to answer which changes elia actually authored — and nothing on a
 * commit said so. A run's evidence lived under `.elia/`, the commit lived in
 * git, and the only thing joining them was the wall clock. Two sessions working
 * one checkout on one afternoon is enough to make that join wrong, and on
 * 2026-09-21 it was: reconstructing who wrote what took patch-ids and
 * byte-comparison after the fact.
 *
 * This is the join. A commit elia makes carries the run that made it, the model
 * that reasoned about it and the surface it came from, as git trailers —
 * greppable with `git log --grep`, parseable with `git interpret-trailers`, and
 * kept across rebase and cherry-pick because they live in the message rather
 * than in metadata beside it.
 *
 * Two things this deliberately is not. It is not a signature: nothing here is
 * unforgeable, and a trailer is evidence of provenance only as far as you trust
 * the machine that wrote it. And it is not a claim over the human's work —
 * `Elia-Surface` records which front end ran, so a commit a person drove
 * interactively reads differently from one an unattended run produced.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from './statePaths.ts'

/** Which front end produced the work. */
export type ProvenanceSurface = 'interactive' | 'auto' | 'evolve' | 'subagent' | 'vscode'

export interface RunFingerprint {
  /** The session this work belongs to — the key into the run's evidence under `.elia/`. */
  sessionId: string
  /** Which front end ran. */
  surface: ProvenanceSurface
  /** The model that did the reasoning, where one did. */
  model?: string
  /** elia's own version at the time. */
  version?: string
}

const provenanceStorage = new AsyncLocalStorage<RunFingerprint>()
let processFingerprint: RunFingerprint | undefined

/** Runs `fn` with this fingerprint ambient, the way `withActionGovernor` carries the governor. */
export function withProvenance<T>(fingerprint: RunFingerprint, fn: () => Promise<T>): Promise<T> {
  return provenanceStorage.run(fingerprint, fn)
}

/**
 * The fingerprint for this whole process.
 *
 * A CLI session is one process and one session, so the interactive front end
 * sets this once at startup rather than wrapping its entire loop in a scope.
 * A surface that genuinely nests — a sub-agent, one request on the VS Code
 * bridge — uses `withProvenance`, which takes precedence for the work inside it.
 */
export function setProcessProvenance(fingerprint: RunFingerprint | undefined): void {
  processFingerprint = fingerprint
}

/** The fingerprint of the run in progress, or undefined outside one. */
export function activeProvenance(): RunFingerprint | undefined {
  return provenanceStorage.getStore() ?? processFingerprint
}

/** elia's own package version. Read here rather than imported, so this module stays free of the evolve tree. */
export function eliaVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(ELIA_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** `ELIA_FINGERPRINT=off` stops elia signing anything, for a repository whose history must stay plain. */
export function fingerprintEnabled(): boolean {
  return process.env.ELIA_FINGERPRINT !== 'off'
}

/**
 * The human-facing byline.
 *
 * A co-author line names an identity, so the address matters: one that resolves
 * to an account someone else owns would attribute elia's work to a stranger.
 * `ELIA_COMMIT_BYLINE` overrides the default, and setting it empty drops the
 * line while keeping the machine-readable trailers — the byline is the part a
 * person reads, not the part the loop needs.
 */
export function commitByline(): string | undefined {
  const configured = process.env.ELIA_COMMIT_BYLINE
  if (configured === undefined) return 'Elia <officialsahilwork@gmail.com>'
  const trimmed = configured.trim()
  return trimmed || undefined
}

/** A trailer value is one line. Anything folded in from a model or a session id is flattened. */
function trailerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** The trailers this fingerprint contributes, in the order they are written. */
export function fingerprintTrailers(fingerprint: RunFingerprint): string[] {
  const lines = [`Elia-Run: ${trailerValue(fingerprint.sessionId)}`, `Elia-Surface: ${trailerValue(fingerprint.surface)}`]
  if (fingerprint.model) lines.push(`Elia-Model: ${trailerValue(fingerprint.model)}`)
  if (fingerprint.version) lines.push(`Elia-Version: ${trailerValue(fingerprint.version)}`)
  const byline = commitByline()
  if (byline) lines.push(`Co-Authored-By: ${trailerValue(byline)}`)
  return lines
}

/**
 * Whether the message already ends in a trailer block.
 *
 * Git reads trailers from the last paragraph only, so appending a second block
 * after a blank line would push the existing one out of the run and make both
 * unparseable. When the message already ends in trailers, these join that
 * paragraph instead of starting another.
 */
function endsWithTrailerBlock(body: string): boolean {
  const lastBreak = body.lastIndexOf('\n\n')
  const lastParagraph = lastBreak < 0 ? body : body.slice(lastBreak + 2)
  const lines = lastParagraph.split('\n').filter((line) => line.trim())
  return lines.length > 0 && lines.every((line) => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(line))
}

/**
 * The commit message elia should write, signed.
 *
 * Idempotent on purpose: a retried commit, or one whose message was built by a
 * path that had already signed it, must not collect the trailers twice. Outside
 * a run, or with signing off, the message is returned untouched.
 */
export function signCommitMessage(message: string, fingerprint = activeProvenance()): string {
  if (!fingerprint || !fingerprintEnabled()) return message
  const body = message.replace(/\s+$/, '')
  if (!body) return message
  if (/^Elia-Run:/m.test(body)) return message
  const trailers = fingerprintTrailers(fingerprint)
  if (trailers.length === 0) return message
  return `${body}${endsWithTrailerBlock(body) ? '\n' : '\n\n'}${trailers.join('\n')}\n`
}
