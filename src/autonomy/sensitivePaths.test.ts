import { expect, test } from 'bun:test'
import { commandMayReadSensitiveData, isEliaTrustFile, isSensitivePath } from './sensitivePaths.ts'

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

// Session mubi8m6o: 29 refusals on a task the user asked for by name — reading
// `.env.example` and the contract at `contracts\token\BhumiNFT.sol`.
test('templates and source files named for a secret are not secrets', () => {
  for (const path of [
    '.env.example',
    'backend/.env.sample',
    '.env.local.example',
    '.env.template',
    'src/lexer/token.ts',
    'contracts/token/BhumiNFT.sol',
    'contracts\\token\\ERC20Token.sol',
    'styles/tokens.css',
    'src/Token.java',
  ]) {
    expect(isSensitivePath(path), path).toBe(false)
  }
  for (const path of ['token', 'token.txt', 'tokens.json', '.env.local', '.env.production', 'secrets.py', '.ssh/.env.example', 'id_rsa']) {
    expect(isSensitivePath(path), path).toBe(true)
  }
})

test('commandMayReadSensitiveData lets templates and code named for a secret through', () => {
  for (const command of [
    'cat .env.example',
    'type backend\\.env.sample',
    'type contracts\\token\\BhumiNFT.sol',
    'cat src/lexer/token.ts',
    'head -20 styles/tokens.css',
  ]) {
    expect(commandMayReadSensitiveData(command), command).toBe(false)
  }
  for (const command of [
    'cat .env',
    'cat .env.local',
    'cat .env.example .env',
    'cat token',
    'type tokens.json',
    'cat ~/.docker/config.json',
    'cat secrets/prod.yaml',
  ]) {
    expect(commandMayReadSensitiveData(command), command).toBe(true)
  }
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
test('elia’s own per-user HMAC secret is a protected path (#1272)', () => {
  // preauth.secret signs every pre-authorization grant. Read it and you can
  // mint your own; the file tools refuse it the same way they refuse an .env.
  for (const path of ['preauth.secret', '.elia/preauth.secret', 'C:\\Users\\me\\.config\\elia\\preauth.secret', 'state/preauth.secret']) {
    expect(isSensitivePath(path), path).toBe(true)
  }
})

test('the trust store matcher is by path, so an app’s own policy.json is untouched (#1272)', () => {
  for (const path of ['.elia/policy.json', '.elia/allow.json', '.elia/preauth.json',
    'packages/app/.elia/allow.json', '.config/elia/allow.json', 'C:\\Users\\me\\.config\\elia\\preauth.json',
    // Fail-closed: the whole relocated per-user trust home.
    '.config/elia/anything-new.json']) {
    expect(isEliaTrustFile(path), path).toBe(true)
  }
  for (const path of ['src/policy.json', 'config/allow.json', 'src/policy.ts', 'docs/preauth.md',
    'src/.config/eliased.json', 'elia/policy.json']) {
    expect(isEliaTrustFile(path), path).toBe(false)
  }
})

test('a shell command that names a trust store is a sensitive read (#1272)', () => {
  for (const command of [
    'cat ~/.config/elia/allow.json',
    'cat .config/elia/preauth.secret',
    'type .elia\\policy.json',
    'head -5 .elia/preauth.secret',
    'cat preauth.secret',
    'git show HEAD:.config/elia/allow.json',
    'grep -r token ~/.config/elia',
  ]) {
    expect(commandMayReadSensitiveData(command), command).toBe(true)
  }
  // The same readers on ordinary project files are still read-only.
  for (const command of ['cat src/policy.json', 'cat config/allow.json', 'grep -r allow src/']) {
    expect(commandMayReadSensitiveData(command), command).toBe(false)
  }
})
