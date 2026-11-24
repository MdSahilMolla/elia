import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { paths } from '../config.ts'
import { engagementDir } from './engagement.ts'
import { flagVerify, flagVerifyTool } from './flagVerify.ts'

const originalWorkspace = paths.workspace
const scratch: string[] = []

function sandbox(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  scratch.push(dir)
  paths.workspace = dir
  return dir
}

afterEach(() => {
  paths.workspace = originalWorkspace
  while (scratch.length) rmSync(scratch.pop()!, { force: true, recursive: true })
})

describe('flag_verify: verified requires a derivation the challenge supplied', () => {
  test('a candidate matching the expected sha256 is the only route to verified', async () => {
    const flag = 'flag{correct_horse}'
    const result = await flagVerify({ flag, expectedSha256: createHash('sha256').update(flag).digest('hex') })
    expect(result.verdict).toBe('verified')
    expect(result.confidence).toBe('high')
    expect(result.checks.find((check) => check.id === 'sha256')?.status).toBe('pass')
  })

  test('a candidate matching the expected md5 is verified too', async () => {
    const flag = 'flag{md5_only}'
    const result = await flagVerify({ flag, expectedMd5: createHash('md5').update(flag).digest('hex') })
    expect(result.verdict).toBe('verified')
  })

  // This is the Hasher regression, stated as a test. 33 invented hashes were
  // reported as a solved challenge; here the fabricated string has no digest to
  // match and no artifact containing it, so it cannot come back verified.
  test('an invented candidate with no expected digest is never verified', async () => {
    const result = await flagVerify({ flag: 'flag{definitely_made_up_value}' })
    expect(result.verdict).toBe('not-verifiable')
    expect(result.advisory).toBe(true)
    expect(result.checks.find((check) => check.id === 'derivation')?.status).toBe('skip')
  })

  test('a wrong digest is unverified and says so rather than hedging', async () => {
    const result = await flagVerify({ flag: 'flag{nope}', expectedSha256: createHash('sha256').update('flag{right}').digest('hex') })
    expect(result.verdict).toBe('unverified')
    expect(result.checks.find((check) => check.id === 'sha256')?.status).toBe('fail')
  })

  test('a digest match wins even when the format check fails', async () => {
    // Correctness and prettiness are different questions. A challenge that
    // publishes the digest has answered the first one.
    const flag = 'odd format value'
    const result = await flagVerify({ flag, format: '^CTF\\{', expectedSha256: createHash('sha256').update(flag).digest('hex') })
    expect(result.verdict).toBe('verified')
    expect(result.checks.find((check) => check.id === 'format')?.status).toBe('fail')
  })
})

describe('flag_verify: local artifact search catches a fabricated string', () => {
  test('a flag extracted from the artifact passes presence and is not-verifiable', async () => {
    const dir = sandbox('flagverify-artifact')
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'readme.txt'), 'the flag is flag{really_here} somewhere here')
    const result = await flagVerify({ flag: 'flag{really_here}', challenge: dir })
    expect(result.checks.find((check) => check.id === 'artifact-presence')?.status).toBe('pass')
    expect(result.verdict).toBe('not-verifiable')
    expect(result.confidence).toBe('medium')
  })

  test('a flag absent from the artifacts is unverified and warns about fabrication', async () => {
    const dir = sandbox('flagverify-absent')
    writeFileSync(join(dir, 'app.js'), 'console.log("nothing to see")')
    const result = await flagVerify({ flag: 'flag{invented}', challenge: dir })
    expect(result.verdict).toBe('unverified')
    expect(result.warnings.join(' ')).toContain('most likely invented')
  })

  test('a flag inside a binary artifact is found', async () => {
    const dir = sandbox('flagverify-binary')
    writeFileSync(join(dir, 'chall.elf'), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('\x00flag{binary_won}'), Buffer.from([0, 0, 0])]))
    const result = await flagVerify({ flag: 'flag{binary_won}', challenge: join(dir, 'chall.elf') })
    expect(result.checks.find((check) => check.id === 'artifact-presence')?.status).toBe('pass')
  })

  test('a missing challenge path is skipped, not failed', async () => {
    const result = await flagVerify({ flag: 'flag{x}', challenge: join(tmpdir(), 'definitely-not-here-12345') })
    expect(result.verdict).toBe('not-verifiable')
    expect(result.checks.find((check) => check.id === 'artifact-presence')?.status).toBe('skip')
  })
})

describe('flag_verify: malformed and format handling', () => {
  test('a control character makes the candidate malformed, not unverified', async () => {
    const result = await flagVerify({ flag: 'flag{bad\u0000value}' })
    expect(result.verdict).toBe('malformed')
    expect(result.checks.find((check) => check.id === 'printable')?.status).toBe('fail')
  })

  test('a supplied format that does not match fails the check and warns without changing the verdict', async () => {
    const result = await flagVerify({ flag: 'plain_value', format: '^CTF\\{.*\\}$' })
    expect(result.checks.find((check) => check.id === 'format')?.status).toBe('fail')
    expect(result.verdict).toBe('not-verifiable')
    expect(result.warnings.join(' ')).toContain("challenge's own format")
  })

  test('an invalid format regex is rejected as caller error', async () => {
    await expect(flagVerify({ flag: 'flag{x}', format: '([' })).rejects.toThrow(/not a valid regular expression/)
  })

  test('hex and base64 candidates get an encoding note without promotion', async () => {
    const hex = await flagVerify({ flag: 'deadbeefcafe1234' })
    expect(hex.checks.find((check) => check.id === 'encoding')?.detail).toBe('hex-encoded bytes')
    expect(hex.verdict).toBe('not-verifiable')
    const b64 = await flagVerify({ flag: 'aGVsbG8gd29ybGQ=' })
    expect(b64.checks.find((check) => check.id === 'encoding')?.status).toBe('pass')
    expect(b64.verdict).toBe('not-verifiable')
  })
})

describe('flag_verify: optional engagement recording', () => {
  test('a scaffolded engagement records the verdict to recon/flag-verification.jsonl', async () => {
    sandbox('flagverify-engagement')
    const slug = 'flagverify-lab'
    mkdirSync(join(engagementDir(slug), 'recon'), { recursive: true })
    writeFileSync(join(engagementDir(slug), 'SCOPE.md'), '# scope\n')

    const out = await flagVerifyTool.execute({ flag: 'flag{recorded}', engagement: slug })
    const result = JSON.parse(out) as { verdict: string; recordedTo?: string }
    expect(result.verdict).toBe('not-verifiable')
    expect(result.recordedTo).toBe(`engagements/${slug}/recon/flag-verification.jsonl`)

    const lines = (await Bun.file(join(engagementDir(slug), 'recon', 'flag-verification.jsonl')).text()).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ engagement: slug, flag: 'flag{recorded}', verdict: 'not-verifiable' })
  })

  test('recording appends rather than overwriting a previous verdict', async () => {
    sandbox('flagverify-append')
    const slug = 'flagverify-append-lab'
    mkdirSync(join(engagementDir(slug), 'recon'), { recursive: true })
    writeFileSync(join(engagementDir(slug), 'SCOPE.md'), '# scope\n')

    await flagVerifyTool.execute({ flag: 'flag{first}', engagement: slug })
    await flagVerifyTool.execute({ flag: 'flag{second}', engagement: slug })
    const lines = (await Bun.file(join(engagementDir(slug), 'recon', 'flag-verification.jsonl')).text()).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  // The whole point of the engagement argument being optional: a missing
  // scaffold must degrade to a note, never to a thrown error that stalls a run.
  test('an unscaffolded engagement still returns the verdict, with a note', async () => {
    sandbox('flagverify-unscaffolded')
    const out = await flagVerifyTool.execute({ flag: 'flag{no_engagement}', engagement: 'never-scaffolded' })
    const result = JSON.parse(out) as { verdict: string; recordedTo?: string; warnings: string[] }
    expect(result.verdict).toBe('not-verifiable')
    expect(result.recordedTo).toBeUndefined()
    expect(result.warnings.join(' ')).toContain('not scaffolded')
  })

  test('no engagement argument records nothing and does not warn about it', async () => {
    sandbox('flagverify-no-engagement')
    const out = await flagVerifyTool.execute({ flag: 'flag{standalone}' })
    const result = JSON.parse(out) as { warnings: string[]; recordedTo?: string }
    expect(result.recordedTo).toBeUndefined()
    expect(result.warnings.join(' ')).not.toContain('Not recorded')
  })
})

describe('flag_verify: tool surface', () => {
  test('is advisory and says verification needs a supplied digest', () => {
    expect(flagVerifyTool.name).toBe('flag_verify')
    expect(flagVerifyTool.description).toContain('ADVISORY')
    expect(flagVerifyTool.description).toContain('never')
    expect((flagVerifyTool.input_schema.required as string[])).toEqual(['flag'])
  })

  test('rejects a missing or empty flag rather than guessing', async () => {
    await expect(flagVerifyTool.execute({})).rejects.toThrow(/flag must be a non-empty string/)
    await expect(flagVerifyTool.execute({ flag: '   ' })).rejects.toThrow(/flag must be a non-empty string/)
  })

  test('returns a JSON string, since Tool.execute is string-only', async () => {
    const out = await flagVerifyTool.execute({ flag: 'flag{string_only}' })
    expect(typeof out).toBe('string')
    expect(JSON.parse(out)).toMatchObject({ advisory: true, flag: 'flag{string_only}' })
  })
})
