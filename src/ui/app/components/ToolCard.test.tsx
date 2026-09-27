import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { ToolItem } from '../store.ts'
import { ExploreCard, ToolCard } from './ToolCard.tsx'

test('shows a completed visualization preview without requiring expansion', () => {
  const tool: ToolItem = {
    id: 'visual-1',
    kind: 'tool',
    name: 'visualize',
    input: { type: 'bar', title: 'Revenue' },
    status: 'ok',
    result: 'Created bar visualization "Revenue".\nSVG: .elia/artifacts/revenue.svg\nMarkdown: .elia/artifacts/revenue.md\n\nRevenue\nNorth  █████ 10',
  }
  const { lastFrame } = render(<ToolCard tool={tool} expanded={false} />)
  const frame = lastFrame() ?? ''
  expect(frame).toContain('Visualized Revenue')
  expect(frame).toContain('North  █████ 10')
  expect(frame).not.toContain('SVG:')
})

test('run_command shows the command and its output tail without expansion — no noise on success', () => {
  const tool: ToolItem = {
    id: 'cmd-1',
    kind: 'tool',
    name: 'run_command',
    input: { command: 'bun test' },
    status: 'ok',
    result: 'exit code: 0\nstdout:\n10 pass\n0 fail\n\n',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Ran bun test')
  expect(frame).toContain('⎿ 10 pass')
  expect(frame).toContain('0 fail')
  // A clean exit is the expected case: no "exit 0", no ✓, no trailing blank rows.
  expect(frame).not.toContain('exit 0')
  expect(frame).not.toContain('✓')
  expect(frame.trimEnd().endsWith('0 fail')).toBe(true)
})

test('a non-zero exit is flagged even when the tool call itself did not error', () => {
  const tool: ToolItem = {
    id: 'cmd-2',
    kind: 'tool',
    name: 'run_command',
    input: { command: 'npm run build' },
    status: 'ok',
    result: 'exit code: 1\nstderr:\nBuild failed',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('exit 1')
  expect(frame).toContain('Build failed')
})

test('the header carries no cache mark, check mark or expand chevron', () => {
  const tool: ToolItem = { id: 'r0', kind: 'tool', name: 'read_file', input: { path: 'src/app.ts' }, status: 'cached', result: '1\tx\n2\ty' }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('● Read app.ts')
  for (const noise of ['⚡', '✓', '›', '⏺']) expect(frame).not.toContain(noise)
})

test('a run of lookups renders as one summary row with the targets underneath', () => {
  const tools: ToolItem[] = [
    { id: 'a', kind: 'tool', name: 'read_file', input: { path: 'src/app.ts' }, status: 'ok', result: '1\tx' },
    { id: 'b', kind: 'tool', name: 'read_file', input: { path: 'package.json' }, status: 'ok', result: '1\t{}' },
    { id: 'c', kind: 'tool', name: 'grep', input: { pattern: 'hello' }, status: 'ok', result: 'a.ts:1:hello' },
  ]
  const frame = render(<ExploreCard tools={tools} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Read 2 files, searched 1 pattern')
  expect(frame).toContain('⎿ app.ts, package.json, hello')
  // One header, not three cards.
  expect(frame.split('●').length - 1).toBe(1)
})

test('a failed lookup inside a group is still spelled out', () => {
  const tools: ToolItem[] = [
    { id: 'a', kind: 'tool', name: 'read_file', input: { path: 'src/app.ts' }, status: 'ok', result: '1\tx' },
    { id: 'b', kind: 'tool', name: 'read_file', input: { path: 'missing.ts' }, status: 'error', result: 'ENOENT: no such file' },
  ]
  const frame = render(<ExploreCard tools={tools} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Read missing.ts — ENOENT: no such file')
})

test('a successful plan update draws nothing — the plan panel owns it', () => {
  const tool: ToolItem = { id: 'p', kind: 'tool', name: 'todo_write', input: {}, status: 'ok', result: 'ok' }
  expect((render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? '').trim()).toBe('')
})

test('a read shows a ⎿ result summary without expansion', () => {
  const tool: ToolItem = {
    id: 'r1',
    kind: 'tool',
    name: 'grep',
    input: { pattern: 'approve' },
    status: 'ok',
    result: 'src/x.ts:12:approve\nsrc/x.ts:40:approve\nsrc/y.ts:3:approve',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('⎿')
  expect(frame).toContain('3 matches in 2 files')
})

test('edit_file diff renders a line-number gutter without expansion', () => {
  const tool: ToolItem = {
    id: 'edit-1',
    kind: 'tool',
    name: 'edit_file',
    input: { path: 'src/x.ts' },
    status: 'ok',
    result: 'Edited x.ts (+1 −1)\n```diff\n@@ -10,3 +10,3 @@\n context\n-old line\n+new line\n```',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Edited src/x.ts')
  expect(frame).toContain('- old line')
  expect(frame).toContain('+ new line')
  expect(frame).toContain('11') // the changed line's number in the gutter
  // The gutter already carries the line numbers — the hunk header is noise.
  expect(frame).not.toContain('@@')
})

test('a long edit_file diff collapses to a ctrl+o footer until expanded', () => {
  const body = Array.from({ length: 40 }, (_, i) => `+added line ${i}`).join('\n')
  const tool: ToolItem = {
    id: 'edit-2',
    kind: 'tool',
    name: 'edit_file',
    input: { path: 'src/big.ts' },
    status: 'ok',
    result: `Edited big.ts (+40 −0)\n\`\`\`diff\n@@ -1,0 +1,40 @@\n${body}\n\`\`\``,
  }
  const collapsed = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(collapsed).toContain('ctrl+o to expand')
  expect(collapsed).not.toContain('added line 39')
  const expanded = render(<ToolCard tool={tool} expanded />).lastFrame() ?? ''
  expect(expanded).toContain('added line 39')
})

test('a running browser call names the action and animates a track under it', () => {
  const tool: ToolItem = {
    id: 'browser-1',
    kind: 'tool',
    name: 'browser',
    input: { action: 'navigate', url: 'https://example.com/pricing?tier=pro' },
    status: 'running',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  // Present tense while it runs, and the scheme stripped — the host and path are
  // what a transcript row is for.
  expect(frame).toContain('Navigating to example.com/pricing?tier=pro')
  expect(frame).not.toContain('https://')
  // The track is drawn, and it is the browser's own motion rather than the
  // generic braille spinner.
  expect(frame).toContain('▸')
  expect(frame).toContain('loading')
})

test('a running click reads as interaction, not as loading', () => {
  const tool: ToolItem = {
    id: 'browser-2',
    kind: 'tool',
    name: 'browser',
    input: { action: 'click', target: 'Publish' },
    status: 'running',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Clicking Publish')
  expect(frame).toContain('interacting')
})

test('typing shows the field and never the text that was typed into it', () => {
  const tool: ToolItem = {
    id: 'browser-3',
    kind: 'tool',
    name: 'browser',
    input: { action: 'type', target: 'css:#password', text: 'hunter2-not-in-the-transcript' },
    status: 'running',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Typing into css:#password')
  expect(frame).not.toContain('hunter2')
})

test('a finished browser call summarises where it landed instead of showing a bare brace', () => {
  const tool: ToolItem = {
    id: 'browser-4',
    kind: 'tool',
    name: 'browser',
    input: { action: 'navigate', url: 'https://example.com/pricing' },
    status: 'ok',
    result: `{
  "url": "https://example.com/pricing",
  "title": "Pricing — Example"
}
Task session: mu4eebx5-43v5kz`,
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Opened example.com/pricing')
  expect(frame).toContain('Pricing — Example')
  // The task-session handle belongs to the dashboard, not to this row, and the
  // old fallback printed the opening brace of the JSON and nothing else.
  expect(frame).not.toContain('Task session')
  expect(frame.trimEnd().endsWith('{')).toBe(false)
})

test('a finished call shows no track — the animation costs nothing once it is done', () => {
  const tool: ToolItem = {
    id: 'browser-5',
    kind: 'tool',
    name: 'browser',
    input: { action: 'click', target: 'Publish' },
    status: 'ok',
    result: '{\n  "clicked": "Publish"\n}',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('Clicked Publish')
  expect(frame).not.toContain('interacting')
  expect(frame).not.toContain('◌')
})

test('a tool without its own summary shows the gist of a JSON result, never the raw payload', () => {
  const tool: ToolItem = {
    id: 'mcp-1',
    kind: 'tool',
    name: 'mcp__linear__list_issues',
    input: {},
    status: 'ok',
    result: '{"issues":[{"id":1,"title":"a"},{"id":2,"title":"b"},{"id":3,"title":"c"}],"cursor":"abc"}',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('⎿ 3 issues')
  expect(frame).not.toContain('{"issues"')
  const status: ToolItem = { ...tool, id: 'mcp-2', result: '{"status":"ok","message":"Deployed to staging"}' }
  expect(render(<ToolCard tool={status} expanded={false} />).lastFrame() ?? '').toContain('⎿ Deployed to staging — ok')
})

test('an expanded error keeps its line breaks under one ⎿', () => {
  const tool: ToolItem = {
    id: 'err-1',
    kind: 'tool',
    name: 'read_file',
    input: { path: 'a.ts' },
    status: 'error',
    result: 'TypeError: boom\n    at run (a.ts:3:5)\n    at main (a.ts:9:1)',
  }
  const collapsed = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(collapsed).toContain('TypeError: boom at run')
  const expanded = (render(<ToolCard tool={tool} expanded />).lastFrame() ?? '').split('\n')
  expect(expanded.some((line) => line.includes('⎿ TypeError: boom'))).toBe(true)
  expect(expanded.some((line) => /^\s+at run \(a\.ts:3:5\)/.test(line))).toBe(true)
  expect(expanded.filter((line) => line.includes('⎿'))).toHaveLength(1)
})

test('a folded shell tail still leads with ⎿', () => {
  const tool: ToolItem = {
    id: 'cmd-9',
    kind: 'tool',
    name: 'run_command',
    input: { command: 'bun test' },
    status: 'ok',
    result: `exit code: 0\nstdout:\n${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')}`,
  }
  const lines = (render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? '').split('\n')
  const note = lines.findIndex((line) => line.includes('earlier lines'))
  expect(lines[note]).toContain('⎿ … +7 earlier lines')
  expect(lines.filter((line) => line.includes('⎿'))).toHaveLength(1)
})
