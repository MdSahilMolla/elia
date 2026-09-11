import { expect, test } from 'bun:test'
import { redactRecord, redactText, relativizeProjectPaths } from './redact.ts'

test('redacts credential-shaped keys recursively', () => {
  expect(redactRecord({ apiKey: 'sk-test-secret', nested: { authorization: 'Bearer abcdefghijklmnop' } })).toEqual({
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]' },
  })
})

test('redacts common secret-shaped values in free text and bounds previews', () => {
  const syntheticToken = ['ghp_', '1234567890abcdefghij'].join('')
  expect(redactText(`token=${syntheticToken}`)).toContain('[REDACTED]')
  expect(redactText('a '.repeat(200), 30).length).toBe(30)
})

test('still redacts a padded base64 secret blob', () => {
  const blob = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldA=='
  expect(redactText(`SECRET=${blob}`)).toContain('[REDACTED]')
})

test('still redacts a long unbroken token', () => {
  const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'
  expect(redactText(token)).toBe('[REDACTED]')
})

test('redacts credential key/value assignments in free text regardless of case', () => {
  const masked = redactText('export SECRET_KEY=do-not-leak now')
  expect(masked).toContain('[REDACTED]')
  expect(masked).not.toContain('do-not-leak')
  expect(redactText('authorization: Bearer deadbeef')).not.toContain('Bearer')
  expect(redactText('remember the password=guest for the lab')).not.toContain('password=guest')
})

test('does not redact a deep repo-relative path', () => {
  const path = 'workspace/edcdemo/src/components/DemoPanel.tsx'
  expect(redactText(`edited ${path}`)).toBe(`edited ${path}`)
})

test('redacts a full real-world JWT as one token, not just its payload segment', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' // pragma: allowlist secret
  const redacted = redactText(`Authorization: Bearer ${jwt}`)
  expect(redacted).not.toContain('eyJhbGci')
  expect(redacted).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
  // The whole token collapses to a single marker, not one per segment.
  expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(1)
})

test('redacts a classic AWS secret access key (40 chars, contains "/", no padding)', () => {
  const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' // pragma: allowlist secret
  expect(redactText(`AWS_SECRET_ACCESS_KEY=${awsSecret}`)).not.toContain(awsSecret)
  expect(redactText(`AWS_SECRET_ACCESS_KEY=${awsSecret}`)).toContain('[REDACTED]')
})

test('redacts a vendor-prefixed secret outside the hardcoded prefix list (Stripe whsec_)', () => {
  const whsec = 'whsec_1234567890abcdefghijklmnop' // pragma: allowlist secret
  expect(redactText(`webhook signing secret: ${whsec}`)).not.toContain(whsec)
  expect(redactText(`webhook signing secret: ${whsec}`)).toContain('[REDACTED]')
})

test('rewrites an absolute project path to its repo-relative form', () => {
  const cwd = process.cwd().replace(/\\/g, '/')
  const abs = `${cwd}/workspace/edcdemo`
  expect(relativizeProjectPaths(`built ${abs} ok`, process.cwd())).toBe('built workspace/edcdemo ok')
  expect(redactText(`ls ${abs}`)).toBe('ls workspace/edcdemo')
})
