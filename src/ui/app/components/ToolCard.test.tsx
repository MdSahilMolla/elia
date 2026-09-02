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
