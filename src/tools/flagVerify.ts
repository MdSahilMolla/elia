import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureBeforeWrite } from '../checkpoint.ts'
import { engagementDir } from './engagement.ts'
import type { Tool } from './types.ts'

/**
 * Advisory flag verification.
 *
 * The contract this tool exists to enforce: `verified` is reachable *only*
 * through {@link flagVerify} derivation — a hash the challenge itself supplied.
 * Format, encoding and artifact-presence checks can raise confidence, but none
 * of them can promote a candidate to `verified`, because none of them prove the
 * flag is the one the challenge wants. A candidate with no derivation evidence
 * comes back `not-verifiable`, which is the honest answer and the reason this is
 * advisory rather than a gate: the caller records whatever it actually found.
 *
 * The Hasher incident is the reason. A run against a Windows PE produced 33
 * invented hash values and reported the challenge solved. Nothing in that run
 * was checked against the challenge, because nothing in the loop was able to
 * fail. Here a fabricated string fails the artifact-presence check and, with no
 * expected hash, can never claim to be verified.
 */

/** What "this looks like a flag" means when the caller does not supply a format. */
const DEFAULT_FLAG_FORMAT = /^[A-Za-z0-9_+/=-]{8,}$/

/** Cap the artifact walk so a stray `/` cannot turn a check into a full disk scan. */
const MAX_ARTIFACT_FILES = 2_000
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

type Verdict = 'verified' | 'unverified' | 'malformed' | 'not-verifiable'
type Confidence = 'high' | 'medium' | 'low'

export interface FlagCheck {
  id: string
  status: 'pass' | 'fail' | 'skip'
  detail: string
}

export interface FlagVerdict {
  advisory: true
  verdict: Verdict
  confidence: Confidence
  flag: string
  checks: FlagCheck[]
  warnings: string[]
  recordedTo?: string
}

function text(input: unknown, name: string, max = 20_000): string {
  if (typeof input !== 'string' || input.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  if (input.length > max) throw new Error(`${name} exceeds ${max} characters`)
  return input.trim()
}

function optionalText(input: unknown, name: string, max = 20_000): string | undefined {
  if (input === undefined || input === null || input === '') return undefined
  return text(input, name, max)
}

/**
 * Whether the candidate appears verbatim anywhere under `root`.
 *
 * Files are read as bytes rather than decoded text, because a flag embedded in a
 * binary is the normal case and `readFile(path, 'utf8')` would mangle or reject
 * it. Symlinks are not followed: a loop or a link out of the artifact would turn
 * a bounded check into an unbounded one.
 */
export async function flagAppearsIn(root: string, flag: string): Promise<{ found: boolean; scanned: number; truncated: boolean }> {
  const needle = Buffer.from(flag, 'utf8')
  let scanned = 0
  let bytes = 0
  let truncated = false

  const walk = async (dir: string): Promise<boolean> => {
    if (truncated) return false
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (truncated) return false
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (await walk(full)) return true
        continue
      }
      if (!entry.isFile()) continue
      if (scanned >= MAX_ARTIFACT_FILES || bytes >= MAX_ARTIFACT_BYTES) {
        truncated = true
        return false
      }
      scanned++
      bytes += (await stat(full)).size
      if ((await readFile(full)).includes(needle)) return true
    }
    return false
  }

  if (!existsSync(root)) return { found: false, scanned, truncated: false }
  const info = await stat(root)
  if (info.isFile()) {
    scanned = 1
    return { found: (await readFile(root)).includes(needle), scanned, truncated: false }
  }
  return { found: await walk(root), scanned, truncated }
}

export async function flagVerify(input: {
  flag: string
  challenge?: string
  format?: string
  expectedSha256?: string
  expectedMd5?: string
}): Promise<FlagVerdict> {
  const flag = text(input.flag, 'flag', 1_000)
  const checks: FlagCheck[] = []
  const warnings: string[] = []

  // 1. Printable: a flag with control bytes is a decoding accident, not a flag.
  const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.exec(flag)
  if (control) {
    checks.push({ id: 'printable', status: 'fail', detail: `contains control character 0x${control[0].charCodeAt(0).toString(16).padStart(2, '0')}` })
    return { advisory: true, verdict: 'malformed', confidence: 'high', flag, checks, warnings }
  }
  checks.push({ id: 'printable', status: 'pass', detail: 'no control characters' })

  // 2. Format: a caller-supplied regex, or the permissive default shape.
  let format: RegExp
  try {
    format = input.format ? new RegExp(input.format) : DEFAULT_FLAG_FORMAT
  } catch (error) {
    throw new Error(`format is not a valid regular expression: ${(error as Error).message}`)
  }
  if (format.test(flag)) {
    checks.push({ id: 'format', status: 'pass', detail: input.format ? 'matches the supplied format' : 'matches the default flag shape' })
  } else {
    checks.push({ id: 'format', status: 'fail', detail: input.format ? 'does not match the supplied format' : 'does not match the default flag shape' })
    warnings.push('The candidate does not look like a flag in the challenge\'s own format. Confirm the wrapper and character set before trusting it.')
  }

  // 3. Encoding is informational only. A candidate that decodes cleanly is not
  //    thereby correct, so this can never move the verdict — only describe it.
  //    Hex is tested first: a bare hex string is also valid base64 whenever its
  //    length is a multiple of four, and calling `deadbeefcafe1234` base64 would
  //    be a confident wrong answer.
  if (/^(?:[A-Fa-f0-9]{2})+$/.test(flag)) {
    checks.push({ id: 'encoding', status: 'pass', detail: 'hex-encoded bytes' })
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(flag) && flag.length % 4 === 0) {
    const decoded = Buffer.from(flag, 'base64')
    const printable = decoded.every((byte) => byte >= 0x20 && byte < 0x7f)
    checks.push({ id: 'encoding', status: 'pass', detail: printable ? 'base64 that decodes to printable text' : 'base64 that decodes to non-printable bytes' })
  } else {
    checks.push({ id: 'encoding', status: 'skip', detail: 'not a hex or base64 token' })
  }

  // 4. Artifact presence: did this string actually come out of the challenge?
  //    A candidate the model produced rather than extracted fails here, which is
  //    the single most useful signal against fabrication.
  let found: boolean | undefined
  if (input.challenge) {
    if (!existsSync(input.challenge)) {
      // Not "the flag is not there" — we never looked. Reporting a failure here
      // would turn an unreadable path into a false accusation of fabrication,
      // which is the exact misreading this tool must not cause.
      checks.push({ id: 'artifact-presence', status: 'skip', detail: `challenge path "${input.challenge}" does not exist, so nothing was searched` })
      warnings.push('The challenge path does not exist, so the artifact check did not run. This is not evidence against the candidate.')
    } else {
      const walk = await flagAppearsIn(input.challenge, flag)
      found = walk.found
      if (walk.truncated) {
        checks.push({ id: 'artifact-presence', status: 'skip', detail: `scanned ${walk.scanned} files before hitting the search limit` })
        warnings.push('The artifact walk hit its file or size limit, so absence of the flag is not evidence either way.')
      } else if (walk.found) {
        checks.push({ id: 'artifact-presence', status: 'pass', detail: `the flag appears verbatim in the challenge artifacts (${walk.scanned} file(s) scanned)` })
      } else {
        checks.push({ id: 'artifact-presence', status: 'fail', detail: `the flag does not appear in the challenge artifacts (${walk.scanned} file(s) scanned)` })
        warnings.push('The candidate does not appear anywhere in the supplied artifact. It was most likely invented rather than extracted — re-derive it before reporting.')
      }
    }
  } else {
    checks.push({ id: 'artifact-presence', status: 'skip', detail: 'no challenge path supplied' })
  }

  // 5. Derivation: the only path to `verified`.
  let verified = false
  if (input.expectedSha256) {
    const computed = createHash('sha256').update(flag).digest('hex')
    const expected = input.expectedSha256.toLowerCase().trim()
    if (computed === expected) {
      checks.push({ id: 'sha256', status: 'pass', detail: 'sha256 matches the expected digest' })
      verified = true
    } else {
      checks.push({ id: 'sha256', status: 'fail', detail: `sha256 is ${computed} but ${expected} was expected` })
    }
  }
  if (!verified && input.expectedMd5) {
    const computed = createHash('md5').update(flag).digest('hex')
    const expected = input.expectedMd5.toLowerCase().trim()
    if (computed === expected) {
      checks.push({ id: 'md5', status: 'pass', detail: 'md5 matches the expected digest' })
      verified = true
    } else {
      checks.push({ id: 'md5', status: 'fail', detail: `md5 is ${computed} but ${expected} was expected` })
    }
  }
  if (!input.expectedSha256 && !input.expectedMd5) {
    checks.push({ id: 'derivation', status: 'skip', detail: 'no expected digest supplied, so correctness cannot be proven' })
  }

  if (verified) {
    return { advisory: true, verdict: 'verified', confidence: 'high', flag, checks, warnings }
  }
  if (input.expectedSha256 || input.expectedMd5) {
    return { advisory: true, verdict: 'unverified', confidence: 'high', flag, checks, warnings: [...warnings, 'The candidate was checked against a digest the challenge supplied and did not match.'] }
  }
  if (found === true) {
    return { advisory: true, verdict: 'not-verifiable', confidence: 'medium', flag, checks, warnings }
  }
  if (found === false) {
    return { advisory: true, verdict: 'unverified', confidence: 'low', flag, checks, warnings }
  }
  return { advisory: true, verdict: 'not-verifiable', confidence: 'low', flag, checks, warnings: [...warnings, 'No derivation digest and no artifact were supplied, so nothing here can prove this candidate is the flag.'] }
}

/**
 * Append the verdict to the engagement's recon/ folder as evidence.
 *
 * Recording is optional and best-effort by design. A verdict is still a verdict
 * when there is no engagement folder to write to, and this is an advisory tool:
 * it must never turn "I could not write a log line" into an error that stops a
 * run. So a missing or unscaffolded engagement returns a note rather than
 * throwing, and the caller gets its verdict either way. The flag itself is
 * recorded — it is the evidence — but digests are not echoed, and the entry is
 * appended rather than rewritten so concurrent checks cannot clobber each other.
 */
async function recordVerdict(slug: string, result: FlagVerdict): Promise<string | undefined> {
  const dir = engagementDir(slug)
  if (!existsSync(join(dir, 'SCOPE.md'))) {
    return `Not recorded: engagement "${slug}" is not scaffolded (no SCOPE.md). Run new_engagement first to keep verdicts as evidence.`
  }
  const path = join(dir, 'recon', 'flag-verification.jsonl')
  try {
    await mkdir(join(dir, 'recon'), { recursive: true })
    await captureBeforeWrite(path)
    const entry = JSON.stringify({ recordedAt: new Date().toISOString(), engagement: slug, ...result })
    await appendFile(path, `${entry}\n`, 'utf8')
    return `Recorded to recon/flag-verification.jsonl`
  } catch (error) {
    return `Not recorded: ${(error as Error).message}. The verdict above stands on its own — this tool is advisory and does not fail a run over its own bookkeeping.`
  }
}

export const flagVerifyTool: Tool = {
  name: 'flag_verify',  description:
    "ADVISORY flag check for a candidate string. Returns a verdict of verified / unverified / malformed / not-verifiable with the evidence for each. `verified` is reachable ONLY when sha256 or md5 of the candidate matches an expected digest the challenge itself supplied — format, encoding and artifact-presence checks raise or lower confidence but can never promote a candidate, so a plausible-looking string that was never derived from the challenge comes back not-verifiable or unverified. Pass `challenge` (a file or directory) to test whether the candidate actually appears in the artifacts: a string that does not is the fabrication signal this tool exists to catch. Never blocks or rewrites a report; it is evidence for the caller, who decides.",
  input_schema: {
    type: 'object',
    properties: {
      flag: { type: 'string', description: 'The candidate flag string to check.' },
      challenge: {
        type: 'string',
        description: 'Path to the challenge file or directory to search for the candidate. A candidate absent from it was probably invented.',
      },
      format: {
        type: 'string',
        description: 'Regular expression the flag should match, e.g. "CTF\\{[\\w-]+\\}". Defaults to a permissive shape check.',
      },
      engagement: {
        type: 'string',
        description: 'Engagement slug. When given and scaffolded, the verdict is appended to that engagement recon/flag-verification.jsonl. Optional: with no engagement, or one that is not scaffolded, the verdict is still returned — only the record is skipped.',
      },
      expectedSha256: {
        type: 'string',
        description: 'Expected sha256 of the flag, when the challenge publishes one. This is the only route to verified.',
      },
      expectedMd5: {
        type: 'string',
        description: 'Expected md5 of the flag, when the challenge publishes one. This is the only route to verified.',
      },
    },
    required: ['flag'],
  },
  async execute(input) {
    const flag = text(input.flag, 'flag', 1_000)
    const result = await flagVerify({
      flag,
      challenge: optionalText(input.challenge, 'challenge', 4_000),
      format: optionalText(input.format, 'format', 2_000),
      expectedSha256: optionalText(input.expectedSha256, 'expectedSha256', 200),
      expectedMd5: optionalText(input.expectedMd5, 'expectedMd5', 200),
    })
    const engagement = optionalText(input.engagement, 'engagement', 200)
    if (engagement) {
      const note = await recordVerdict(engagement, result)
      result.warnings = note ? [...result.warnings, note] : result.warnings
      if (note?.startsWith('Recorded')) result.recordedTo = `engagements/${engagement}/recon/flag-verification.jsonl`
    }
    return JSON.stringify(result, null, 2)
  },
}
