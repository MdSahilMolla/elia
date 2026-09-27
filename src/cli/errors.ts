/**
 * The one line (and, when there is one, the hint) a failed command leaves on
 * stderr.
 *
 * Every subcommand's failure used to reach the user as `Error: <message>` —
 * no command name, no idea what to do next, and `EACCES: permission denied,
 * open '…'` read exactly like a bug in elia. The message stays verbatim (it is
 * the evidence); the hint is added only for failure classes whose next step is
 * the same every time.
 */
import { redactSecrets } from '../ui/redact.ts'

const HINTS: Array<[RegExp, string]> = [
  [/\bE(?:ACCES|PERM)\b|permission denied/i, 'Permission denied — check the file or directory permissions, or whether another program has it open.'],
  [/\bENOSPC\b|no space left/i, 'The disk is full — free some space and try again.'],
  [/\bEADDRINUSE\b|address already in use/i, 'That port is already in use — stop whatever holds it, or pick another port.'],
  [/\bE(?:CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN)\b|fetch failed|network (?:is )?(?:down|unreachable)|unable to connect/i, 'Could not reach the server — check the network, the URL, and that the service is running.'],
  [/\b(?:401|403)\b|invalid (?:api )?key|unauthori[sz]ed|incorrect api key/i, 'The provider rejected the credentials — `elia config` shows which keys are set (without printing them).'],
  [/\b(?:402|429)\b|insufficient (?:credit|quota|funds)|rate limit|quota/i, 'The provider refused for credit or rate limits — wait, add credit, or switch with `/model` or `elia config set --provider …`.'],
  [/(?:branch|worktree)\b.*\balready exists|already exists.*\b(?:branch|worktree)/i, 'A branch or worktree with that name already exists — pick another name, or `elia sessions prune` removes leftover session worktrees.'],
  [/\bENOENT\b|no such file or directory/i, 'A file or directory it needed does not exist — check the path and the directory you ran elia from.'],
]

export function describeCliError(error: unknown, options: { command?: string; subject?: string } = {}): string {
  const raw = error instanceof Error ? error.message : String(error)
  // Keep the evidence, but bounded: a stack of provider JSON is not a message.
  const lines = redactSecrets(raw).replace(/^(?:Error:\s*)+/, '').trim().split(/\r?\n/)
  const message = lines.slice(0, 6).join('\n') + (lines.length > 6 ? `\n… ${lines.length - 6} more lines` : '')
  const subject = options.subject ?? (options.command ? `elia ${options.command}` : 'elia')
  const hint = HINTS.find(([pattern]) => pattern.test(raw))?.[1]
  return `${subject} failed: ${message}${hint ? `\n  ${hint}` : ''}`
}
