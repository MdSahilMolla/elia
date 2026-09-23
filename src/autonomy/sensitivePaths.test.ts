import { expect, test } from 'bun:test'
import { commandMayReadSensitiveData, isSensitivePath } from './sensitivePaths.ts'

const classic = [
  '.env',
  'config/.env',
  'config/.env.production',
  '.ENV',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  '.ssh/id_rsa.pub',
  'credentials.json',
  '.aws/credentials',
  '.config/gcloud/application_default_credentials.json',
  'C:\\Users\\me\\.env',
  'C:\\Users\\me\\.ssh\\id_rsa',
]

const innocuous = [
  'README.md',
  'env.example',
  '.envrc-tmpl',
  'src/env.test.ts',
  'not_a_secret.txt',
  'id_rsa.old',
  'C:\\Users\\me\\Documents\\notes.txt',
  'writing/example.txt',
]

const sensitiveByDesign = [
  '.env.test.fixture.ts', // any `.env.*` basename is treated as protected
]

test('isSensitivePath classifies the classic secret locations', () => {
  for (const path of classic) expect(isSensitivePath(path), path).toBe(true)
})

test('isSensitivePath leaves innocuous files alone', () => {
  for (const path of innocuous) expect(isSensitivePath(path), path).toBe(false)
})

test('isSensitivePath conservatively protects dot-env family files', () => {
  for (const path of sensitiveByDesign) expect(isSensitivePath(path), path).toBe(true)
})

test('NTFS alternate data streams cannot smuggle a sensitive file past the classifier', () => {
  // `.env::$DATA` opens the default stream of `.env` on Windows. Every stream
  // spelling of a protected file must classify as sensitive; today the guard
  // strips the stream tail before matching (POSIX filenames legitimately may
  // contain a colon, so the stream suffix logic is win32-only — restore
  // platform afterwards so the other cases still exercise their own branch).
  const previous = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    for (const path of [
      '.env::$DATA',
      '.env:secret',
      'config\\.env::$DATA',
      '.env::$DATA:alternate',
      '.ssh\\id_rsa:$DATA',
      '.aws\\credentials:zone.identifier',
      'C:\\Users\\me\\.env::$DATA',
    ]) {
      expect(isSensitivePath(path), path).toBe(true)
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: previous })
  }
})

test('ads-stripping does not misclassify genuine POSIX colon filenames', () => {
  // Only win32 strips stream tails. A file literally named `.env:1` on POSIX
  // should keep its colon and be ignored by the classifier.
  const previous = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(isSensitivePath('.env:1'), '.env:1 on linux').toBe(false)
    expect(isSensitivePath('.env:detail:notes'), '.env:detail:notes on linux').toBe(false)
  } finally {
    Object.defineProperty(process, 'platform', { value: previous })
  }
})

test('commandMayReadSensitiveData recognises the shell readers it must block', () => {
  for (const command of [
    'cat .env',
    'git show HEAD:.env.production',
    'git diff HEAD~5 -- .ssh/id_rsa',
    'certutil -encode .env output.txt',
    'openssl x509 -in .netrc',
    'type config\\.env',
  ]) {
    expect(commandMayReadSensitiveData(command), command).toBe(true)
  }
})

test('PowerShell readers cannot bypass the sensitive-command gate', () => {
  // `Get-Content` previously escaped detection: neither `cat` nor `type`
  // (both of which grep as aliases) appear as substrings, and the cmdlet was
  // not listed. Its `-Raw`/`-Path`/variable forms must all be caught too.
  for (const command of [
    'Get-Content .env',
    'Get-Content -Path .env',
    'Get-Content .env -Raw',
    'gc .env',
    'cat .env | Out-String',
    'powershell -Command "Get-Content C:\\Users\\me\\.env"',
    'Select-String -Path .env -Pattern "API_KEY"',
    'Import-Csv .env',
  ]) {
    expect(commandMayReadSensitiveData(command), command).toBe(true)
  }
})