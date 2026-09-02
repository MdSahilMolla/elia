import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { visualizeTool } from './visualize.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function execute(input: Record<string, unknown>): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-visualize-'))
  roots.push(cwd)
  return executeAt(cwd, input)
}

function executeAt(cwd: string, input: Record<string, unknown>): Promise<string> {
  return withAgentIdentity({ name: 'visual-test', role: 'lead', cwd }, async () => visualizeTool.execute(input))
}

test('creates deterministic escaped bar SVG and Markdown with a bounded terminal fallback', async () => {
  const input = {
    type: 'bar',
    title: 'Revenue <script>alert(1)</script>\u001b[31m',
    slug: 'revenue',
    items: [{ label: 'North & <South>\u001b[2J', value: 120 }, { label: 'Returns', value: -30 }],
  }
  const output = await execute(input)
  const cwd = roots[0]!
  const svgPath = join(cwd, '.elia', 'artifacts', 'revenue.svg')
  const markdownPath = join(cwd, '.elia', 'artifacts', 'revenue.md')
  expect(existsSync(svgPath)).toBe(true)
  expect(existsSync(markdownPath)).toBe(true)
  const svg = readFileSync(svgPath, 'utf8')
  expect(svg).toContain('Revenue &lt;script&gt;alert(1)&lt;/script&gt;')
  expect(svg).toContain('North &amp; &lt;South&gt;')
  expect(svg).not.toContain('\u001b')
  expect(svg).not.toContain('<script>')
  expect(output).toContain('████')
  expect(output).not.toContain('\u001b')
  expect(output.length).toBeLessThan(8_000)
  expect(readFileSync(markdownPath, 'utf8')).toContain('![Revenue')
  await execute(input)
  expect(readFileSync(join(roots[1]!, '.elia', 'artifacts', 'revenue.svg'), 'utf8')).toBe(svg)
})

test('creates a flow and requires every edge to reference declared unique nodes', async () => {
  const output = await execute({
    type: 'flow',
    title: 'Release flow',
    nodes: [{ id: 'plan', label: 'Plan' }, { id: 'ship', label: 'Ship' }],
    edges: [{ from: 'plan', to: 'ship', label: 'after review' }],
  })
  expect(output).toContain('Plan → Ship — after review')
  expect(readFileSync(join(roots[0]!, '.elia', 'artifacts', 'release-flow.svg'), 'utf8')).toContain('marker-end="url(#arrow)"')

  await expect(execute({ type: 'flow', title: 'Invalid flow', nodes: [{ id: 'one', label: 'One' }], edges: [{ from: 'one', to: 'missing' }] })).rejects.toThrow('must reference declared node ids')
})

test('rejects unsafe paths, non-finite values, oversize input, and unsupported types', async () => {
  await expect(execute({ type: 'bar', title: 'x', slug: '../escape', items: [{ label: 'x', value: 1 }] })).rejects.toThrow('slug')
  await expect(execute({ type: 'bar', title: 'x', items: [{ label: 'x', value: Number.POSITIVE_INFINITY }] })).rejects.toThrow('finite number')
  await expect(execute({ type: 'bar', title: 'x', items: Array.from({ length: 31 }, (_, value) => ({ label: 'x', value })) })).rejects.toThrow('1-30')
  await expect(execute({ type: 'bar', title: 'x', svg: '<script />', items: [{ label: 'x', value: 1 }] })).rejects.toThrow('does not accept raw svg')
  await expect(execute({ type: 'pie', title: 'x' })).rejects.toThrow('bar" or "flow')
})

test('replays identical output but never overwrites a different artifact', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-visualize-'))
  roots.push(cwd)
  const first = { type: 'bar', title: 'Stable', slug: 'stable', items: [{ label: 'A', value: 1 }] }
  await executeAt(cwd, first)
  await expect(executeAt(cwd, first)).resolves.toContain('Created bar visualization')
  await expect(executeAt(cwd, { ...first, items: [{ label: 'A', value: 2 }] })).rejects.toThrow('already exists with different content')
})

test('removes complete ANSI and OSC control sequences from artifacts and terminal output', async () => {
  const output = await execute({
    type: 'bar',
    title: '\x1b]52;c;secret\x07Safe \x1b[31mTitle\x1b[0m',
    items: [{ label: '\x1b]8;;https://bad.example\x07Visible\x1b]8;;\x07', value: 1 }],
  })
  const svg = readFileSync(join(roots[0]!, '.elia', 'artifacts', 'safe-title.svg'), 'utf8')
  expect(output).toContain('Safe Title')
  expect(output).not.toContain('52;c;secret')
  expect(output).not.toContain('[31m')
  expect(svg).not.toContain('bad.example')
})
