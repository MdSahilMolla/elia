import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSealedJar, openSealedJar, sealJar, sealingFingerprint, SEALED_JAR_VERSION } from './httpSessionSeal.ts'
import { readSessionJar, writeSessionJar, type SessionJar } from './httpSession.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'elia-session-seal-'))
}

const jar: SessionJar = {
  version: SEALED_JAR_VERSION,
  sessions: { default: [{ name: 'sid', value: 'super-secret-cookie', domain: 'app.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', hostOnly: true, createdAt: 1 }] },
}

describe('the sealed cookie jar', () => {
  test('ciphertext on disk does not contain the cookie value', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'session.json')
      writeSessionJar(path, jar)
      const raw = readFileSync(path, 'utf8')
      expect(raw).not.toContain('super-secret-cookie')
      expect(isSealedJar(JSON.parse(raw))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a sealed jar round-trips back to the values that were written', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'session.json')
      writeSessionJar(path, jar)
      expect(readSessionJar(path).jar.sessions.default?.[0]?.value).toBe('super-secret-cookie')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('each write uses a fresh IV, so two writes of the same jar differ', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'session.json')
      expect(sealJar('{"a":1}', path)).not.toBe(sealJar('{"a":1}', path))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('a jar copied to another project does not decrypt there', () => {
    const one = scratch()
    const two = scratch()
    try {
      const source = join(one, 'session.json')
      const moved = join(two, 'session.json')
      const sealed = sealJar('{"secret":1}', source)
      writeFileSync(moved, sealed)
      expect(openSealedJar(JSON.parse(sealed), source)).toBe('{"secret":1}')
      expect(openSealedJar(JSON.parse(sealed), moved)).toBeUndefined()
      // And the reader surfaces it rather than silently returning an empty jar.
      expect(readSessionJar(moved).corrupt).toContain('did not authenticate')
    } finally {
      rmSync(one, { recursive: true, force: true })
      rmSync(two, { recursive: true, force: true })
    }
  }, 30_000)

  test('a tampered ciphertext fails its auth tag instead of decrypting', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'session.json')
      const sealed = JSON.parse(sealJar('{"secret":1}', path))
      const bytes = Buffer.from(sealed.data, 'base64')
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      expect(openSealedJar({ ...sealed, data: bytes.toString('base64') }, path)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('the derived key is stable for a path and differs across paths', () => {
    expect(sealingFingerprint('C:/engagements/acme/recon/session.json')).toBe(sealingFingerprint('C:/engagements/acme/recon/session.json'))
    expect(sealingFingerprint('C:/engagements/acme/recon/session.json')).not.toBe(sealingFingerprint('C:/engagements/other/recon/session.json'))
  })

  test('a version 1 plaintext jar is recognised and does not crash the reader', () => {
    const dir = scratch()
    try {
      const path = join(dir, 'session.json')
      writeFileSync(path, JSON.stringify({ version: 1, sessions: { default: [{ name: 'sid', value: 'v', domain: 'd', path: '/', secure: false, httpOnly: false, sameSite: 'Lax', hostOnly: true, createdAt: 1 }] } }))
      expect(readSessionJar(path).corrupt).toContain('not a session jar')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
