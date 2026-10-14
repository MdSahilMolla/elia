/**
 * Opening a CyberBrain reference: the human-readable side of retrieval.
 *
 * Search returns chunks, but a caller that wants the whole finding — the
 * ordered steps, the remediation with its verification check, the failure
 * modes — needs the record rendered as something readable in a terminal. This
 * module is that render step, plus the `record:` / `chunk:` reference syntax
 * the tools use so a hit can be opened without another round trip to the
 * store. Truncation is by characters with an explicit marker: tool output must
 * never silently swallow the tail of a writeup.
 */

import type { CyberCorpus, CyberRecord } from './types.ts'

const DEFAULT_MAX_CHARS = 12_000
const TRUNCATION_MARKER = '\n\n… truncated'

function pushList(lines: string[], heading: string, items: string[] | undefined): void {
  if (!items || items.length === 0) return
  lines.push('', `## ${heading}`)
  for (const item of items) lines.push(`- ${item}`)
}

export function renderRecord(record: CyberRecord, maxChars: number = DEFAULT_MAX_CHARS): string {
  const lines: string[] = [`# ${record.title}`, '', `- id: ${record.id}`, `- category: ${record.category}`, `- vulnerability: ${record.vulnerability} (${record.cwe})`]
  if (record.platform) lines.push(`- platform: ${record.platform}`)
  if (record.difficulty) lines.push(`- difficulty: ${record.difficulty}`)

  pushList(lines, 'Detection signals', record.detect)
  pushList(lines, 'Prerequisites', record.prerequisites)

  if (record.steps.length > 0) {
    lines.push('', '## Steps')
    record.steps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step.goal} — ${step.action}${step.dead_end ? ' (dead end)' : ''}`)
      if (step.command) lines.push(`   - command: \`${step.command}\``)
      if (step.expected_output) lines.push(`   - expected: ${step.expected_output}`)
    })
  }

  pushList(lines, 'Payloads', record.payloads)
  pushList(lines, 'Commands', record.commands)

  if (record.root_cause) pushList(lines, 'Root cause', [record.root_cause])
  if (record.impact) pushList(lines, 'Impact', [record.impact])
  if (record.mitigation) pushList(lines, 'Mitigation', [record.mitigation])

  if (record.remediation.length > 0) {
    lines.push('', '## Remediation')
    for (const item of record.remediation) {
      const meta = [item.type, item.layer, item.effort ? `effort ${item.effort}` : ''].filter(Boolean).join(' · ')
      lines.push(`- ${item.finding_class}: ${item.control}${meta ? ` (${meta})` : ''}`)
      if (item.verification) lines.push(`  - verification: ${item.verification}`)
    }
  }

  if (record.failure_modes.length > 0) {
    lines.push('', '## Failure modes')
    for (const mode of record.failure_modes) lines.push(`- ${mode.attempt}: ${mode.why_it_fails}`)
  }

  const sourceMeta = [record.source.platform, record.source.event, record.source.year, record.source.author].filter((part) => part !== undefined && part !== '').join(' · ')
  lines.push('', '## Source', `- ${record.source.url}${sourceMeta ? ` — ${sourceMeta}` : ''}`)

  const rendered = lines.join('\n')
  if (rendered.length <= maxChars) return rendered
  return rendered.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
}

function notFound(ref: string): string {
  return `CyberBrain: no record found for "${ref}" — expected "record:<id>", "<id>", or "chunk:<chunk_id>".`
}

export function openCyberReference(corpus: CyberCorpus, ref: string): string {
  const trimmed = ref.trim()

  if (trimmed.startsWith('chunk:')) {
    const chunkId = trimmed.slice('chunk:'.length)
    const chunk = corpus.chunks.find((candidate) => candidate.chunk_id === chunkId)
    if (!chunk) return notFound(ref)
    const record = corpus.recordById.get(chunk.record_id)
    if (!record) return notFound(ref)
    return renderRecord(record)
  }

  const recordId = trimmed.startsWith('record:') ? trimmed.slice('record:'.length) : trimmed
  const record = corpus.recordById.get(recordId)
  if (!record) return notFound(ref)
  return renderRecord(record)
}
