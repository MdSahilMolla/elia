import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import {
  PLAYBOOKS,
  PLAYBOOK_CATEGORIES,
  detectCategories,
  isPlaybookCategory,
  playbookFor,
  type Playbook,
  type PlaybookCategory,
} from '../security/playbooks/index.ts'

/**
 * Read-only: renders procedural text. It starts no process, touches no file, and
 * has no side effect of any kind, so it is safe to call on the default path
 * before a challenge has been looked at.
 *
 * The render has three shapes, and the default is deliberately the short one —
 * the whole reason these playbooks are data behind a tool rather than prompt
 * text is that all five full playbooks do not fit in a context budget. So the
 * index carries one summary and one detect line per category, and the model
 * pulls the full procedure for exactly one.
 */

const CATEGORY_LIST = PLAYBOOK_CATEGORIES.join(', ')

/**
 * Hints arrive as an array from a schema-typed model, but a comma-joined string
 * and a bare number both happen in practice. All three are accepted; an object
 * or a nested array is a real mistake and is rejected, because silently
 * `String()`-ing an object would produce a hint that matches nothing and a
 * confidently wrong "no signal" answer.
 */
function hintsFrom(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const raw: unknown[] = Array.isArray(value) ? value : [value]
  const hints: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed.length > 0) hints.push(trimmed)
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      hints.push(String(item))
    } else if (typeof item !== 'string') {
      throw new Error('hints must be an array of strings (or a single string) — a hint must be a filename or keyword')
    }
  }
  return hints.length > 0 ? hints : undefined
}

function fence(commands: string[]): string[] {
  return ['```sh', ...commands, '```']
}

function renderDetect(playbook: Playbook): string[] {
  return ['## When this is the right category', ...playbook.detect.map((line) => `- ${line}`)]
}

function renderSteps(playbook: Playbook): string[] {
  const lines: string[] = ['## Triage sequence']
  playbook.steps.forEach((step, index) => {
    lines.push('')
    lines.push(`### ${index + 1}. ${step.title}`)
    if (step.note) lines.push('', step.note)
    if (step.commands && step.commands.length > 0) lines.push('', ...fence(step.commands))
    if (step.signals && step.signals.length > 0) {
      lines.push('', 'Look for:')
      for (const signal of step.signals) lines.push(`- ${signal}`)
    }
  })
  return lines
}

export function renderPlaybook(playbook: Playbook): string {
  const lines: string[] = [
    `# CTF playbook: ${playbook.category}`,
    '',
    playbook.summary,
    '',
    ...renderDetect(playbook),
    '',
    ...renderSteps(playbook),
    '',
    '## Gotchas',
    ...playbook.gotchas.map((line) => `- ${line}`),
    '',
    '## What solved looks like',
    playbook.successShape,
    '',
    '---',
    'Commands above are POSIX-shell shaped. Before relying on a binary that may not exist,',
    'call `ctf_toolchain` with this category: it reports what is actually installed and the',
    'one-line cost of each gap, without installing anything.',
  ]
  return lines.join('\n')
}

export function renderIndex(): string {
  const lines: string[] = [
    '# CTF playbooks — index',
    '',
    'Five categories. Each has one ordered procedure: triage, then working commands, then the',
    'gotchas that cost people their time. Call again with `category` for the full playbook — the',
    'commands and the gotchas are not in this index.',
    '',
    'Call with `hints` (artifact filenames or keywords) to have a category suggested for you.',
    '',
  ]
  for (const category of PLAYBOOK_CATEGORIES) {
    const playbook = PLAYBOOKS[category]
    const detect = playbook.detect[0] ?? ''
    const more = playbook.detect.length > 1 ? ` (+${playbook.detect.length - 1} more detection signals)` : ''
    lines.push(`## ${category}`)
    lines.push(playbook.summary)
    lines.push(`- detect: ${detect}${more}`)
    lines.push(`- ${playbook.steps.length} steps, ${playbook.gotchas.length} gotchas`)
    lines.push('')
  }
  lines.push('---')
  lines.push('"misc" is the residual category: a real share of it is one of the other four mislabelled.')
  lines.push('Re-run with the concrete artifact names you have once you have `file` output.')
  return lines.join('\n')
}

export function renderSuggestions(categories: PlaybookCategory[], hints: string[]): string {
  const lines: string[] = [
    `# CTF playbooks — suggested from hints: ${categories.join(', ')}`,
    '',
    `Matched against: ${hints.join(', ')}`,
    '',
    'Suggested from the hints above. This is a heuristic, not a finding — confirm with `file`',
    'before committing to a procedure, and fall back to the index if it disagrees with the bytes.',
    '',
  ]
  for (const category of categories) {
    const playbook = playbookFor(category)
    if (!playbook) continue
    lines.push(...fence([`ctf_playbook { "category": "${category}" }`]))
    lines.push('')
  }
  for (const category of categories) {
    const playbook = playbookFor(category)
    if (!playbook) continue
    lines.push('---')
    lines.push('')
    lines.push(...renderPlaybook(playbook).split('\n'))
    lines.push('')
  }
  return lines.join('\n')
}

function renderNoMatch(hints: string[]): string {
  return [
    '# CTF playbooks — no category matched those hints',
    '',
    `Checked: ${hints.join(', ')}`,
    '',
    'Nothing matched, so nothing is guessed: a wrong category sends you down an entire wrong',
    'procedure, which is worse than choosing with the whole index in front of you.',
    '',
    'Two things that usually fix this:',
    '- Pass more hints — real filenames with extensions (`chall.elf`, `app.apk`, `flag.enc`, `photo.png`,',
    '  `capture.pcap`) or keywords from the brief (`ret2win`, `jadx`, `RSA`, `LSB`, `tshark`).',
    '- `file` the artifacts first and pass the real types instead of the given names.',
    '',
    renderIndex(),
  ].join('\n')
}

export async function reportPlaybook(input: Record<string, unknown>): Promise<string> {
  const requested = optionalString(input.category, 'category')
  if (requested !== undefined && !isPlaybookCategory(requested)) {
    throw new Error(`category must be one of: ${CATEGORY_LIST} — got "${requested}"`)
  }
  const hints = hintsFrom(input.hints)
  if (requested !== undefined) {
    const playbook = playbookFor(requested)
    // Unreachable through `isPlaybookCategory`; kept so a registry entry that
    // is somehow missing fails loudly rather than rendering an empty page.
    if (!playbook) throw new Error(`no playbook is registered for category "${requested}"`)
    return renderPlaybook(playbook)
  }
  if (hints !== undefined) {
    const categories = detectCategories(hints)
    if (categories.length === 0) return renderNoMatch(hints)
    return renderSuggestions(categories, hints)
  }
  return renderIndex()
}

export const ctfPlaybookTool: Tool = {
  name: 'ctf_playbook',
  description:
    'Return the ordered triage procedure for one CTF category — how to recognise it, the step sequence with concrete runnable commands, the failure modes, and what a solved challenge looks like. Call it with no arguments for a short index of all five categories, with `category` for one full procedure, or with `hints` (artifact filenames or keywords) to have a category suggested. Use it before improvising a workflow for a binary exploitation, reverse-engineering, crypto, steganography or forensics problem: it exists so you follow a known-good sequence instead of guessing, and so you pick a technique the machine can actually run (cross-check with ctf_toolchain). READ-ONLY: it starts no process and reads no file.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['pwn', 'rev', 'crypto', 'stego', 'web', 'misc'], description: 'Which category (default: all summaries)' },
      hints: { type: 'array', description: 'Optional artifact filenames or keywords to suggest likely categories', items: { type: 'string' } },
    },
  },
  async execute(input) {
    return reportPlaybook(input)
  },
}
