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

test('keeps git commit SHAs and long identifiers readable', () => {
  const commit = 'a9dcbeb4f1e2d3c4b5a69788776655443322110f'
  const identifier = 'ThisIsAnUnusuallyLongGeneratedClassNameForTheOrmLayer'
  const line = `HEAD is ${commit}, class ${identifier}`
  expect(redactText(line, 1_000)).toBe(line)
})

test('a bare 64-char hex run is still redacted — it is the shape of `openssl rand -hex 32`', () => {
  const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  expect(redactText(`generated ${hex}`)).not.toContain(hex)
})

test('an opaque token that merely looks like a digest in an assignment is still redacted', () => {
  const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  expect(redactText(`API_TOKEN=${hex}`)).not.toContain(hex)
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

// Session mubbhz5c-tnp9i0: every PowerShell verification command the model
// proposed was stored as `$[REDACTED]'Stop'`, because the base64-padding arm
// read the `=` of a space-free assignment as padding. The record of the run no
// longer showed what had actually been proposed.
test('an assignment written without spaces is not mistaken for base64 padding', () => {
  expect(redactText("$errorActionPreference='Stop'")).toBe("$errorActionPreference='Stop'")
  expect(redactText('myVeryLongCamelCaseName=2')).toBe('myVeryLongCamelCaseName=2')
  expect(redactText('powershell -Command "$errorActionPreference=\'Stop\'"')).toContain('$errorActionPreference')
})

test('genuinely padded base64 and keyword assignments are still redacted', () => {
  // Base64 is four characters per three bytes, so a padded blob is a multiple of four.
  expect(redactText('QWxhZGRpbjpvcGVuIHNlc2FtZQ==')).toBe('[REDACTED]')
  expect(redactText('export DATABASE_PASSWORD=hunter2')).toContain('[REDACTED]')
  expect(redactText('export DATABASE_PASSWORD=hunter2')).not.toContain('hunter2')
})
