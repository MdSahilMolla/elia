import { expect, test } from 'bun:test'
import { rankSkills, renderSkillHint } from './relevance.ts'
import type { Tool } from '../tools/types.ts'

const skill = (name: string, description: string): Tool => ({
  name,
  description,
  input_schema: { type: 'object', properties: {} },
  async execute() {
    return ''
  },
})

const skills = [
  skill('resize_images', 'Batch-resize and compress image files in a directory'),
  skill('changelog_from_commits', 'Generate a changelog section from git commit history'),
  skill('seed_database', 'Populate the local database with realistic fake records for testing'),
]

test('rankSkills scores by term overlap with the task', () => {
  const ranked = rankSkills('write a changelog for the last release from our commits', skills)
  expect(ranked[0]?.name).toBe('changelog_from_commits')
})

test('renderSkillHint surfaces the top matches, or nothing when none fit', () => {
  expect(renderSkillHint('refactor the auth middleware', skills)).toBe('')
  const hint = renderSkillHint('compress all the images in assets', skills)
  expect(hint).toContain('Skills that fit this task')
  expect(hint).toContain('resize_images')
})

test('no hint when there are no skills at all', () => {
  expect(renderSkillHint('anything', [])).toBe('')
})
