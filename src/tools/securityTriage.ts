/**
 * Turn a saved recon log into structured facts.
 *
 * `run_security_tool` hands the model an 8KB excerpt of a log that is routinely
 * 100KB and up, and a model reasoning over a truncated blob invents ports,
 * versions and CVEs that were never in the output. This reads the whole log
 * back and reports what it actually parsed — hosts, ports, states, service
 * versions, template matches — so the report and the evidence file are the same
 * document.
 *
 * Read-only: it runs nothing, writes nothing, and never asserts a vulnerability
 * a log did not record. Every conclusion carries `runtime_output` evidence
 * pointing at the log, the same primitives `dependency_audit` and the causal
 * tools use, so triage output and finding output speak the same language.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { paths } from '../config.ts'
import { redactSecrets } from '../ui/redact.ts'
import { assessRisk, riskLevelFor, type RiskDimension, type RiskModel } from './intel/risk.ts'
import { formatEvidence, makeEvidence, type Evidence } from './intel/evidence.ts'
import { engagementDir } from './engagement.ts'
import { describePort, parseNmapXml, type NmapHost, type NmapPort } from '../security/parsers/nmap.ts'
import { parseNmapGrep, type NmapGrepRow } from '../security/parsers/nmapGrep.ts'
import { parseNucleiJsonl, type NucleiFinding } from '../security/parsers/nuclei.ts'

/** A recon log above this is not something a text report can be honest about; the real fix is a narrower scan. */
const MAX_LOG_BYTES = 32 * 1024 * 1024
const MAX_LOGS_PER_CALL = 10
const MAX_FINDINGS_PER_LOG = 20
const MAX_LISTED_LOGS = 25
const MAX_ITEMS_IN_TEXT = 15

export type TriageFormat = 'nmap-xml' | 'nmap-grep' | 'nuclei-jsonl' | 'unknown'

const FORMAT_LABEL: Record<TriageFormat, string> = {
  'nmap-xml': 'nmap-xml (nmap -oX)',
  'nmap-grep': 'nmap-grep (plain nmap text output)',
  'nuclei-jsonl': 'nuclei-jsonl (nuclei -jsonl)',
  unknown: 'unknown',
}

export interface TriageFinding {
  title: string
  /** For nuclei, its own severity string; for nmap, the level the risk model produced. */
  severity: string
  description: string
  risk: RiskModel
  evidence: Evidence[]
}

export interface TriageLogResult {
  /** recon/-relative name of the log that was read. */
  log: string
  format: TriageFormat
  findings: TriageFinding[]
  /** One plain sentence of what the log contained, e.g. `2 hosts, 3 open of 6 probed ports`. */
  observed: string
  /** Set when the log was read but produced nothing, and why. */
  note?: string
}

export interface TriageContext {
  /** Directory holding the `engagements/<slug>/` folders. */
  engagementRoot: string
}

// ---------------------------------------------------------------- nmap ----

/**
 * Every log-derived string is scrubbed where it is built, not only at render
 * time. A recon log is untrusted output: an `extrainfo` field, an extracted
 * result, or a URL query string can carry a credential straight into a report
 * that the model then quotes back as evidence.
 */
function scrub(value: string): string {
  return redactSecrets(value)
}

export interface NmapSurface {
  label: string
  /** Every port the scan resolved, closed ones included. */
  ports: NmapPort[]
  openPorts: NmapPort[]
  osMatches: string[]
}

export function surfaceFromHost(host: NmapHost): NmapSurface {
  return { label: scrub(host.hostname || host.address || '(host not identified)'), ports: host.ports, openPorts: host.openPorts, osMatches: host.osMatches }
}

export function surfacesFromXml(hosts: NmapHost[]): NmapSurface[] {
  return hosts.map(surfaceFromHost)
}

/**
 * Plain nmap output names no host on a row, so the whole file is one surface.
 * Splitting it per row would invent an address the log never printed.
 */
export function surfacesFromGrep(rows: NmapGrepRow[]): NmapSurface[] {
  const ports: NmapPort[] = rows.map((row) => ({
    port: row.port,
    protocol: row.protocol,
    state: row.state,
    service: row.service,
    version: row.version,
    extra: {},
  }))
  return [{ label: '(hosts not named in plain nmap output)', ports, openPorts: ports.filter((port) => port.state === 'open'), osMatches: [] }]
}

function openCountScore(open: number): number {
  if (open === 0) return 5
  if (open <= 3) return 25
  if (open <= 10) return 40
  return 55
}

/**
 * Risk of one host's port surface, from the surface only.
 *
 * The weights cap the score below `high` on purpose. A port being open is a
 * fact about reachability, not a demonstrated weakness, so the severity
 * dimension contributes a floor and never a rise — a wide-open sweep is worth
 * attention, and calling it a vulnerability is how a triage pass starts
 * manufacturing findings. Anything above medium here has to come from a log
 * that actually recorded a weakness, which is nuclei's job, not nmap's.
 */
export function assessNmapSurface(surface: NmapSurface, log: string): TriageFinding {
  const open = surface.openPorts.length
  const total = surface.ports.length
  const disclosed = surface.openPorts.filter((port) => port.version).length

  const evidence: Evidence[] = [
    makeEvidence({
      kind: 'runtime_output',
      description: `${open} of ${total} probed port(s) open on ${surface.label}`,
      location: log,
      confidence: 0.95,
      reproducible: true,
    }),
  ]
  if (disclosed > 0) {
    evidence.push(
      makeEvidence({
        kind: 'runtime_output',
        description: `${disclosed} open service(s) disclosed a product and version`,
        location: log,
        confidence: 0.95,
        reproducible: true,
      }),
    )
  }

  const dimensions: RiskDimension[] = [
    {
      name: 'affected_surface',
      weight: 0.4,
      score: openCountScore(open),
      description: `${open} open port(s) of ${total} probed on ${surface.label}.`,
    },
    {
      name: 'exposure',
      weight: 0.25,
      score: disclosed > 0 ? 45 : open > 0 ? 20 : 10,
      description: disclosed > 0
        ? `${disclosed} open service(s) named a product and version, giving a precise target for a follow-up version check.`
        : open > 0
          ? 'Open services were identified but no product or version was disclosed, so no version could be checked against advisories.'
          : 'No open service was observed.',
    },
    {
      name: 'severity',
      weight: 0.35,
      score: 5,
      description: 'No vulnerability was verified by this scan — open ports and disclosed versions are exposure facts, not a confirmed weakness.',
    },
  ]

  const risk = assessRisk(dimensions, { confidence: 0.95, confidenceSource: `nmap output parsed from ${log}` })
  const described = surface.openPorts.slice(0, MAX_ITEMS_IN_TEXT).map((port) => scrub(describePort(port)))
  const closed = total - open

  return {
    title: `${open} open port${open === 1 ? '' : 's'} on ${surface.label}`,
    severity: riskLevelFor(risk.score),
    description: [
      `${open} of ${total} probed port(s) open${closed > 0 ? `, ${closed} closed or filtered` : ''}${described.length > 0 ? `: ${described.join('; ')}` : ''}.`,
      surface.osMatches.length > 0 ? `OS guess: ${scrub(surface.osMatches.slice(0, 3).join('; '))}.` : '',
      'No vulnerability was verified by this scan — check the disclosed versions against advisories before treating any of this as a finding.',
    ]
      .filter(Boolean)
      .join(' '),
    risk,
    evidence,
  }
}

// -------------------------------------------------------------- nuclei ----

const NUCLEI_SEVERITY_SCORE: Record<string, number> = { info: 10, low: 30, medium: 50, high: 70, critical: 90 }
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }

/**
 * One finding per template, not per match. A template that fired 400 times
 * across 30 hosts is one thing to act on; 400 rows are not, and the model's
 * next move is to check the template, not to re-read the log.
 */
export function assessNucleiLog(findings: NucleiFinding[], log: string): TriageFinding[] {
  const groups = new Map<string, NucleiFinding[]>()
  for (const finding of findings) {
    const key = `${finding.templateId}|${finding.severity}`
    const group = groups.get(key)
    if (group) group.push(finding)
    else groups.set(key, [finding])
  }

  const assessed: TriageFinding[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const hosts = [...new Set(group.map((finding) => finding.host).filter(Boolean).map(scrub))]
    const severityScore = NUCLEI_SEVERITY_SCORE[first.severity] ?? 25
    const hostCount = hosts.length

    const evidence: Evidence[] = [
      makeEvidence({
        kind: 'runtime_output',
        description: `nuclei template ${scrub(first.templateId)} matched ${group.length} time(s) across ${hostCount} host(s)`,
        location: log,
        confidence: 0.95,
        reproducible: true,
      }),
    ]

    const dimensions: RiskDimension[] = [
      {
        name: 'severity',
        weight: 0.8,
        score: severityScore,
        description: `nuclei reported this template as "${first.severity || 'unknown'}" — taken from the template, not derived here.`,
      },
      {
        name: 'exposure',
        weight: 0.12,
        score: hostCount > 0 ? 40 : 10,
        description:
          hostCount > 0
            ? `The template matched a live response on ${hosts.slice(0, 3).join(', ')}${hostCount > 3 ? ' …' : ''}.`
            : "The log records no host for this match, so the template's target could not be confirmed from the output.",
      },
      {
        name: 'affected_surface',
        weight: 0.08,
        score: hostCount === 0 ? 0 : hostCount === 1 ? 10 : hostCount <= 5 ? 25 : 40,
        description: `${hostCount} distinct host(s) matched this template.`,
      },
    ]

    const risk = assessRisk(dimensions, { confidence: 0.95, confidenceSource: `nuclei -jsonl output parsed from ${log}` })
    const examples = group
      .slice(0, MAX_ITEMS_IN_TEXT)
      .map((finding) => scrub(finding.matchedAt || finding.host))
      .filter(Boolean)

    assessed.push({
      title: `${scrub(first.name || first.templateId)} [${first.severity || 'unknown'}]`,
      severity: first.severity || 'unknown',
      description: [
        `${group.length} match(es) of ${scrub(first.templateId)} across ${hostCount} host(s)${examples.length > 0 ? `: ${examples.join('; ')}` : ''}.`,
        first.matcherName ? `Matcher: ${scrub(first.matcherName)}.` : '',
        'nuclei matched this template; open the matched URL and confirm the issue before logging it as a finding.',
      ]
        .filter(Boolean)
        .join(' '),
      risk,
      evidence,
    })
  }

  return assessed.sort((a, b) => (SEVERITY_RANK[b.severity] ?? -1) - (SEVERITY_RANK[a.severity] ?? -1) || b.risk.score - a.risk.score)
}

// -------------------------------------------------------------- format ----

/**
 * Which scanner produced this log, decided by the content.
 *
 * The filename is whatever the model chose as a label, so it proves nothing —
 * a `nuclei.log` full of nmap text is still nmap text. A log that is JSON but
 * not nuclei's is reported as unknown rather than re-read looking for a line
 * that happens to fit, because a format this cannot name is a format this
 * cannot honestly summarise.
 */
export function detectScanFormat(content: string): TriageFormat {
  if (/<nmaprun[\s>]/i.test(content)) return 'nmap-xml'
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unknown'
    const record = parsed as Record<string, unknown>
    return 'template-id' in record || 'templateId' in record || 'templateID' in record ? 'nuclei-jsonl' : 'unknown'
  }
  return parseNmapGrep(content).length > 0 ? 'nmap-grep' : 'unknown'
}

/** Parse one log's contents into findings. Pure — no filesystem, no shell. */
export function triageLogContent(content: string, log: string): TriageLogResult {
  const format = detectScanFormat(content)
  if (format === 'nmap-xml') {
    const hosts = parseNmapXml(content)
    // A `<host>` the scan never got to fill in is a parsing artefact, not a
    // finding: reporting "0 open ports" for a host whose `<ports>` was cut off
    // is the same kind of invented fact this tool exists to stop.
    const surfaces = surfacesFromXml(hosts).filter((surface) => surface.ports.length > 0)
    const open = surfaces.reduce((sum, surface) => sum + surface.openPorts.length, 0)
    const probed = surfaces.reduce((sum, surface) => sum + surface.ports.length, 0)
    return {
      log,
      format,
      findings: surfaces.map((surface) => assessNmapSurface(surface, log)),
      observed: `${hosts.length} host(s), ${open} open of ${probed} probed port(s)`,
      ...(surfaces.length === 0
        ? { note: 'The document is nmap XML but no host carried a parsed port — the file is likely truncated before the first <ports> block. Nothing was concluded from it.' }
        : {}),
    }
  }
  if (format === 'nmap-grep') {
    const rows = parseNmapGrep(content)
    const surfaces = surfacesFromGrep(rows)
    return {
      log,
      format,
      findings: surfaces.map((surface) => assessNmapSurface(surface, log)),
      observed: `${rows.length} port row(s), ${rows.filter((row) => row.state === 'open').length} open`,
    }
  }
  if (format === 'nuclei-jsonl') {
    const findings = parseNucleiJsonl(content)
    return {
      log,
      format,
      findings: assessNucleiLog(findings, log),
      observed: `${findings.length} template match(es) across ${new Set(findings.map((f) => f.templateId)).size} template(s)`,
      ...(findings.length === 0 ? { note: 'The log parsed as nuclei JSONL but no complete template match survived — an interrupted run leaves truncated lines that are skipped rather than guessed at.' } : {}),
    }
  }
  return {
    log,
    format,
    findings: [],
    observed: 'nothing recognised',
    note: 'This log is not a recognised scan format (nmap -oX XML, plain nmap output, or nuclei -jsonl). No findings were produced. Use read_file on the log to read it directly rather than treating it as evidence of anything.',
  }
}

// ----------------------------------------------------------------- path ----

/**
 * Resolve a caller-supplied log reference to a path that must sit inside the
 * engagement's recon/ folder.
 *
 * Same rule as `resolveEvidencePath` in findings.ts, and for the same reason:
 * the `log` argument is model-supplied, so `../../.ssh/id_rsa` or a bare
 * absolute path would otherwise turn a read-only triage tool into a way to
 * quote arbitrary files back as scan evidence. A leading `recon/` is stripped
 * first, so a recon/-relative reference and a bare filename are the same thing.
 */
export function resolveReconLogPath(dir: string, reference: string): string {
  const reconDir = resolve(join(dir, 'recon'))
  const raw = reference.trim().replace(/^recon[\\/]/i, '')
  if (raw.length === 0) throw new Error('log must be a non-empty recon/-relative filename')
  if (raw.includes('\0')) throw new Error('log contains an invalid character')
  const resolved = isAbsolute(raw) ? resolve(raw) : resolve(join(reconDir, raw))
  const rel = relative(reconDir, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`log "${reference}" is outside the engagement's recon/ folder — triage reads saved recon output and nothing else`)
  }
  return resolved
}

/** Every readable file in recon/, dotfiles excluded so `.gitkeep` is not offered as a log. */
export function listReconLogs(dir: string): string[] {
  const reconDir = join(dir, 'recon')
  if (!existsSync(reconDir)) return []
  try {
    return readdirSync(reconDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** What an unqualified call triages: the `.log` files, or everything if a run saved something else. */
export function defaultReconLogs(dir: string): string[] {
  const all = listReconLogs(dir)
  const logs = all.filter((name) => name.toLowerCase().endsWith('.log'))
  return logs.length > 0 ? logs : all
}

// --------------------------------------------------------------- report ----

function readLog(path: string, log: string): TriageLogResult | string {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return `${log} could not be read — it is no longer on disk.`
  }
  if (size > MAX_LOG_BYTES) {
    return `recon/${log} is ${Math.round(size / 1024 / 1024)} MB, above the ${MAX_LOG_BYTES / 1024 / 1024} MB this tool reads. No findings were produced from it — re-run the scan with a narrower port range or parse it in narrower passes.`
  }
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    return `recon/${log} could not be read.`
  }
  return triageLogContent(content, log)
}

export function formatTriageReport(slug: string, results: Array<TriageLogResult | string>, skipped: number): string {
  const logs = results.filter((entry): entry is TriageLogResult => typeof entry !== 'string')
  const lines: string[] = [
    '=== Security triage (read-only) ===',
    `Engagement: ${slug}`,
    `Logs read: ${logs.length}${skipped > 0 ? ` (${skipped} more in recon/ were not read — pass "log" to triage one of them)` : ''}`,
    'Nothing was executed and nothing was written. Every line below is parsed from the log it names.',
    '',
  ]

  for (const result of logs) {
    lines.push(`--- recon/${result.log} ---`)
    lines.push(`Format detected: ${FORMAT_LABEL[result.format]}`)
    lines.push(`Observed: ${result.observed}`)
    lines.push('')
    if (result.note) lines.push(result.note)
    if (result.findings.length > 0) {
      for (const finding of result.findings.slice(0, MAX_FINDINGS_PER_LOG)) {
        lines.push(`  [${finding.severity.toUpperCase()}] ${finding.title} — risk ${finding.risk.score}/100 (${finding.risk.level}, confidence ${Math.round(finding.risk.confidence * 100)}%)`)
        lines.push(`    ${finding.description}`)
        for (const evidence of finding.evidence) lines.push(`    evidence: ${formatEvidence(evidence)}`)
        // The risk model promises every point is explainable; the model reading
        // this report has to be able to check that promise rather than take the
        // number on trust, which is the difference between triage and a verdict.
        for (const line of finding.risk.explanation) lines.push(`    risk: ${line}`)
      }
      if (result.findings.length > MAX_FINDINGS_PER_LOG) {
        lines.push(`    (+${result.findings.length - MAX_FINDINGS_PER_LOG} further finding(s) omitted; the summary below carries the totals.)`)
      }
    } else if (!result.note) {
      lines.push('  No findings: the log parsed cleanly and recorded nothing to report.')
    }
    lines.push('')
  }

  for (const entry of results) {
    if (typeof entry === 'string') {
      lines.push(`--- ${entry}`)
      lines.push('')
    }
  }

  lines.push('--- Summary (machine-readable) ---')
  lines.push(
    JSON.stringify({
      tool: 'security_triage',
      engagement: slug,
      logs: logs.map((result) => ({
        log: result.log,
        format: result.format,
        observed: result.observed,
        findingCount: result.findings.length,
        ...(result.note ? { note: result.note } : {}),
        findings: result.findings.slice(0, MAX_FINDINGS_PER_LOG).map((finding) => ({
          title: finding.title,
          severity: finding.severity,
          risk: { score: finding.risk.score, level: finding.risk.level, confidence: finding.risk.confidence },
        })),
      })),
    }),
  )

  // A backstop over the whole report: every log-derived string was already
  // scrubbed where it was built, and a single pass here means a value that
  // reached the report by some route the parsers do not own still cannot ship.
  return redactSecrets(lines.join('\n'))
}

// ----------------------------------------------------------------- tool ----

export async function runSecurityTriage(input: Record<string, unknown>, ctx: TriageContext): Promise<string> {
  const engagement = input.engagement
  if (typeof engagement !== 'string' || engagement.trim().length === 0) {
    throw new Error('engagement must be a non-empty string')
  }
  const slug = engagement.trim()
  const dir = engagementDir(slug, ctx.engagementRoot)
  if (!existsSync(join(dir, 'SCOPE.md'))) {
    return `No engagement "${slug}" found (missing ${join(dir, 'SCOPE.md')}). Run new_engagement first — triage reads an engagement's saved recon output.`
  }

  const available = listReconLogs(dir)
  if (available.length === 0) {
    return `No recon output saved for "${slug}" yet (${join(dir, 'recon')} is empty). Run run_security_tool or http_probe first — triage reads saved logs and runs nothing itself.`
  }

  let targets: Array<{ log: string; path: string }>
  const named = optionalString(input.log, 'log')
  if (named === undefined) {
    targets = defaultReconLogs(dir)
      .slice(0, MAX_LOGS_PER_CALL)
      .map((log) => ({ log, path: resolve(join(dir, 'recon', log)) }))
  } else {
    const resolved = resolveReconLogPath(dir, named)
    if (!existsSync(resolved)) {
      return `recon/${named} does not exist in engagement "${slug}". Available logs: ${available.slice(0, MAX_LISTED_LOGS).join(', ')}${available.length > MAX_LISTED_LOGS ? ` (+${available.length - MAX_LISTED_LOGS} more)` : ''}`
    }
    targets = [{ log: relative(resolve(join(dir, 'recon')), resolved).replace(/\\/g, '/'), path: resolved }]
  }

  const results: Array<TriageLogResult | string> = []
  for (const target of targets) {
    // Re-checked at read time: a log removed between the listing and the read
    // is reported, not thrown, so a triage sweep survives a rotating directory.
    if (!existsSync(target.path)) {
      results.push(`recon/${target.log} is no longer on disk — nothing was read from it.`)
      continue
    }
    results.push(readLog(target.path, target.log))
  }

  return formatTriageReport(slug, results, Math.max(0, available.length - targets.length))
}

export const securityTriageTool: Tool = {
  name: 'security_triage',
  description:
    'Read a saved recon log from an engagement and return structured findings instead of raw tool output. Recognises nmap -oX XML, plain nmap text output, and nuclei -jsonl, and reports hosts, open vs closed ports, service versions, OS guesses, and template matches — each with a 0-100 risk score and evidence pointing back at the log. Run it after run_security_tool or http_probe, because those tools return only a clamped excerpt of a log that is often far larger; reasoning over that excerpt is what produces invented ports and CVEs. Pass no "log" to triage every saved log, or a recon/-relative filename for one. Read-only: it runs no scan, writes nothing, cannot leave the engagement\'s recon/ folder, and reports a log it cannot recognise as unrecognised rather than inventing findings from it.',
  input_schema: {
    type: 'object',
    properties: {
      engagement: { type: 'string', description: 'The engagement slug (from new_engagement)' },
      log: { type: 'string', description: 'recon/-relative log filename, e.g. "1699-nmap-full.log". Omit to triage every log in recon/.' },
    },
    required: ['engagement'],
  },
  async execute(input) {
    return runSecurityTriage(input, { engagementRoot: paths.workspace })
  },
}
