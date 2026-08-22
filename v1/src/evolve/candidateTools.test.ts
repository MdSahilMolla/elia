import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../tools/types.ts'
import { candidateTools } from './candidateTools.ts'

const writeTool: Tool = {
  name: 'write_file',
  description: 'write',
  input_schema: { type: 'object', properties: {} },
  async execute(input) {
    await Bun.write(input.path as string, input.content as string)
    return 'ok'
  },
}

const commandTool: Tool = {
  name: 'run_command',
  description: 'run',
  input_schema: { type: 'object', properties: {} },
  async execute() {
    return 'unreachable'
  },
}

test('candidate file tools stay inside the sandbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-tools-'))
  try {
    const write = candidateTools(root, [writeTool]).find((tool) => tool.name === 'write_file')!
    await write.execute({ path: 'src/change.ts', content: 'safe' })
    expect(readFileSync(join(root, 'src/change.ts'), 'utf8')).toBe('safe')
    await expect(write.execute({ path: '../escape.ts', content: 'unsafe' })).rejects.toThrow('escapes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('candidate shell rejects commands outside its verification gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elia-tools-'))
  try {
    const run = candidateTools(root, [commandTool]).find((tool) => tool.name === 'run_command')!
    await expect(run.execute({ command: 'git status' })).rejects.toThrow('only allow')
    await expect(run.execute({ command: 'bun test && echo escaped' })).rejects.toThrow('only allow')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
