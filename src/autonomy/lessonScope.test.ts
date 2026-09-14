import { expect, test } from 'bun:test'
import { globalLessonsPath, lessonScope, partitionByScope } from './lessonScope.ts'

test('facts about the machine are environment-scoped', () => {
  for (const text of [
    'On Windows, list directories with dir; ls is not a command here',
    'This machine needs the gnullvm toolchain to build Rust targets',
    'PowerShell here does not support && between commands; use ; instead',
    'Set the PATH environment variable before invoking the compiler',
  ]) {
    expect(lessonScope(text)).toBe('environment')
  }
})

test('facts about one codebase stay project-scoped', () => {
  for (const text of [
    'Run the build with bun run build before previewing',
    'src/generated/schema.ts is generated; never edit it by hand',
    'The migrations fixture must be reseeded after changing the schema',
    'Update package.json before publishing',
  ]) {
    expect(lessonScope(text)).toBe('project')
  }
})

test('a project fact that merely mentions an OS is not promoted', () => {
  // The costly mistake: a lesson about *this repo* following the operator into
  // every other repository and asserting something false there. A project
  // signal always wins over an environment one.
  expect(lessonScope('On Windows, run this repo\'s scripts/build.ps1 before the tests')).toBe('project')
  expect(lessonScope('On macOS the vite.config.ts dev server needs a different port')).toBe('project')
})

test('an ambiguous lesson stays local rather than going global', () => {
  // Defaulting to project is the safe direction: an environment fact left
  // behind costs a rediscovery; a project fact promoted costs correctness
  // everywhere else.
  expect(lessonScope('Always reseed before running the integration suite')).toBe('project')
})

test('a batch is split into the two stores', () => {
  const { project, environment } = partitionByScope([
    { text: 'On Windows use dir rather than ls' },
    { text: 'Run bun test before pushing' },
    { text: 'This machine has no docker daemon running' },
  ])
  expect(environment.map((l) => l.text)).toEqual([
    'On Windows use dir rather than ls',
    'This machine has no docker daemon running',
  ])
  expect(project.map((l) => l.text)).toEqual(['Run bun test before pushing'])
})

test('the global store lives under the home directory, and honours an override', () => {
  expect(globalLessonsPath({}, '/home/someone')).toContain('.elia')
  expect(globalLessonsPath({ ELIA_GLOBAL_LESSONS_PATH: '/tmp/elsewhere.md' }, '/home/someone')).toBe('/tmp/elsewhere.md')
})
