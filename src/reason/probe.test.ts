import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitProbe, createProbeSynthesizer, parseBunSummary, PROBE_FILE } from './probe.ts'
import { readLibrary } from '../autonomy/certifiedLibrary.ts'
import type { TaskSignature } from './signature.ts'

let dir: string
let project: string
let fixed: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-probe-'))
  project = join(dir, 'project')
  fixed = join(dir, 'fixed')
  for (const root of [project, fixed]) mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(project, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a - b }\n')
  writeFileSync(join(fixed, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b }\n')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const signature = { key: 'repair:single-file' } as TaskSignature

const DISCRIMINATING = `import { expect, test } from 'bun:test'
import { join } from 'node:path'
test('add adds', async () => {
  const mod = await import(join(process.env.ELIA_PROBE_ROOT!, 'src', 'math.ts'))
  expect(mod.add(2, 3)).toBe(5)
  expect(mod.add(-1, 1)).toBe(0)
})
`

const VACUOUS = `import { expect, test } from 'bun:test'
test('always true', () => { expect(1).toBe(1) })
`

test('bun summaries parse, including load errors', () => {
  expect(parseBunSummary({ exitCode: 1, stdout: '', stderr: ' 0 pass\n 1 fail\n 1 error\nRan 1 test across 1 file.' })).toMatchObject({ pass: 0, fail: 1, errors: 1, ran: 1 })
  expect(parseBunSummary({ exitCode: 0, stdout: ' 3 pass\n 0 fail\nRan 3 tests across 1 file.', stderr: '' })).toMatchObject({ pass: 3, fail: 0, ran: 3 })
})

test('admission: a probe must run cleanly and fail before the change', () => {
  const red = admitProbe({ exitCode: 1, pass: 0, fail: 1, errors: 0, ran: 1, output: '' })
  expect(red.admitted).toBe(true)
  expect(red.checks.map((check) => check.family).sort()).toEqual(['execution', 'structural'])
  expect(admitProbe({ exitCode: 0, pass: 1, fail: 0, errors: 0, ran: 1, output: '' }).reason).toContain('already passes')
  expect(admitProbe({ exitCode: 1, pass: 0, fail: 1, errors: 1, ran: 1, output: '' }).admitted).toBe(false)
  expect(admitProbe({ exitCode: 1, pass: 0, fail: 0, errors: 0, ran: 0, output: '' }).admitted).toBe(false)
})

test('a discriminating probe is admitted and then tells a fix from the original', async () => {
  const library = join(dir, 'library.jsonl')
  const synthesize = createProbeSynthesizer({
    request: 'fix add so it adds',
    sourceRoot: project,
    probesDir: join(dir, 'probes'),
    libraryFile: library,
    write: async ({ probeDir }) => writeFileSync(join(probeDir, PROBE_FILE), DISCRIMINATING),
  })
  const verifier = await synthesize(signature)
  expect(verifier).toBeDefined()
  const onFix = await verifier!.run({ id: 'a', approach: 'x', text: '', cwd: fixed })
  expect(onFix.passed).toBe(true)
  expect(onFix.strength).toBe('executed')
  const onOriginal = await verifier!.run({ id: 'b', approach: 'x', text: '', cwd: project })
  expect(onOriginal.passed).toBe(false)
  expect(onOriginal.progress).toBe(0)
  // The probe is a certified verifier artifact in the library.
  const artifact = [...readLibrary(library).values()][0]!
  expect(artifact.kind).toBe('verifier')
  expect(artifact.status).toBe('admitted')
}, 60_000)

test('a probe that already passes is refused, so the search stays honestly unverified', async () => {
  let decision = ''
  const synthesize = createProbeSynthesizer({
    request: 'fix add so it adds',
    sourceRoot: project,
    probesDir: join(dir, 'probes'),
    libraryFile: join(dir, 'library.jsonl'),
    write: async ({ probeDir }) => writeFileSync(join(probeDir, PROBE_FILE), VACUOUS),
    onDecision: (admission) => {
      decision = admission.reason
    },
  })
  expect(await synthesize(signature)).toBeUndefined()
  expect(decision).toContain('cannot tell a fix from doing nothing')
  // And a writer that writes nothing yields no verifier, never a fake one.
  const empty = createProbeSynthesizer({ request: 'x', sourceRoot: project, probesDir: join(dir, 'probes2'), write: async () => {} })
  expect(await empty(signature)).toBeUndefined()
}, 60_000)
