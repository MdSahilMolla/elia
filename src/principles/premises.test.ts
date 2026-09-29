import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPremises, describePremises, premiseBriefing } from './premises.ts'

const repo = mkdtempSync(join(tmpdir(), 'elia-premises-'))
mkdirSync(join(repo, 'src', 'api'), { recursive: true })
writeFileSync(join(repo, 'src', 'api', 'client.ts'), 'export {}\n')
writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'bun test', build: 'tsc' }, dependencies: { zod: '^3' }, devDependencies: { vitest: '^1' } }))
afterAll(() => rmSync(repo, { recursive: true, force: true }))

const which = (program: string) => (program === 'git' ? '/usr/bin/git' : null)
const check = (premise: string) => checkPremises([premise], repo, { which })[0]!

test('a premise about a file, script, dependency or program is settled against the workspace', () => {
  expect(check('`src/api/client.ts` holds the HTTP client')).toMatchObject({ verdict: 'holds', evidence: 'src/api/client.ts exists' })
  expect(check('the retry lives in `src/api/retry.ts`')).toMatchObject({ verdict: 'false', evidence: 'src/api/retry.ts does not exist' })
  expect(check('`bun run test` runs the suite')).toMatchObject({ verdict: 'holds' })
  expect(check('`bun run lint` passes today')).toMatchObject({ verdict: 'false' })
  expect(check('`bun run lint` passes today').evidence).toContain('(it has: test, build)')
  expect(check('`zod` is a dependency')).toMatchObject({ verdict: 'holds' })
  expect(check('the `react` package is a dependency')).toMatchObject({ verdict: 'false', evidence: 'react is not a dependency in package.json' })
  expect(check('`git` is installed')).toMatchObject({ verdict: 'holds', evidence: 'git is on PATH' })
  expect(check('`docker` is installed and on PATH').verdict).toBe('false')
})

test('what cannot be checked is left open, never promoted to a fact', () => {
  expect(check('the API rate limit is 100 requests a minute').verdict).toBe('unverifiable')
  // A bare name could be anywhere; only a path is a claim about one place.
  expect(check('`helpers.ts` has the formatter').verdict).toBe('unverifiable')
  // Something the plan will make is not a premise about the world.
  expect(check('`src/api/cache.ts` will be created by step 2').verdict).toBe('unverifiable')
  // Outside the workspace is not the workspace's to settle.
  expect(check('config lives in `../other/config.ts`').verdict).toBe('unverifiable')
})

test('the briefing leads with what is false, and says nothing when everything held', () => {
  const checks = checkPremises(['`src/api/retry.ts` exists', 'the API rate limit is 100/min', '`src/api/client.ts` exists'], repo, { which })
  const briefing = premiseBriefing(checks)!
  expect(briefing).toContain('<elia-premises>')
  expect(briefing).toContain('FALSE')
  expect(briefing).toContain('src/api/retry.ts does not exist')
  expect(briefing).toContain('the API rate limit is 100/min')
  expect(briefing).not.toContain('src/api/client.ts exists`')
  expect(describePremises(checks)).toBe('The plan assumed something that is false — src/api/retry.ts does not exist')
  const clean = checkPremises(['`src/api/client.ts` exists'], repo, { which })
  expect(premiseBriefing(clean)).toBeUndefined()
  expect(describePremises(clean)).toBe('Premises: 1 of 1 checked against the workspace and hold')
})

test('without a package.json a script premise is false for a stated reason', () => {
  const bare = mkdtempSync(join(tmpdir(), 'elia-premises-bare-'))
  try {
    expect(checkPremises(['`npm run build` builds it'], bare, { which })[0]).toMatchObject({ verdict: 'false', evidence: 'there is no package.json here, so no script "build"' })
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
})

test('a slash in prose is not a path', () => {
  for (const premise of ['the API allows 100/min', 'reads and/or writes the cache', 'speaks TCP/IP']) expect(check(premise).verdict).toBe('unverifiable')
  expect(check('the handlers live under `src/api/`')).toMatchObject({ verdict: 'holds', evidence: 'src/api/ exists' })
  expect(check('the handlers live under `src/handlers/`')).toMatchObject({ verdict: 'false' })
})
