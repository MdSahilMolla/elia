/**
 * nuclei `-jsonl` — one JSON object per line.
 *
 * A scan that is interrupted mid-run leaves a half-written final line, and a
 * log passed through a shell pipeline can lose a few more. Those lines are
 * skipped and the good ones are still returned: losing one template match to a
 * truncated log is exactly the false negative this parser exists to prevent.
 */

export interface NucleiFinding {
  templateId: string
  name: string
  /** nuclei's own severity string, lowercased and passed through unchanged — never re-derived. */
  severity: string
  host: string
  matchedAt: string
  matcherName: string
  type: string
  extracted: string[]
  /** The line as nuclei wrote it, so a caller can reach a field this shape does not name. */
  raw: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

/** nuclei has spelled this key `template-id` and `templateID` across releases. */
function templateIdOf(record: Record<string, unknown>): string {
  return str(record['template-id']) || str(record.templateId) || str(record.templateID)
}

function toFinding(record: Record<string, unknown>): NucleiFinding {
  const info = asRecord(record.info) ?? {}
  const extracted = Array.isArray(record['extracted-results'])
    ? record['extracted-results'].filter((entry): entry is string => typeof entry === 'string')
    : []
  // `matched` is the newer spelling of `matched-at`; both name the URL or
  // request that fired the template.
  const matchedAt = str(record['matched-at']) || str(record.matched)
  return {
    templateId: templateIdOf(record),
    name: str(info.name) || templateIdOf(record),
    severity: str(info.severity).toLowerCase(),
    host: str(record.host) || matchedAt,
    matchedAt,
    matcherName: str(record['matcher-name']) || str(record.matcher),
    type: str(record.type),
    extracted,
    raw: record,
  }
}

/**
 * Every finding in a nuclei JSONL log. A line that is not a JSON object with a
 * template id — the `$ nuclei …` header, the scope note, a progress line, a
 * truncated final line — is skipped, so an unrecognised file parses to `[]`
 * rather than throwing.
 */
export function parseNucleiJsonl(text: string): NucleiFinding[] {
  const findings: NucleiFinding[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = asRecord(parsed)
    if (!record || !templateIdOf(record)) continue
    findings.push(toFinding(record))
  }
  return findings
}
