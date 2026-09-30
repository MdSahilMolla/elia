import { addAllowRule, allowPath, removeAllowRule, type AllowRule, type AllowScope } from '../autonomy/allowStore.ts'
import { currentBranch, grantPreauth, preauthPath, revokePreauth } from '../autonomy/preauth.ts'
import { activeMode } from '../autonomy/mode.ts'

/**
 * `/scope all` — the one command that lets a cyber run finish without stopping.
 *
 * A CTF solve has to install gdb, radare2 and python packages, read whatever the
 * challenge ships with, and probe a target. Each of those is a critical action
 * the governor is right to gate, and gated in sequence they mean a run that never
 * gets past the toolchain. This records the person's answer in advance, so the
 * loop can actually run.
 *
 * Two deliberate constraints:
 *
 * - The model can never call this. It is a slash command, reached only by a
 *   person at a terminal, so a grant is always something a human typed.
 * - The grants are read only in cyber mode. `settlesOnceFor` in the governor
 *   gates the memory half, but the allow-rule half is consulted for any mode, so
 *   the message says plainly that a dev turn is unaffected — and the intents
 *   below are the ones cyber mode settles, not a blanket shell grant.
 */
interface ScopeGrant {
  intent: string
  tool: string
  why: string
}

/**
 * `shell.sensitive-read` is listed last and is the only one a person might want
 * to decline: it is the class that covers reading `~/.ssh`, `.env` and the
 * credential jar, which is exactly the boundary `/self on` exists to keep. It is
 * granted by default because solving a challenge routinely means reading the
 * files next to it, and `--no-sensitive-read` takes it back.
 */
const GRANTS: ScopeGrant[] = [
  { intent: 'shell.code-exec', tool: 'run_command', why: 'installing the toolchain a technique needs (apt, pip, go)' },
  { intent: 'shell.remote', tool: 'run_command', why: 'fetching wordlists, payloads and challenge material' },
  { intent: 'ctf_toolchain.install', tool: 'ctf_toolchain', why: 'ctf_toolchain with install:true, so the catalogued packages actually get installed' },
  { intent: 'run_security_tool', tool: 'run_security_tool', why: 'running a scanner for a scaffolded engagement' },
  { intent: 'http_probe', tool: 'http_probe', why: 'a single request to an in-scope target' },
  { intent: 'shell.sensitive-read', tool: 'run_command', why: 'reading credential and config files near the target' },
]

const SENSITIVE_READ = GRANTS[GRANTS.length - 1]!

function ruleFor(grant: ScopeGrant): AllowRule {
  // addedAt is a human-readable record of when the standing grant was given;
  // the note says why, so the file explains itself to whoever opens it next.
  // `mode: 'cyber'` is the part that makes the grant honest: it is written
  // tagged, so the store refuses it in any other mode rather than the operator
  // being asked to take that on trust.
  return { tool: grant.tool, intent: grant.intent, mode: 'cyber', addedAt: new Date().toISOString(), note: grant.why }
}

/** `/scope` with no argument: what is granted, and how to change it. */
function status(cwd: string, branch: string): string {
  const lines = [`Standing grants for this project (${allowPath('global', cwd)}):`]
  for (const grant of GRANTS) {
    lines.push(`  ${grant.intent} — ${grant.why}`)
  }
  lines.push('')
  lines.push(`Pre-authorizations for ${cwd} on branch ${branch}: ${preauthPath()}`)
  lines.push('These are read only in cyber mode. /scope all records them, /scope clear removes them.')
  return lines.join('\n')
}

/**
 * `/scope all [--no-sensitive-read]` / `/scope clear` / `/scope` — record, revoke,
 * or show the standing grants a cyber run needs to work unattended.
 *
 * Writes both halves deliberately: a global allow rule covers a supervised
 * session (where the governor otherwise prompts on every command), and a
 * pre-authorization covers an unattended one (where there is nobody to prompt).
 * Recording only one leaves a run that still stops, which was the original
 * complaint.
 */
export async function scopeCommand(arg: string, cwd = process.cwd()): Promise<string> {
  const branch = await currentBranch(cwd)
  const raw = arg.trim()
  const scope: AllowScope = 'global'

  if (!raw) return status(cwd, branch)

  const verb = raw.split(/\s+/)[0]!.toLowerCase()

  if (verb === 'clear' || verb === 'off' || verb === 'revoke') {
    let removed = 0
    for (const grant of GRANTS) removed += removeAllowRule(ruleFor(grant), scope, cwd)
    for (const grant of GRANTS) revokePreauth(grant.intent, cwd, branch, 'cyber')
    return `Revoked ${GRANTS.length} standing grants${removed > 0 ? ` (${removed} allow rules)` : ''} for ${cwd} on ${branch}. A cyber run will ask again.`
  }

  if (verb !== 'all' && verb !== 'on') {
    return `"${raw}" is not a scope. Use /scope all to record the standing grants, /scope clear to remove them, or /scope on its own to see them.`
  }

  const withoutSensitiveRead = /--no-sensitive-read\b/.test(raw)
  const granted = withoutSensitiveRead ? GRANTS.slice(0, -1) : GRANTS

  for (const grant of granted) addAllowRule(ruleFor(grant), scope, cwd)
  // Revoking is not the same as never having granted: if a previous /scope all
  // left the rule behind, the opt-out has to actively take it back or it would
  // silently do nothing.
  if (withoutSensitiveRead) removeAllowRule(ruleFor(SENSITIVE_READ), scope, cwd)

  const intents = granted.map((grant) => grant.intent)
  grantPreauth(intents, cwd, branch, undefined, undefined, 'cyber')

  const lines = [
    `Recorded ${intents.length} standing grants for ${cwd} on branch ${branch}:`,
    ...granted.map((grant) => `  ${grant.intent} — ${grant.why}`),
  ]
  if (withoutSensitiveRead) {
    lines.push('')
    lines.push('  (shell.sensitive-read was withheld — /scope all without the flag adds it back)')
  }
  lines.push('')
  lines.push(`Allow rules: ${allowPath(scope, cwd)}`)
  lines.push(`Pre-authorizations: ${preauthPath()} (valid ${4} hours by default)`)
  lines.push('')
  lines.push(
    activeMode() === 'cyber'
      ? 'Active mode is cyber, so these apply now — a security run will stop asking per command. The grants are tagged cyber in the store itself, so a dev or research turn cannot ride in on them.'
      : 'These are tagged cyber in the store itself: a dev or research turn will not act on them. Switch with /mode cyber, or start a run with --cyber.',
  )
  lines.push('/scope clear removes them. sudo installs still need `sudo -v` in your terminal first.')
  return lines.join('\n')
}
