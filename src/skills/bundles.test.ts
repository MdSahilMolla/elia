import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expandSkillSelection, listSkillBundles } from './bundles.ts'
import { externalSkillDirs } from './paths.ts'
import { listSkillFiles } from './loader.ts'

describe('skill bundles and external directories', () => {
  test('expands a bundle into unique existing skill names while preserving omitted selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'elia-bundles-'))
    const path = join(root, 'skill-bundles.json')
    try {
      writeFileSync(path, JSON.stringify({
        'frontend-dev': { description: 'UI workflow', skills: ['ui_review', 'react_test', 'ui_review'] },
      }))
      expect(expandSkillSelection(['frontend-dev', 'ui_review'], path)).toEqual(['ui_review', 'react_test'])
      expect(expandSkillSelection(undefined, path)).toBeUndefined()
      expect(listSkillBundles(path)).toEqual([{ name: 'frontend-dev', description: 'UI workflow', skills: ['ui_review', 'react_test'] }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects malformed and nested bundle definitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'elia-bundles-'))
    const path = join(root, 'skill-bundles.json')
    try {
      writeFileSync(path, JSON.stringify({ 'bad bundle': { skills: ['ui_review'] } }))
      expect(() => listSkillBundles(path)).toThrow('bundle name')
      writeFileSync(path, JSON.stringify({ nested: { skills: ['other-bundle'] } }))
      expect(() => listSkillBundles(path)).toThrow('invalid skill name')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('external directories are explicit, absolute-or-cwd resolved, and deduplicated', () => {
    const root = mkdtempSync(join(tmpdir(), 'elia-external-skills-'))
    try {
      mkdirSync(join(root, 'shared'))
      writeFileSync(join(root, 'shared', 'one.skill.ts'), 'not imported by this listing test')
      // Must use the platform delimiter: ';' on Windows, where ':' is part of
      // the drive letter and would split "C:\..." into nonsense.
      const environment = { ELIA_SKILL_DIRS: `${join(root, 'shared')}${delimiter}${join(root, 'shared')}` }
      expect(externalSkillDirs(environment)).toEqual([join(root, 'shared')])
      expect(listSkillFiles(environment).filter((entry) => entry.file.endsWith('one.skill.ts'))).toEqual([
        { file: join(root, 'shared', 'one.skill.ts'), source: 'external' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
