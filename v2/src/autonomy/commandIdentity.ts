/**
 * Canonicalizes only the invocation wrapper for durable action identity.
 *
 * This is intentionally a clean-room Elia implementation of a narrow behavior
 * requirement: `/bin/bash -lc SCRIPT` and `bash -lc SCRIPT` should address the
 * same governed action, while the exact SCRIPT text remains part of the key.
 * Complex commands are never tokenized or rewritten.
 */
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const POSIX_SHELL_PATH = /^(?:\/(?:usr\/local\/|usr\/)?bin\/)?([^\s/]+)$/
const POWERSHELL_PATH = /^(?:(?:[A-Za-z]:)?[\\/])?(?:[^\s\\/]+[\\/])*((?:powershell|pwsh)(?:\.exe)?)$/i

const POSIX_SCRIPT_PREFIX = '__elia_shell_script__'
const POWERSHELL_SCRIPT_PREFIX = '__elia_powershell_script__'

/**
 * Returns the stable identity representation of a shell command.
 *
 * Only known system shell executable paths followed by a command mode are
 * normalized. The command body is retained byte-for-byte, so quoting,
 * operators, redirects, and complex scripts cannot be accidentally merged.
 */
export function canonicalizeCommandForIdentity(command: string): string {
  const posix = canonicalizePosixShell(command)
  if (posix) return posix

  const powershell = canonicalizePowerShell(command)
  if (powershell) return powershell

  return command
}

function canonicalizePosixShell(command: string): string | undefined {
  const match = /^(\S+)\s+(-lc|-c)\s+([\s\S]*)$/.exec(command)
  if (!match) return undefined

  const executable = match[1]
  const mode = match[2]
  const script = match[3]
  if (!executable || !mode || script === undefined) return undefined
  const pathMatch = POSIX_SHELL_PATH.exec(executable)
  if (!pathMatch || !POSIX_SHELLS.has(pathMatch[1]!)) return undefined
  return `${POSIX_SCRIPT_PREFIX}\u001f${mode}\u001f${script}`
}

function canonicalizePowerShell(command: string): string | undefined {
  const match = /^(\S+)\s+(-Command|-c|-EncodedCommand)\s+([\s\S]*)$/i.exec(command)
  if (!match) return undefined

  const executable = match[1]
  const mode = match[2]
  const script = match[3]
  if (!executable || !mode || script === undefined || !POWERSHELL_PATH.test(executable)) return undefined
  return `${POWERSHELL_SCRIPT_PREFIX}\u001f${mode.toLowerCase()}\u001f${script}`
}
