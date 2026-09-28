import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { join, posix, win32 } from 'node:path'
import type { Tool } from './types.ts'
import { clampOutput, formatShellResult, runShell, type ShellResult } from '../shell.ts'
import { captureBeforeWrite } from '../checkpoint.ts'
import { engagementDir } from './engagement.ts'
import { currentAgent } from '../autonomy/context.ts'
import { paths } from '../config.ts'
import { redactSecrets } from '../ui/redact.ts'
import { hostInScope, parseScopeHosts, stripZoneId } from './httpProbe.ts'

const SCAN_TIMEOUT_MS = 5 * 60_000
/** A decompile or a full sweep legitimately runs past five minutes; half an hour is where it stops being a scan. */
const MAX_SCAN_TIMEOUT_MS = 30 * 60_000
const SCAN_RETURN_CHARS = 8_000
const MAX_SCAN_INPUT_LENGTH = 100_000

/** Stamped into the log header and the result when the command names no network target at all. */
const NO_NETWORK_TARGET =
  'scope-check: no network target detected in the command - nothing was verified against SCOPE.md'

/**
 * The last label a dotted token needs before it counts as a hostname. `app.exe`,
 * `findings.json` and `out.txt` are files, and reading one as a host refused
 * legitimate local analysis; an unrecognized TLD is the safe side of that trade.
 */
const KNOWN_TLDS = new Set(
  (
    'com net org edu gov mil int info biz name pro coop museum aero jobs travel mobi tel asia cat post xxx ' +
    'io ai co dev app xyz me cloud online site tech store blog live life world today space fun top vip work ' +
    'local lan home corp internal test example invalid onion ' +
    'us ca uk de fr jp cn ru nl it es se no fi dk cz sk pt gr ro hu tr ua kr tw hk sg ie ch at be ' +
    'nz au br mx ar cl za ng ke il ae sa by kz is lu lv ee hr rs ba al ge am md ph id vn th my'
  ).split(' '),
)

/** Extensions the TLD allowlist alone would wave through, several of which are ccTLDs too (`exploit.pl`, `run.sh`, `agent.so`). */
const FILE_EXTENSIONS = new Set(
  (
    'exe dll so dylib a o obj lib py rb pl sh bash zsh fish ps1 bat cmd vbs js mjs cjs jsx ts tsx c h cpp ' +
    'json yaml yml toml ini cfg conf env xml html htm css scss md txt log csv tsv sql db sqlite ' +
    'zip tar gz bz2 xz 7z rar bin apk jar class img iso pcap pcapng key pem crt cer p12 pfx bak old swp lock map min'
  ).split(' '),
)

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
/** A flag or an assignment, i.e. `LHOST=10.0.0.5` / `--resolve=…` — the target is on the right of the `=`. */
const ASSIGNMENT_LEFT = /^(?:--?[A-Za-z0-9_.-]*|[A-Za-z_][A-Za-z0-9_]*)$/

function isHostCandidate(token: string): boolean {
  const host = stripZoneId(token.toLowerCase().replace(/\.$/, ''))
  if (!host || host.length > 253) return false
  if (isIP(host) !== 0) return true
  if (host === 'localhost') return true
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) return false
  const tld = host.slice(host.lastIndexOf('.') + 1)
  return KNOWN_TLDS.has(tld) && !FILE_EXTENSIONS.has(tld)
}

function hostFromUrl(value: string): string | null {
  try {
    const host = stripZoneId(new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, ''))
    return host || null
  } catch {
    return null
  }
}

/** The host a single command token names, or `null` when the token is a file, a flag value, or anything else. */
function hostFromToken(rawToken: string): string | null {
  // Quotes and trailing punctuation are stripped rather than parsed, so
  // `"evil.com"` inside a header argument is still seen.
  const token = rawToken.replace(/^["'([{]+/, '').replace(/["')\]},;]+$/, '')
  if (!token) return null

  // `user@host` — ssh, scp and curl hide the real target to the right of an @.
  const at = token.lastIndexOf('@')
  const body = at >= 0 ? token.slice(at + 1) : token
  if (!body) return null

  if (URL_SCHEME.test(body)) return hostFromUrl(body)

  // A drive letter, a rooted path, or any backslash is a filename.
  if (posix.isAbsolute(body) || win32.isAbsolute(body) || body.includes('\\')) return null

  const equals = body.indexOf('=')
  if (equals > 0 && ASSIGNMENT_LEFT.test(body.slice(0, equals))) return hostFromToken(body.slice(equals + 1))

  const slash = body.indexOf('/')
  if (slash >= 0) {
    // `10.0.0.0/24` and `acme.test/admin` name a host behind the slash;
    // `/usr/share/wordlists/big.txt`, `lists/dirb.txt` and `C:/samples` do not,
    // and the segment in front of the slash is what settles it. A CIDR
    // contributes its network address, so scope decides on the range.
    const head = body.slice(0, slash)
    return isHostCandidate(head) ? stripZoneId(head) : null
  }

  if (body.startsWith('[')) {
    const close = body.indexOf(']')
    if (close < 0) return null
    const inner = stripZoneId(body.slice(1, close))
    return isIP(inner) === 6 ? inner : null
  }
  if (body.includes(':')) {
    const parts = body.split(':')
    // Bare IPv6 has more than one colon; `host:port` has exactly one.
    if (parts.length > 2) return isIP(stripZoneId(body)) === 6 ? stripZoneId(body) : null
    const port = parts[1] ?? ''
    if (/^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 && isHostCandidate(parts[0] ?? '')) {
      return stripZoneId(parts[0]!)
    }
    return null
  }
  return isHostCandidate(body) ? stripZoneId(body) : null
}

/**
 * The network targets a free-form shell command names — hostnames, IPv4
 * literals, `host:port`, CIDR networks, and hosts inside URLs — so the command
 * can be checked against SCOPE.md.
 *
 * Split on whitespace and classify per token. Whatever cannot be classified
 * confidently as a host returns nothing: a miss keeps a local command running,
 * where a false host would refuse it or, worse, be reported as a target.
 */
export function extractCommandTargets(command: string): string[] {
  const targets = new Set<string>()
  for (const token of command.split(/\s+/)) {
    const host = hostFromToken(token)
    if (host) targets.add(host)
  }
  return [...targets]
}

/** Wrappers that hand the next token to the shell, so the binary worth checking is the one behind them. */
const BINARY_WRAPPERS = new Set(['sudo', 'env', 'command', 'call'])

/** cmd.exe and sh builtins: never on PATH, so a missing-binary check on one refuses a command that works. */
const SHELL_BUILTINS = new Set(
  (
    'alias bg break builtin cd chdir cls cmd compgen continue copy date del dir echo erase exec exit export false fc fg for ftype ' +
    'goto hash help history if jobs kill let local logout md mkdir mklink move newln path pause popd printf prompt pushd pwd read ' +
    'readonly recsc return rmdir rd rem ren rename rm set setlocal shopt source suspend test time times trap true type typeset ' +
    'ulimit umask unalias unset wait where while xcopy tree find findstr more sort tasklist taskkill vol ver attrib color title chcp assoc start'
  ).split(' '),
)

/**
 * The binary a command line runs, or `null` when it is not a plain
 * `binary args...` line — a builtin, a quote, a substitution, a PowerShell
 * cmdlet, an absolute path.
 *
 * Only the leading tokens are inspected, so a comma or a pipe in the arguments
 * (`nmap -p 22,80,443 host`, `nmap host | tee out.txt`) still preflights. Where
 * the leading program cannot be named with confidence the check is skipped
 * entirely: a wrong refusal costs a run that would have worked, and the
 * post-run check below still refuses to log a missing binary.
 */
function leadingBinary(command: string): string | null {
  let rest = command.trim()
  for (let wrapper = 0; rest && wrapper <= 4; wrapper += 1) {
    const token = /^[^\s]+/.exec(rest)?.[0] ?? ''
    if (!token || /["'`$(){}[\]<>|;&*?!^~#=,%\\+\n\r]/.test(token)) return null
    if (BINARY_WRAPPERS.has(token.toLowerCase())) {
      rest = rest.slice(token.length).trimStart()
      continue
    }
    if (SHELL_BUILTINS.has(token.toLowerCase())) return null
    if (/^[A-Z][a-z]+-[A-Z]/.test(token)) return null
    return token
  }
  return null
}

/** cmd.exe, sh, and the PowerShell spelling of the same failure. */
const TOOL_UNAVAILABLE = /is not recognized as an internal or external command|command not found|No such file or directory|is not installed/i

function toolUnavailableReason(result: ShellResult): string | undefined {
  if (result.exitCode === 0 || result.timedOut) return undefined
  return result.stderr.split('\n').find((line) => TOOL_UNAVAILABLE.test(line))?.trim() || undefined
}

export type RunScanCommand = (
  command: string,
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
) => Promise<ShellResult>

export interface SecurityToolContext {
  /** Directory containing the `engagements/<slug>/` folders (the workspace). */
  engagementRoot: string
  /** Directory the scan command runs in. */
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  runCommand?: RunScanCommand
  writeLog?: (path: string, contents: string) => Promise<unknown>
  /** PATH lookup used for the pre-run binary check. */
  which?: (name: string) => string | null
}

function validateTimeoutMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('timeoutMs must be a positive integer number of milliseconds')
  }
  return Math.min(value, MAX_SCAN_TIMEOUT_MS)
}

export function validateScanInput(input: Record<string, unknown>): { engagement: string; label: string; command: string; timeoutMs?: number } {
  if (typeof input.engagement !== 'string' || input.engagement.trim().length === 0) throw new Error('engagement must be a non-empty string')
  if (typeof input.label !== 'string' || input.label.trim().length === 0) throw new Error('label must be a non-empty string')
  if (typeof input.command !== 'string' || input.command.trim().length === 0) throw new Error('command must be a non-empty string')
  if (input.command.length > MAX_SCAN_INPUT_LENGTH) throw new Error(`command exceeds ${MAX_SCAN_INPUT_LENGTH} characters`)
  const label = input.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 120) || 'run'
  return { engagement: input.engagement, label, command: input.command, timeoutMs: validateTimeoutMs(input.timeoutMs) }
}

export async function runSecurityTool(input: Record<string, unknown>, ctx: SecurityToolContext): Promise<string> {
  const { engagement, label, command, timeoutMs: requestedTimeout } = validateScanInput(input)
  const dir = engagementDir(engagement, ctx.engagementRoot)
  const scopePath = join(dir, 'SCOPE.md')

  if (!existsSync(scopePath)) {
    return `No engagement "${engagement}" found (missing ${scopePath}). Run new_engagement first — it records what you're authorized to test before any scan runs.`
  }

  // The contents decide what runs, not the file's existence. Checking only that
  // SCOPE.md was there let `nmap anything.example.com` run against an
  // engagement whose scope named a different host.
  const scopeHosts = parseScopeHosts(await Bun.file(scopePath).text())
  const targets = extractCommandTargets(command)
  const outOfScope = targets.filter((host) => !hostInScope(host, scopeHosts))
  if (outOfScope.length > 0) {
    throw new Error(
      `${outOfScope.join(', ')} is not in scope for "${engagement}", so nothing ran and no evidence was saved. SCOPE.md authorizes: ${scopeHosts.join(', ') || '(no hosts parsed)'}. Update the engagement scope if this target is genuinely authorized.`,
    )
  }
  const scopeNote = targets.length > 0 ? `scope-check: ${targets.join(', ')} verified in SCOPE.md` : NO_NETWORK_TARGET

  const binary = leadingBinary(command)
  const which = ctx.which ?? ((name: string) => Bun.which(name))
  if (binary && !which(binary)) {
    return `Tool unavailable: ${binary} is not installed or not on PATH, so nothing ran and no recon log was written. Install it (ctf_toolchain reports what the engagement toolchain provides) or fix PATH first — this is not a scan result and must not be cited as evidence.`
  }

  const timeoutMs = requestedTimeout ?? ctx.timeoutMs ?? SCAN_TIMEOUT_MS
  const runCommand = ctx.runCommand ?? runShell
  const result = await runCommand(command, timeoutMs, ctx.cwd, ctx.signal)

  // A shell that never started the tool produced an error, not a result. That
  // line used to be written to recon/<ts>-<label>.log next to real output and
  // then cited as a finding.
  const unavailable = toolUnavailableReason(result)
  if (unavailable) {
    return `${binary ?? 'The tool'} could not run: ${unavailable}\n\nNothing was saved to recon/ — that output is a tool-availability failure, not scan evidence.`
  }

  const logPath = join(dir, 'recon', `${Date.now()}-${label}.log`)
  const evidence = redactSecrets(formatShellResult(result))

  const writeLog = ctx.writeLog ?? (async (path: string, contents: string) => {
    await captureBeforeWrite(path)
    await Bun.write(path, contents)
  })
  await writeLog(logPath, `$ ${redactSecrets(command)}\n${scopeNote}\n\n${evidence}`)

  return [
    `Saved full output to ${logPath}`,
    scopeNote,
    '',
    clampOutput(evidence, SCAN_RETURN_CHARS),
    evidence.length > SCAN_RETURN_CHARS ? `Output above is clamped to ${SCAN_RETURN_CHARS} characters — read_file ${logPath} for the rest.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export const runSecurityToolTool: Tool = {
  name: 'run_security_tool',
  description:
    "Run a security tool (nmap, curl, openssl, nuclei, sqlmap, gobuster, whatever's installed) for an authorized engagement and save the raw output under that engagement's recon/ folder, so evidence stays organized instead of scrolling past in the terminal. Requires new_engagement to have been run first, and every network target named in the command must appear in that engagement's SCOPE.md — a target outside scope is refused and nothing runs. A command that names no network target still runs (local analysis such as file, strings, radare2, or checksec) and is logged as scope-unverified. The leading binary is checked before the run: a tool that is not installed returns a tool-unavailable message and writes no log, so a 'not recognized' error can never be cited as a finding. Times out after 5 minutes by default, or after timeoutMs (whole milliseconds, capped at 30 minutes) when you pass it — scope a long scan down (fewer ports, smaller wordlist) rather than relying on this to wait forever.",
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
      label: { type: 'string', description: 'Short label for this run, e.g. "nmap-full-tcp" — used in the saved filename' },
      command: { type: 'string', description: 'The shell command to run' },
      timeoutMs: {
        type: 'integer',
        description: 'Optional timeout in milliseconds for analysis-class work like a decompilation (default 300000, max 1800000)',
      },
    },
    required: ['engagement', 'label', 'command'],
  },
  async execute(input) {
    const agent = currentAgent()
    return runSecurityTool(input as Record<string, unknown>, {
      engagementRoot: paths.workspace,
      cwd: agent.cwd ?? process.cwd(),
      signal: agent.signal,
    })
  },
}
