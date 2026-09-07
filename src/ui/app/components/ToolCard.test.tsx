import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { ToolItem } from '../store.ts'
import { ToolCard } from './ToolCard.tsx'

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

test('run_command shows the $ echo, output tail and exit code without expansion', () => {
  const tool: ToolItem = {
    id: 'cmd-1',
    kind: 'tool',
    name: 'run_command',
    input: { command: 'bun test' },
    status: 'ok',
    result: 'exit code: 0\nstdout:\n10 pass\n0 fail',
  }
  const frame = render(<ToolCard tool={tool} expanded={false} />).lastFrame() ?? ''
  expect(frame).toContain('$ bun test')
  expect(frame).toContain('10 pass')
  expect(frame).toContain('exit 0')
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
  expect(frame).toContain('✗')
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

test('edit_file diff renders a line-number gutter', () => {
  const tool: ToolItem = {
    id: 'edit-1',
    kind: 'tool',
    name: 'edit_file',
    input: { path: 'src/x.ts' },
    status: 'ok',
    result: 'Edited x.ts (+1 −1)\n```diff\n@@ -10,3 +10,3 @@\n context\n-old line\n+new line\n```',
  }
  const frame = render(<ToolCard tool={tool} expanded />).lastFrame() ?? ''
  expect(frame).toContain('new line')
  expect(frame).toContain('11') // the changed line's number in the gutter
})
