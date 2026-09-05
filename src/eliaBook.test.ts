import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscript } from './ui/transcript.ts'
import { loadSession, saveSession } from './session.ts'
import {
  createEliaBookFromRun,
  createEliaBookFromSession,
  ELIA_BOOK_MENU_OPTIONS,
  eliaBookMenu,
  eliaBookExecutionPrompt,
  handleEliaBookCommand,
  improveEliaBook,
  listEliaBooks,
  readEliaBook,
  rollbackEliaBook,
} from './eliaBook.ts'

const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-book-'))
  roots.push(dir)
  return dir
}

function writeRun(
  cwd: string,
  id: string,
  options: { verified?: boolean; elapsedMs?: number; tokens?: number; actions?: number; failed?: number; blocked?: number; goal?: string } = {},
): void {
  const dir = join(cwd, '.elia', 'runs', id)
  mkdirSync(join(dir, 'checkpoints'), { recursive: true })
  const goal = options.goal ?? 'Repair the parser and verify the result'
  const proposal = {
    goal,
    understanding: 'The parser fails on empty input.',
    assumptions: ['The existing test describes the intended behavior.'],
    steps: [{ id: 'fix', title: 'Repair parser', role: 'builder', instructions: 'Read the parser, make the smallest fix, and preserve public behavior.', files: ['src/parser.ts'], dependsOn: [] }],
    risks: ['Changing valid-input behavior.'],
    verification: ['bun test src/parser.test.ts'],
    outOfScope: ['Parser redesign.'],
    acceptanceCriteria: ['The regression test passes.'],
    sideEffects: [],
    recovery: ['Restore the checkpoint if verification regresses.'],
  }
  const verified = options.verified ?? true
  const outcome = verified ? 'completed' : 'needs-attention'
  writeFileSync(join(dir, 'events.ndjson'), [
    JSON.stringify({ seq: 0, at: 1, kind: 'run-start', data: { runId: id, goal, cwd } }),
    JSON.stringify({ seq: 1, at: 2, kind: 'proposal', data: { proposal } }),
    JSON.stringify({ seq: 2, at: 3, kind: 'verify', data: { passed: verified, command: proposal.verification[0] } }),
    JSON.stringify({ seq: 3, at: 4, kind: 'run-end', data: { outcome } }),
  ].join('\n') + '\n')
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({
    runId: id,
    goal,
    outcome,
    elapsedMs: options.elapsedMs ?? 1_000,
    usage: { inputTokens: options.tokens ?? 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    actions: { total: options.actions ?? 10, failed: options.failed ?? 0, blocked: options.blocked ?? 0 },
    verification: [{ passed: verified, command: proposal.verification[0] }],
    completion: { state: verified ? 'verified' : 'partial', summary: verified ? 'The parser fix is verified.' : 'Verification did not pass.', blockers: verified ? [] : ['The regression test failed.'] },
    lessons: ['Read the focused test before editing.'],
  }))
  writeFileSync(join(dir, 'actions.ndjson'), '')
  writeFileSync(join(dir, 'receipt.md'), '# receipt\n')
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Elia Book', () => {
  test('menu saves and browses resumed history even when model context no longer contains earlier turns', async () => {
    const cwd = root()
    const transcript = createTranscript()
    const longOutput = 'result line\n'.repeat(1_000) + 'FINAL EVIDENCE'
    transcript.appendUser('Repair parser')
    transcript.recordTool({ name: 'run_command', input: { command: 'bun test', password: 'private-value', script: 'line\n'.repeat(100) }, result: longOutput, isError: false, cached: false, durationMs: 1 }, 'tester#1')
    transcript.notice('Created artifact: .elia/artifacts/report.md')
    transcript.appendAssistant('Verified the parser.')
    transcript.endTurn()
    const dir = join(cwd, '.elia', 'sessions')
    await saveSession('resume-123', [], dir, { recording: transcript.snapshot() })
    const loaded = await loadSession('resume-123', dir)
    const resumed = createTranscript()
    resumed.restore(loaded!.recording!)
    resumed.appendUser('Preserve the public API')
    resumed.endTurn()
    const snapshot = {
      sessionId: 'resume-123', messages: [], recording: resumed.snapshot(), transcriptMarkdown: '', checkpoints: [],
      usage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 6, cacheWriteTokens: 0, turns: 2, elapsedMs: 100 },
      providerLabel: 'Test', model: 'test', mode: 'dev',
    }
    const menu = eliaBookMenu('', () => snapshot, cwd)
    expect(await menu.picker!.onSelect(null)).toBeUndefined()
    expect(listEliaBooks(cwd)).toHaveLength(0)
    const result = await menu.picker!.onSelect('save')
    expect(result).toMatchObject({ handled: true, text: expect.stringContaining('Saved this session') })
    const book = listEliaBooks(cwd)[0]!
    expect(book.versions[0]!.procedure.steps.map((step) => step.instructions)).toEqual(['Repair parser', 'Preserve the public API'])
    expect(book.versions[0]!.evidence.actionCount).toBe(1)
    const recordingDir = join(cwd, '.elia', 'books', book.id, 'v1')
    const recording = readFileSync(join(recordingDir, 'transcript.json'), 'utf8')
    expect(recording).toContain('tester#1')
    expect(recording).toContain('FINAL EVIDENCE')
    expect(recording).not.toContain('private-value')
    const markdown = readFileSync(join(recordingDir, 'transcript.md'), 'utf8')
    expect(markdown).toContain(longOutput)
    expect(markdown).toContain('.elia/artifacts/report.md')
    expect(JSON.parse(readFileSync(join(recordingDir, 'manifest.json'), 'utf8')).usage.inputTokens).toBe(123)
    const saved = await menu.picker!.onSelect('saved')
    if (!saved || typeof saved === 'string' || !saved.picker) throw new Error('Expected Saved Elia Books picker')
    expect(saved.picker.options[0]!.value).toBe(book.id)
    expect(await saved.picker.onSelect(book.id)).toMatchObject({ text: expect.stringContaining('Preserve the public API') })
    expect(() => createEliaBookFromSession(snapshot, book.id, cwd)).toThrow('already exists')
    expect(listEliaBooks(cwd)).toHaveLength(1)
  })

  test('creates a redacted, reusable Book that points to the complete run recording', () => {
    const cwd = root()
    writeRun(cwd, 'run-base', { goal: 'Repair parser with token sk-1234567890abcdefghijklmnop' }) // pragma: allowlist secret

    const book = createEliaBookFromRun('run-base', 'parser-repair', cwd)

    expect(book.status).toBe('verified')
    expect(book.title).toContain('[REDACTED]')
    expect(book.title).not.toContain('sk-1234567890')
    expect(book.versions[0]?.procedure.steps[0]?.instructions).toContain('smallest fix')
    expect(book.versions[0]?.evidence.recordingFiles).toContain('.elia/runs/run-base/events.ndjson')
    expect(readEliaBook('parser-repair', cwd)?.id).toBe('parser-repair')
    expect(listEliaBooks(cwd).map((item) => item.id)).toEqual(['parser-repair'])
    expect(Bun.file(join(cwd, '.elia', 'books', 'parser-repair.md')).size).toBeGreaterThan(0)
  })

  test('saves the complete current session and exposes the two-option Elia Book menu', () => {
    const cwd = root()
    const snapshot = {
      sessionId: 'session-123',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'Fix parser with token sk-1234567890abcdefghijklmnop' }] }, // pragma: allowlist secret
        { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'tool-1', name: 'run_command', input: { command: 'bun test src/parser.test.ts', apiKey: 'plain-secret' } }] },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'tool-1', content: '1 pass', is_error: false }] },
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Parser fixed and verified.' }] },
      ],
      transcriptMarkdown: '# session\n\nFix parser with token sk-1234567890abcdefghijklmnop', // pragma: allowlist secret
      checkpoints: [{ turn: 0, at: 1, label: 'Fix parser', files: ['src/parser.ts'] }],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, turns: 1, elapsedMs: 500 },
      providerLabel: 'Test provider',
      model: 'test-model',
      mode: 'dev',
    }

    const book = createEliaBookFromSession(snapshot, 'session-parser', cwd)

    expect(ELIA_BOOK_MENU_OPTIONS.map((option) => option.label)).toEqual(['Save this session', 'Saved Elia Books'])
    expect(book.status).toBe('recorded')
    expect(book.versions[0]?.evidence.sourceSessionId).toBe('session-123')
    expect(book.versions[0]?.procedure.verification).toEqual(['bun test src/parser.test.ts'])
    expect(book.versions[0]?.procedure.steps[0]?.files).toEqual(['src/parser.ts'])
    expect(book.versions[0]?.evidence.recordingFiles).toHaveLength(3)
    const recording = readFileSync(join(cwd, '.elia', 'books', 'session-parser', 'v1', 'session.json'), 'utf8')
    expect(recording).toContain('[REDACTED]')
    expect(recording).not.toContain('sk-1234567890')
    expect(recording).not.toContain('plain-secret')
    expect(handleEliaBookCommand('saved', cwd).text).toContain('session-parser')
  })

  test('/eliabook save uses the active session snapshot', () => {
    const cwd = root()
    const snapshot = {
      sessionId: 'session-456',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Document the release workflow' }] }],
      transcriptMarkdown: '# release session',
      checkpoints: [],
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, elapsedMs: 25 },
      providerLabel: 'Test provider',
      model: 'test-model',
      mode: 'dev',
    }

    const result = handleEliaBookCommand('save release-workflow', cwd, snapshot)

    expect(result.text).toContain('Saved this session as Elia Book "release-workflow"')
    expect(readEliaBook('release-workflow', cwd)?.status).toBe('recorded')
  })

  test('runs a Book as current guidance without weakening approvals or verification', () => {
    const cwd = root()
    writeRun(cwd, 'run-base')
    const book = createEliaBookFromRun('run-base', 'parser-repair', cwd)

    const prompt = eliaBookExecutionPrompt(book, 'Also preserve error messages')

    expect(prompt).toContain('<elia-book id="parser-repair" version="1">')
    expect(prompt).toContain('bun test src/parser.test.ts')
    expect(prompt).toContain('Also preserve error messages')
    expect(prompt).toContain('not as permission to bypass')
    const command = handleEliaBookCommand('run parser-repair Also preserve error messages', cwd)
    expect(command.submitText).toBe(prompt)
  })

  test('promotes only a verified, non-regressing, measurably better run and can roll back', () => {
    const cwd = root()
    writeRun(cwd, 'run-base', { elapsedMs: 1_000, tokens: 1_000, actions: 10 })
    writeRun(cwd, 'run-better', { elapsedMs: 800, tokens: 900, actions: 8 })
    createEliaBookFromRun('run-base', 'parser-repair', cwd)

    const improved = improveEliaBook('parser-repair', 'run-better', cwd)

    expect(improved.activeVersion).toBe(2)
    expect(improved.versions[1]?.improvement).toContain('actions 10 → 8')
    const rolledBack = rollbackEliaBook('parser-repair', cwd)
    expect(rolledBack.activeVersion).toBe(1)
  })

  test('rejects unverified or non-improving recursive updates', () => {
    const cwd = root()
    writeRun(cwd, 'run-base', { elapsedMs: 1_000, tokens: 1_000, actions: 10 })
    writeRun(cwd, 'run-failed', { verified: false, elapsedMs: 500, tokens: 500, actions: 5 })
    writeRun(cwd, 'run-same', { elapsedMs: 1_000, tokens: 1_000, actions: 10 })
    createEliaBookFromRun('run-base', 'parser-repair', cwd)

    expect(() => improveEliaBook('parser-repair', 'run-failed', cwd)).toThrow('not evidence-backed verified completion')
    expect(() => improveEliaBook('parser-repair', 'run-same', cwd)).toThrow('not measurably better')
    expect(readEliaBook('parser-repair', cwd)?.activeVersion).toBe(1)
  })

  test('rejects traversal-shaped ids and explains the slash command surface', () => {
    const cwd = root()
    expect(() => readEliaBook('../outside', cwd)).toThrow('Elia Book id')
    expect(handleEliaBookCommand('', cwd).text).toContain('/eliabook save')
    expect(handleEliaBookCommand('create', cwd).text).toContain('Usage: /eliabook create')
  })
})
