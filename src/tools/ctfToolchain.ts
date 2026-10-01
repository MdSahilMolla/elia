import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { activeMode } from '../autonomy/mode.ts'
import {
  CATEGORY_DESCRIPTIONS,
  TOOL_CATEGORIES,
  binaryForPlatform,
  entriesForCategory,
  probeExecutable,
  type CatalogEntry,
  type ToolCategory,
} from '../security/toolCatalog.ts'

/** A probe is an import or a `--version`, so a slow answer is a broken one. */
const PROBE_TIMEOUT_MS = 4_000

export type WhichFn = (binary: string) => string | null | undefined
export type ProbeFn = (command: string, timeoutMs: number) => Promise<boolean>

/**
 * Detection is injected so the report can be exercised on a machine with none
 * of these tools installed — the same seam `securityScan.ts` uses for its
 * command runner. Nothing here is allowed to mutate: `which` and `probe` only
 * read the machine.
 */
export interface ToolchainContext {
  platform?: NodeJS.Platform
  which?: WhichFn
  probe?: ProbeFn
  probeTimeoutMs?: number
  signal?: AbortSignal
  /** Shared across calls so a repeated report does not re-run the probes. */
  probeCache?: Map<string, Promise<boolean>>
}

export interface ToolStatus {
  name: string
  category: ToolCategory
  present: boolean
  /** The binary that was found, or the probe command that answered. */
  detectedAs: string
  /** How detection is claimed, for the report's own honesty. */
  via: 'binary' | 'probe'
  purpose: string
  install?: string
  scopeNote?: string
  note?: string
}

type InstallMechanism = 'apt' | 'winget' | 'choco' | 'brew' | 'pip' | 'npm' | 'gem' | 'go' | 'manual'

/** Friction order, highest first: this is the order the groups are printed in. */
const INSTALL_MECHANISM_ORDER: InstallMechanism[] = ['apt', 'winget', 'choco', 'brew', 'pip', 'npm', 'gem', 'go', 'manual']

/**
 * What each group actually costs the user, in plain language. The governor
 * treats these differently — `sudo` is a critical-band command, an install that
 * runs package build scripts is its own thing, and a plain download is not — so
 * the difference has to be stated, not implied.
 */
const INSTALL_COST: Record<InstallMechanism, { friction: string; cost: string }> = {
  apt: {
    friction: 'HIGHEST friction',
    cost: 'This runs `sudo`, so it installs as root across the whole machine and asks the user for their password. It is the hardest thing here to reverse and the one to ask for explicitly, one exact command at a time.',
  },
  winget: {
    friction: 'MEDIUM friction',
    cost: 'A machine-wide package install. Depending on the package it raises a Windows elevation prompt, and it changes the machine\'s package state outside the project either way.',
  },
  choco: {
    friction: 'MEDIUM friction',
    cost: 'A machine-wide package install that normally needs an elevated shell, and it changes the machine\'s package state outside the project.',
  },
  brew: {
    friction: 'MEDIUM friction',
    cost: 'No root, but it writes into the Homebrew prefix — outside the project, and the machine\'s package state changes.',
  },
  pip: {
    friction: 'MEDIUM-HIGH friction',
    cost: 'No root, but pip runs the package\'s own install and build scripts. That is arbitrary code fetched from the network and executed during the install, before any of it is yours to read.',
  },
  npm: {
    friction: 'MEDIUM-HIGH friction',
    cost: 'A global install runs the package\'s lifecycle scripts and writes into the global node_modules, outside the project. Same caution as pip, plus a global prefix to undo it in.',
  },
  gem: {
    friction: 'MEDIUM-HIGH friction',
    cost: 'No root, but `gem install` compiles native extensions from downloaded source, so build code from the network runs during the install.',
  },
  go: {
    friction: 'MEDIUM friction',
    cost: 'Downloads the module and compiles it, then writes a binary into GOPATH/bin. No package setup scripts, but it is remote code being built on this machine.',
  },
  manual: {
    friction: 'LOWEST friction',
    cost: 'A plain download and unzip: no root, no package manager, no install scripts. The user still has to put it on PATH themselves, and for a couple of these the download also means running that project\'s own install script.',
  },
}

/** Probes are per-process facts: an import does not become true or false mid-run. */
const defaultProbeCache = new Map<string, Promise<boolean>>()

/**
 * The real probe: an async, timeout-bounded run of the probe command. Never
 * `spawnSync` — each probe would block the event loop for its whole timeout, and
 * a hung interpreter (`python3` is the Store app-execution alias on Windows)
 * would then cost that timeout again for every probe behind it. Exported so the
 * mechanism itself can be exercised, not just the injection seam.
 */
export async function runProbeCommand(command: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  // Run from a fresh empty directory, never the workspace: a probe resolves
  // modules and relative paths against its cwd, and detection must not execute
  // code a project (or a cloned challenge) put there.
  let neutral: string | undefined
  try {
    neutral = mkdtempSync(join(tmpdir(), 'elia-probe-'))
    const result = await runShell(command, timeoutMs, neutral, signal)
    return result.exitCode === 0 && !result.timedOut
  } catch {
    return false
  } finally {
    if (neutral) rmSync(neutral, { recursive: true, force: true })
  }
}

async function probeOnce(command: string, ctx: ToolchainContext, timeoutMs: number): Promise<boolean> {
  const cache = ctx.probeCache ?? defaultProbeCache
  const key = `${ctx.platform ?? process.platform}|${command}`
  const cached = cache.get(key)
  if (cached) return cached
  const probe = ctx.probe ?? ((cmd, ms) => runProbeCommand(cmd, ms, ctx.signal))
  // Cached as a settled boolean: a rejected probe must not be handed to the
  // next caller as a live promise that rejects with nobody listening.
  const running = probe(command, timeoutMs).catch(() => false)
  cache.set(key, running)
  return running
}

function isCategory(value: string): value is ToolCategory {
  return (TOOL_CATEGORIES as string[]).includes(value)
}

/** What a missing tool costs, and where it comes from. */
function detectionNote(entry: CatalogEntry, platform: NodeJS.Platform): string | undefined {
  if (entry.binaries.length === 0) {
    const exe = probeExecutable(entry.probe)
    return exe ? `detected by probe, so it only answers once ${exe} is on PATH` : undefined
  }
  const resolved = binaryForPlatform(entry, platform)
  const canonical = entry.binaries[0]
  if (resolved && canonical && resolved !== canonical) return `on ${platform} the binary is ${resolved}, not ${canonical}`
  return undefined
}

/** `NodeJS.Platform` spells these `darwin`/`win32`; the catalog's hints spell them `macos`/`windows`. */
export function installKeyFor(platform: NodeJS.Platform = process.platform): 'linux' | 'macos' | 'windows' {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

async function detectEntry(entry: CatalogEntry, ctx: ToolchainContext): Promise<ToolStatus> {
  const platform = ctx.platform ?? process.platform
  const which = ctx.which ?? ((binary: string) => Bun.which(binary))
  const note = detectionNote(entry, platform)
  const install = entry.install?.[installKeyFor(platform)]
  const base: ToolStatus = {
    name: entry.name,
    category: entry.category,
    present: false,
    detectedAs: '',
    via: 'binary',
    purpose: entry.purpose,
    ...(install ? { install } : {}),
    ...(entry.scopeNote ? { scopeNote: entry.scopeNote } : {}),
    ...(note ? { note } : {}),
  }

  // Every accepted spelling, so a tool that answers to two names is not reported
  // missing because we guessed the wrong one.
  for (const binary of entry.binaries) {
    if (which(binary)) return { ...base, present: true, detectedAs: binary, via: 'binary' }
  }
  if (entry.probe) {
    const answered = await probeOnce(entry.probe, ctx, ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS)
    if (answered) return { ...base, present: true, detectedAs: entry.probe, via: 'probe' }
  }
  return { ...base, detectedAs: binaryForPlatform(entry, platform) ?? entry.name, via: entry.binaries.length === 0 ? 'probe' : 'binary' }
}

/** Classify an install hint by what it actually runs, so the plan can label its cost. */
export function classifyInstall(hint: string): InstallMechanism {
  const normalized = hint.trim().toLowerCase()
  if (/^(sudo\s+)?(apt|apt-get)\s+install\b/.test(normalized)) return 'apt'
  if (/^winget\s+install\b/.test(normalized)) return 'winget'
  if (/^choco\s+install\b/.test(normalized)) return 'choco'
  if (/^brew\s+install\b/.test(normalized)) return 'brew'
  if (/^(sudo\s+)?(pip3?\s+install|python3?\s+-m\s+pip\s+install)/.test(normalized)) return 'pip'
  if (/^(sudo\s+)?npm\s+(i|install|add)\b/.test(normalized) || /^npx\s/.test(normalized)) return 'npm'
  if (/^gem\s+install\b/.test(normalized)) return 'gem'
  if (/^go\s+install\b/.test(normalized)) return 'go'
  return 'manual'
}

/**
 * Whether a catalog hint is one command this is willing to run unattended, and
 * the exact text to run.
 *
 * The catalog deliberately mixes runnable commands with prose notes, because
 * the file's own header rule is that a wrong install command is worse than no
 * hint: `ghidra` is "Download … from the vendor" and `otool` has no Linux
 * equivalent at all. Some entries also append a human note to a real command
 * (`sudo apt install nmap — ncat ships inside the nmap package`). Executing a
 * hint verbatim would therefore run English as a shell, or hand `apt` a
 * trailing sentence to resolve as a package name, and the resulting failure
 * would be recorded as if the install had been tried and failed. So a hint has
 * to be exactly one recognised install command with nothing trailing it, and
 * anything else is reported rather than attempted.
 */
export function executableInstallCommand(hint: string): string | undefined {
  const trimmed = hint.trim()
  if (!trimmed) return undefined
  // An em dash or a spaced hyphen is the catalog's marker for "… and here is
  // why", i.e. prose appended to a command. Stop at the dash rather than guess
  // where the command ended.
  if (/[\u2014\u2013]|\s-\s/.test(trimmed)) return undefined
  // Chains, redirection, and substitution are an author's own multi-step
  // procedure (pwndbg is clone-then-make), not a one-line install. Each of
  // those needs its own approval and its own supervision.
  if (/&&|\|\||[;|`]|\n|\r|\$\(|>|<|\$\{|\|\d/.test(trimmed)) return undefined
  if (classifyInstall(trimmed) === 'manual') return undefined
  return trimmed
}


function formatToolStatus(status: ToolStatus): string[] {
  const marker = status.present ? '[present]' : '[missing]'
  const via = status.via === 'probe' ? `probe: ${status.detectedAs}` : `binary: ${status.detectedAs}`
  const lines = [`  ${marker} ${status.name}  (${via})`]
  if (!status.present) lines.push(`      blocked: ${status.purpose}`)
  if (status.note) lines.push(`      note: ${status.note}`)
  if (!status.present && status.install) lines.push(`      install: ${status.install}`)
  if (status.scopeNote) lines.push(`      scope: ${status.scopeNote}`)
  return lines
}

function formatInstallPlan(missing: ToolStatus[], platform: NodeJS.Platform): string[] {
  const osKey = installKeyFor(platform)
  const lines: string[] = []
  lines.push('')
  lines.push('--- Install plan (NOTHING BELOW WAS EXECUTED) ---')
  if (missing.length === 0) {
    lines.push('Nothing to install: every catalogued tool for the requested categories was detected.')
    return lines
  }
  lines.push('These are suggestions for the user, not actions. Elia\'s governor treats them very differently,')
  lines.push('so each group states what running it would actually cost before anyone approves it.')

  const groups = new Map<InstallMechanism, ToolStatus[]>()
  const unhintable: ToolStatus[] = []
  for (const status of missing) {
    if (!status.install) {
      unhintable.push(status)
      continue
    }
    const mechanism = classifyInstall(status.install)
    const bucket = groups.get(mechanism)
    if (bucket) bucket.push(status)
    else groups.set(mechanism, [status])
  }

  let index = 0
  for (const mechanism of INSTALL_MECHANISM_ORDER) {
    const bucket = groups.get(mechanism)
    if (!bucket || bucket.length === 0) continue
    index += 1
    const { friction, cost } = INSTALL_COST[mechanism]
    lines.push('')
    lines.push(`[${index}] ${mechanism} — ${friction}`)
    lines.push(`    cost: ${cost}`)
    for (const status of bucket) {
      lines.push(`    ${status.name}: ${status.install}`)
      if (status.note) lines.push(`        note: ${status.note}`)
    }
  }

  if (unhintable.length > 0) {
    lines.push('')
    lines.push('Missing, with no install hint recorded (do not improvise a command for these):')
    for (const status of unhintable) {
      lines.push(`    ${status.name} — no ${osKey} hint, blocked: ${status.purpose}`)
    }
  }
  return lines
}

export function formatToolchainReport(statuses: ToolStatus[], platform: NodeJS.Platform, categories: ToolCategory[]): string {
  const present = statuses.filter((status) => status.present).length
  const lines: string[] = []
  lines.push('=== CTF toolchain (read-only detection) ===')
  lines.push(`Platform: ${platform}`)
  lines.push(`Categories: ${categories.join(', ')}`)
  lines.push(`Detected ${present} of ${statuses.length} catalogued tools.`)
  lines.push('')
  lines.push('This tool only REPORTS. It NEVER installs, NEVER downloads, and NEVER runs an install')
  lines.push('command. The only processes it started were the import/`--version` probes named below.')
  lines.push('Anything in the install plan is a suggestion for the user to run themselves.')

  for (const category of categories) {
    const inCategory = statuses.filter((status) => status.category === category)
    if (inCategory.length === 0) continue
    lines.push('')
    lines.push(`--- ${category} — ${CATEGORY_DESCRIPTIONS[category]} ---`)
    for (const status of inCategory) lines.push(...formatToolStatus(status))
  }

  lines.push(...formatInstallPlan(statuses.filter((status) => !status.present), platform))
  return lines.join('\n')
}

export async function reportToolchain(input: Record<string, unknown>, ctx: ToolchainContext = {}): Promise<string> {
  const requested = optionalString(input.category, 'category')
  if (requested !== undefined && !isCategory(requested)) {
    throw new Error(`category must be one of: ${TOOL_CATEGORIES.join(', ')} — got "${requested}"`)
  }
  const categories: ToolCategory[] = requested === undefined ? [...TOOL_CATEGORIES] : [requested]
  const entries = categories.flatMap((category) => entriesForCategory(category))
  // Probes in parallel: one wedged interpreter must not add its whole timeout to
  // the other nine (the same lesson environment.ts records for `--version`).
  const statuses = await Promise.all(entries.map((entry) => detectEntry(entry, ctx)))
  return formatToolchainReport(statuses, ctx.platform ?? process.platform, categories)
}

/** Installing a package is minutes of work, not a `--version`. */
const INSTALL_TIMEOUT_MS = 600_000

/**
 * What happened to one entry's install. Every terminal state names the reason,
 * including the two that are deliberate non-actions, so a caller can tell
 * "installed", "I declined to guess", and "the machine said no" apart instead of
 * reading them all as failure.
 */
export type InstallOutcome = 'installed' | 'already-present' | 'no-runnable-hint' | 'needs-sudo' | 'failed' | 'skipped'

export interface InstallReceipt {
  name: string
  category: ToolCategory
  outcome: InstallOutcome
  mechanism?: InstallMechanism
  command?: string
  detail?: string
}

export interface InstallContext extends ToolchainContext {
  /** Injection seam for the install runner, mirroring SecurityToolContext.runCommand. */
  runInstall?: (command: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>
}

function defaultRunInstall(command: string, timeoutMs: number, signal?: AbortSignal) {
  return runShell(command, timeoutMs, undefined, signal)
}

/**
 * Whether sudo already holds a live credential, without ever prompting for one.
 *
 * `sudo -n true` fails immediately instead of hanging when nothing is cached,
 * which is what makes this usable from an unattended run. The password itself is
 * deliberately never read, requested, or passed through this process: it would
 * land in a tool argument and could reach a log or a receipt. The supported way
 * to unblock an install is for the user to run `sudo -v` in their own terminal,
 * which caches the credential for the following ~15 minutes.
 */
async function sudoReady(run: InstallContext['runInstall'], signal?: AbortSignal): Promise<boolean> {
  const executor = run ?? defaultRunInstall
  try {
    const result = await executor('sudo -n true', 10_000, signal)
    return result.exitCode === 0 && !result.timedOut
  } catch {
    return false
  }
}

/**
 * Install one catalogued entry, then re-detect it.
 *
 * The re-detection is the whole point: an install that ran without error but
 * left the binary off PATH (a pip `--user` install, a `go install` whose
 * GOPATH/bin is not exported) is reported as not-installed rather than assumed.
 * The probe cache is cleared for that entry first, or the `false` cached by the
 * pre-install report would be handed back and the tool would look permanently
 * missing.
 */
export async function installEntry(entry: CatalogEntry, ctx: InstallContext = {}): Promise<InstallReceipt> {
  const platform = ctx.platform ?? process.platform
  const base: InstallReceipt = { name: entry.name, category: entry.category, outcome: 'failed' }
  const hint = entry.install?.[installKeyFor(platform)]

  if (!hint) {
    return { ...base, outcome: 'no-runnable-hint', detail: `no ${installKeyFor(platform)} install hint recorded` }
  }
  const command = executableInstallCommand(hint)
  if (!command) {
    return {
      ...base,
      outcome: 'no-runnable-hint',
      mechanism: classifyInstall(hint),
      detail: `the recorded hint is a note or a multi-step procedure, not one command: "${hint}"`,
    }
  }

  const mechanism = classifyInstall(command)
  if (mechanism === 'winget' || mechanism === 'choco') {
    // Both raise a Windows elevation dialog that nothing here can answer, so
    // running them unattended would block on a prompt nobody sees.
    return { ...base, outcome: 'skipped', mechanism, command, detail: 'Windows package managers prompt for elevation; install this one yourself' }
  }

  const before = await detectEntry(entry, ctx)
  if (before.present) return { ...base, outcome: 'already-present', detail: `already on PATH as ${before.detectedAs}` }

  const executor = ctx.runInstall ?? defaultRunInstall
  if (mechanism === 'apt' && !(await sudoReady(executor, ctx.signal))) {
    return {
      ...base,
      outcome: 'needs-sudo',
      mechanism,
      command,
      detail: 'sudo has no cached credential for this process. Run `sudo -v` in your own terminal, then retry — elia never reads or forwards your password.',
    }
  }

  let result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
  try {
    result = await executor(command, INSTALL_TIMEOUT_MS, ctx.signal)
  } catch (error) {
    return { ...base, outcome: 'failed', mechanism, command, detail: `install threw: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (result.timedOut) {
    return { ...base, outcome: 'failed', mechanism, command, detail: `install exceeded ${INSTALL_TIMEOUT_MS}ms and was killed` }
  }
  if (result.exitCode !== 0) {
    const firstError = result.stderr.split('\n').find((line) => line.trim().length > 0)?.trim()
    return { ...base, outcome: 'failed', mechanism, command, detail: firstError || `exited ${result.exitCode} with no stderr` }
  }

  // The install command succeeded; whether the tool is now usable is a separate
  // question, so it is answered by detection rather than by the exit code.
  const cache = ctx.probeCache ?? defaultProbeCache
  if (entry.probe) cache.delete(`${platform}|${entry.probe}`)
  const after = await detectEntry({ ...entry, probe: entry.probe }, { ...ctx, probeCache: cache })
  if (!after.present) {
    return {
      ...base,
      outcome: 'failed',
      mechanism,
      command,
      detail: `the install command succeeded but ${entry.name} still is not detectable as ${after.detectedAs} — it may need a PATH update or a new shell`,
    }
  }
  return { ...base, outcome: 'installed', mechanism, command, detail: `detected as ${after.detectedAs}` }
}

export interface InstallSummary {
  installed: string[]
  alreadyPresent: string[]
  notAttempted: { name: string; reason: string }[]
  failed: { name: string; reason: string }[]
  platform: NodeJS.Platform
}

export function formatInstallSummary(summary: InstallSummary): string {
  const lines: string[] = []
  lines.push('=== CTF toolchain install ===')
  lines.push(`Platform: ${summary.platform}`)
  lines.push('')
  if (summary.installed.length > 0) {
    lines.push(`Installed (${summary.installed.length}): ${summary.installed.join(', ')}`)
  } else {
    lines.push('Installed: nothing — every requested tool was already present or could not be installed.')
  }
  if (summary.alreadyPresent.length > 0) lines.push(`Already present (${summary.alreadyPresent.length}): ${summary.alreadyPresent.join(', ')}`)
  if (summary.notAttempted.length > 0) {
    lines.push('')
    lines.push('Not attempted (deliberate, not a failure):')
    for (const item of summary.notAttempted) lines.push(`    ${item.name} — ${item.reason}`)
  }
  if (summary.failed.length > 0) {
    lines.push('')
    lines.push('Failed:')
    for (const item of summary.failed) lines.push(`    ${item.name} — ${item.reason}`)
  }
  lines.push('')
  lines.push('Detection after install is authoritative: a tool listed under Installed answered a fresh probe.')
  return lines.join('\n')
}

/**
 * Install whatever is missing across the requested categories.
 *
 * Entries are handled one at a time on purpose. A batch `apt install a b c`
 * would be faster, but it also means one bad package name takes the whole
 * command down and reports nothing about which tool was actually responsible —
 * and these entries are independent, so there is nothing to batch for.
 */
export async function installMissingTools(input: Record<string, unknown>, ctx: InstallContext = {}): Promise<string> {
  const requested = optionalString(input.category, 'category')
  if (requested !== undefined && !isCategory(requested)) {
    throw new Error(`category must be one of: ${TOOL_CATEGORIES.join(', ')} — got "${requested}"`)
  }
  const categories: ToolCategory[] = requested === undefined ? [...TOOL_CATEGORIES] : [requested]
  const platform = ctx.platform ?? process.platform
  const entries = categories.flatMap((category) => entriesForCategory(category))

  const statuses = await Promise.all(entries.map((entry) => detectEntry(entry, ctx)))
  const missing = entries.filter((_, index) => !statuses[index]!.present)

  const summary: InstallSummary = {
    installed: [],
    alreadyPresent: [],
    notAttempted: [],
    failed: [],
    platform,
  }
  if (missing.length === 0) {
    summary.alreadyPresent = statuses.map((status) => status.name)
    return formatInstallSummary(summary)
  }

  for (const entry of missing) {
    if (ctx.signal?.aborted) break
    const receipt = await installEntry(entry, ctx)
    if (receipt.outcome === 'installed') summary.installed.push(receipt.name)
    else if (receipt.outcome === 'already-present') summary.alreadyPresent.push(receipt.name)
    else if (receipt.outcome === 'no-runnable-hint' || receipt.outcome === 'needs-sudo' || receipt.outcome === 'skipped') {
      summary.notAttempted.push({ name: receipt.name, reason: receipt.detail ?? receipt.outcome })
    } else summary.failed.push({ name: receipt.name, reason: receipt.detail ?? 'unknown failure' })
  }
  return formatInstallSummary(summary)
}

export const ctfToolchainTool: Tool = {
  name: 'ctf_toolchain',
  description:
    "Report which security/CTF tools are installed on this machine, grouped by category (pwn, rev, crypto, stego, web, misc), with a one-line blocking impact for every missing tool and an install plan grouped by mechanism with what each group would cost the user. Default is READ-ONLY: it only runs PATH lookups and short import/`--version` probes, and it NEVER installs, downloads or runs an install command. Pass `install: true` to execute the plan instead, which installs the missing catalogued tools one at a time, re-probes each one afterwards, and returns a receipt separating what installed from what was deliberately not attempted. It never improvises an install command: a hint that is prose or a multi-step procedure is reported, not guessed at, and a `sudo` install whose credential is not already cached is reported as needing `sudo -v` rather than prompting. Reach for it before starting a challenge so you pick a technique the machine can actually run, rather than discovering a missing tool halfway through an exploit.",
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['pwn', 'rev', 'crypto', 'stego', 'web', 'misc'], description: 'Limit the report to one category (default: all)' },
      install: {
        type: 'boolean',
        description: 'Actually install the missing catalogued tools and re-detect afterwards, instead of only printing a plan. Each install is one approval-class command; a `sudo` one needs `sudo -v` to have been run in your terminal first.',
      },
    },
  },
    async execute(input) {
      if (input.install === true) {
        // Installing security tooling is a cyber capability, so the mode is
        // checked here rather than left to the governor. An approval prompt
        // would gate it in every mode, which is a weaker guarantee than the one
        // this project wants: a `/scope all` grant for `ctf_toolchain.install`
        // settles the action inside cyber mode, and this is what stops that
        // grant from meaning anything anywhere else. The read-only path stays
        // available everywhere — it is a PATH lookup, and denying it in dev
        // would only make it harder to see what is installed.
        if (activeMode() !== 'cyber') {
          return `ctf_toolchain with install: true is a cyber capability and does not run in ${activeMode()} mode — it would install security tooling onto this machine outside a security engagement. Run it in cyber mode (--cyber, or /mode cyber), where /scope all can authorize it. The read-only report still works here; call it without install: true.`
        }
        return installMissingTools(input)
      }
      return reportToolchain(input)
    },
}
