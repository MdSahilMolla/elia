import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scopeCommand } from './scope.ts'
import { isAllowlisted, clearAllowCache } from '../autonomy/allowStore.ts'
import { assessAction, createActionGovernor } from '../autonomy/governor.ts'
import { clearPreauthCaches, grantPreauth, isPreauthorized } from '../autonomy/preauth.ts'
import { setActiveMode } from '../autonomy/mode.ts'

/**
 * `/scope all` writes to the real global allow path and the real preauth store
 * unless both are redirected, so every test here pins its own tmpdirs. Without
 * that, running the suite would quietly record standing grants on the machine
 * running it — a test must never leave a machine less protected than it found it.
 */
let globalAllowDir: string
let secretDir: string
let repo: string

beforeEach(() => {
  globalAllowDir = mkdtempSync(join(tmpdir(), 'elia-scope-allow-'))
  process.env.ELIA_ALLOW_GLOBAL_PATH = join(globalAllowDir, 'allow.json')
  secretDir = mkdtempSync(join(tmpdir(), 'elia-scope-secret-'))
  process.env.ELIA_PREAUTH_DIR = secretDir
  repo = mkdtempSync(join(tmpdir(), 'elia-scope-repo-'))
  clearPreauthCaches()
  clearAllowCache()
  // Cyber by default: that is the mode a scope grant is for, and the mode in
  // which the apt commands below only classify as shell.code-exec. The tests
  // that care about other modes set them explicitly.
  setActiveMode('cyber')
})

afterEach(() => {
  delete process.env.ELIA_ALLOW_GLOBAL_PATH
  delete process.env.ELIA_PREAUTH_DIR
  clearPreauthCaches()
  clearAllowCache()
  setActiveMode('dev')
  for (const dir of [globalAllowDir, secretDir, repo]) rmSync(dir, { recursive: true, force: true })
})

const INSTALL = { name: 'run_command' as const, input: { command: 'sudo apt install gdb' } }
const OTHER_INSTALL = { name: 'run_command' as const, input: { command: 'sudo apt install radare2' } }
const SCAN = { name: 'run_security_tool' as const, input: { engagement: 'lab', label: 'nmap', command: 'nmap -sV lab.internal' } }

test('/scope all records both halves: an allow rule for supervised, a grant for unattended', async () => {
  const out = await scopeCommand('all', repo)
  expect(out).toContain('shell.code-exec')
  expect(out).toContain('run_security_tool')
  // The allow half: a supervised run stops prompting.
  expect(isAllowlisted(INSTALL, assessAction(INSTALL, repo), repo)).toBe(true)
  expect(isAllowlisted(OTHER_INSTALL, assessAction(OTHER_INSTALL, repo), repo)).toBe(true)
  // The preauth half: an unattended run has nobody to prompt.
  expect(isPreauthorized('shell.code-exec', repo, 'unknown')).toBe(true)
})

test('/scope all makes a supervised cyber run finish without a single prompt', async () => {
  await scopeCommand('all', repo)
  setActiveMode('cyber')
  clearAllowCache()
  const asked: string[] = []
  const governor = createActionGovernor({
    mode: 'supervised',
    cwd: repo,
    approve: async (assessment) => {
      asked.push(assessment.intent)
      return true
    },
  })
  expect((await governor.check(INSTALL)).allowed).toBe(true)
  expect((await governor.check(OTHER_INSTALL)).allowed).toBe(true)
  expect(asked).toEqual([])
})

test('/scope all covers an explicit ctf_toolchain install, not just shell installs', async () => {
  // A solve reaches for ctf_toolchain install:true directly. Left out of the
  // grants it would sit outside /scope all and stop the run on the one call
  // the whole toolchain step exists to make.
  await scopeCommand('all', repo)
  setActiveMode('cyber')
  const install = { name: 'ctf_toolchain' as const, input: { install: true, categories: ['pwn'] } }
  const asked: string[] = []
  const governor = createActionGovernor({
    mode: 'supervised',
    cwd: repo,
    approve: async (assessment) => {
      asked.push(assessment.intent)
      return true
    },
  })
  expect(assessAction(install, repo).intent).toBe('ctf_toolchain.install')
  expect((await governor.check(install)).allowed).toBe(true)
  expect(asked).toEqual([])
})

test('/scope all makes an unattended cyber run finish without a single prompt', async () => {
  await scopeCommand('all', repo)
  setActiveMode('cyber')
  clearAllowCache()
  const governor = createActionGovernor({ mode: 'unattended', cwd: repo })
  expect((await governor.check(INSTALL)).allowed).toBe(true)
  expect((await governor.check(SCAN)).allowed).toBe(true)
})

test('--no-sensitive-read withholds the credential-read grant', async () => {
  await scopeCommand('all --no-sensitive-read', repo)
  const read = { name: 'run_command' as const, input: { command: 'cat /home/agent/.ssh/id_rsa' } }
  expect(assessAction(read, repo).intent).toBe('shell.sensitive-read')
  expect(isAllowlisted(read, assessAction(read, repo), repo)).toBe(false)
  expect(isPreauthorized('shell.sensitive-read', repo, 'unknown')).toBe(false)
  // The rest still stands, or the flag would be a way to get nothing.
  expect(isPreauthorized('shell.code-exec', repo, 'unknown')).toBe(true)
})

test('--no-sensitive-read takes back a grant a previous /scope all recorded', async () => {
  // Revoking has to be active, not merely "not added": otherwise the opt-out
  // silently does nothing for anyone who ran /scope all first.
  await scopeCommand('all', repo)
  const read = { name: 'run_command' as const, input: { command: 'cat /home/agent/.ssh/id_rsa' } }
  expect(isAllowlisted(read, assessAction(read, repo), repo)).toBe(true)

  await scopeCommand('all --no-sensitive-read', repo)
  clearAllowCache()
  expect(isAllowlisted(read, assessAction(read, repo), repo)).toBe(false)
})

test('/scope clear revokes everything it recorded', async () => {
  await scopeCommand('all', repo)
  const out = await scopeCommand('clear', repo)
  expect(out).toContain('Revoked')
  clearAllowCache()
  expect(isAllowlisted(INSTALL, assessAction(INSTALL, repo), repo)).toBe(false)
  expect(isPreauthorized('shell.code-exec', repo, 'unknown')).toBe(false)
})

test('/scope clear leaves a person\'s own unscoped grant alone', async () => {
  // `elia auto --authorize` records an untagged grant, which applies in every
  // mode and is the person's decision, not the scope feature's. Cyber clearing
  // must revoke only what it recorded itself — otherwise saying "no cyber grants
  // on this repo" quietly takes away a standing yes someone else recorded.
  await scopeCommand('all', repo)
  grantPreauth(['shell.code-exec'], repo, 'unknown')
  clearPreauthCaches()
  expect(isPreauthorized('shell.code-exec', repo, 'unknown')).toBe(true)

  await scopeCommand('clear', repo)
  clearPreauthCaches()
  // Still honoured in cyber, because the untagged grant was never cyber-scoped.
  setActiveMode('cyber')
  expect(isPreauthorized('shell.code-exec', repo, 'unknown')).toBe(true)
})

test('/scope is safe to run twice and refuses a verb it does not know', async () => {
  await scopeCommand('all', repo)
  const again = await scopeCommand('all', repo)
  expect(again).toContain('Recorded 6 standing grants')
  expect(await scopeCommand('maybe', repo)).toContain('is not a scope')
})

test('/scope says the grants only apply in cyber mode, rather than implying they always do', async () => {
  setActiveMode('dev')
  const out = await scopeCommand('all', repo)
  expect(out).toContain('tagged cyber in the store itself')
  expect(out).toContain('will not act on them')
  // Recorded while in dev, and still inert: the tag is in the store, not in the
  // mode the run happened to be in when the person said yes.
  expect(isAllowlisted(INSTALL, assessAction(INSTALL, repo), repo)).toBe(false)
  setActiveMode('cyber')
  expect(await scopeCommand('all', repo)).toContain('apply now')
  expect(isAllowlisted(INSTALL, assessAction(INSTALL, repo), repo)).toBe(true)
})

test('/scope on its own lists the grants without recording anything', async () => {
  const out = await scopeCommand('', repo)
  expect(out).toContain('shell.code-exec')
  expect(isPreauthorized('shell.code-exec', repo, 'unknown')).toBe(false)
})

test('the message points at the sudo preflight, since a grant cannot supply a password', async () => {
  // `sudo -v` is a real precondition for every apt install this unblocks, and a
    // person who has just said "yes to everything" will otherwise meet a silent
  // hang and assume the grant failed.
  expect(await scopeCommand('all', repo)).toContain('sudo -v')
})
