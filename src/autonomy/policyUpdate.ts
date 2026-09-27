import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EliaPolicy } from './policy.ts'
import { loadPolicy } from './policy.ts'
import { withFileLock } from '../fileLock.ts'
import { writeSecureFile } from '../securePersistence.ts'

type RecordValue = Record<string, unknown>
type Risk = 'safe' | 'review' | 'critical'
type ApprovalMode = 'auto' | 'always' | 'never'

type BoundaryName = 'governor' | 'approval' | 'preauth' | 'valueCore' | 'gate' | 'benchmark' | 'network' | 'file'
type ListKind = 'deny' | 'allow'

type BooleanDirection = 'mustStayOrIncrease' | 'mustStayOrDecrease' | 'custom'
type NumberDirection = 'lower' | 'higher' | 'custom'

const BASE_POLICY: EliaPolicy = {
  denyTools: [],
  denyIntents: [],
  denyCommandPatterns: [],
  requireApprovalAtOrAbove: 'critical',
}

const MAX_REASON_LENGTH = 2_000
const MAX_LIST_ITEMS = 200
const MAX_TEXT_LENGTH = 500
const MAX_POLICY_BYTES = 256_000
const MAX_POLICY_DEPTH = 16
const MAX_POLICY_KEYS = 200
const MAX_POLICY_ARRAY_ITEMS = 500

const BOUNDARY_NAMES = new Set<BoundaryName>(['governor', 'approval', 'preauth', 'valueCore', 'gate', 'benchmark', 'network', 'file'])
const LIST_FIELDS = new Set(['denyTools', 'denyIntents', 'denyCommandPatterns'])
const ALLOWLIST_FIELDS = new Set(['allowedPaths', 'allowedHosts', 'allowlist', 'allowed', 'allowedDomains', 'allowedFiles', 'allowed_paths', 'allowed_hosts', 'allowed_domains', 'allowed_files'])
const DENYLIST_FIELDS = new Set(['deniedPaths', 'deniedHosts', 'denylist', 'denied', 'blocked', 'blockedPaths', 'blockedHosts', 'denied_paths', 'denied_hosts', 'blocked_paths', 'blocked_hosts'])
const POSITIVE_BOOLEAN_FIELDS = new Set([
  'enabled',
  'enforced',
  'required',
  'failClosed',
  'blockUnapproved',
  'requireApproval',
  'requireExplicitApproval',
  'requireValueCore',
  'requireGate',
  'requireBenchmark',
  'requireNetworkBoundary',
  'requireFileBoundary',
  'preventBypass',
  'restrictToWorkspace',
])
const NEGATIVE_BOOLEAN_FIELDS = new Set([
  'allowBypass',
  'allowPreauth',
  'allowNetwork',
  'allowOutsideWorkspace',
  'allowSymlinks',
  'allowExternalFiles',
  'allowRemoteAccess',
  'allowExternalNetwork',
  'allowUnapproved',
])
const LOWER_NUMBER_FIELDS = new Set(['maxbytes', 'maxfiles', 'maxdepth', 'maxhosts', 'maxentries', 'maxlength', 'maxsize', 'ttlms', 'timeoutms', 'limit'])
const HIGHER_NUMBER_FIELDS = new Set(['minimum', 'minimumscore', 'minscore', 'minsamples', 'mincoverage', 'threshold', 'requiredscore', 'requiredcoverage'])
const SCOPE_VALUES = new Set(['closed', 'strict', 'workspace', 'deny', 'allowlist', 'explicit', 'always', 'never'])
const BOUNDARY_FIELD_ALIASES: Record<string, string> = {
  allowed_paths: 'allowedPaths',
  allowed_hosts: 'allowedHosts',
  allowed_domains: 'allowedDomains',
  allowed_files: 'allowedFiles',
  denied_paths: 'deniedPaths',
  denied_hosts: 'deniedHosts',
  blocked_paths: 'blockedPaths',
  blocked_hosts: 'blockedHosts',
  fail_closed: 'failClosed',
  block_unapproved: 'blockUnapproved',
  require_approval: 'requireApproval',
  require_explicit_approval: 'requireExplicitApproval',
  require_value_core: 'requireValueCore',
  require_gate: 'requireGate',
  require_benchmark: 'requireBenchmark',
  require_network_boundary: 'requireNetworkBoundary',
  require_file_boundary: 'requireFileBoundary',
  prevent_bypass: 'preventBypass',
  restrict_to_workspace: 'restrictToWorkspace',
  allow_bypass: 'allowBypass',
  allow_preauth: 'allowPreauth',
  allow_network: 'allowNetwork',
  allow_outside_workspace: 'allowOutsideWorkspace',
  allow_symlinks: 'allowSymlinks',
  allow_external_files: 'allowExternalFiles',
  allow_remote_access: 'allowRemoteAccess',
  allow_external_network: 'allowExternalNetwork',
  allow_unapproved: 'allowUnapproved',
  max_bytes: 'maxBytes',
  max_files: 'maxFiles',
  max_depth: 'maxDepth',
  max_hosts: 'maxHosts',
  max_entries: 'maxEntries',
  max_length: 'maxLength',
  max_size: 'maxSize',
  ttl_ms: 'ttlMs',
  timeout_ms: 'timeoutMs',
  minimum_score: 'minimumScore',
  min_score: 'minScore',
  min_samples: 'minSamples',
  min_coverage: 'minCoverage',
  required_score: 'requiredScore',
  required_coverage: 'requiredCoverage',
  approval_mode: 'approvalMode',
  network_policy: 'networkPolicy',
  file_policy: 'filePolicy',
}

export interface PolicyUpdateRequest {
  changes: unknown
  reason: string
  approval?: unknown
  approved?: unknown
  actor?: unknown
  approvalMode?: unknown
  approval_mode?: unknown
  cwd?: unknown
  persist?: unknown
}

export interface PolicyUpdateOptions {
  cwd?: string
  approval?: unknown
  approved?: unknown
  actor?: unknown
  approvalMode?: unknown
  approval_mode?: unknown
  persist?: boolean
}

export interface PolicyUpdateResult {
  ok: true
  changed: boolean
  tightened: boolean
  written: boolean
  rejected: false
  reason: string
  path: string
  previous: RecordValue
  policy: RecordValue
  approvalRequired: boolean
  approvalProvided: boolean
  approvalMode: ApprovalMode
}

export class PolicyUpdateError extends Error {
  readonly code: string
  readonly rejected = true

  constructor(message: string, code = 'POLICY_UPDATE_REJECTED') {
    super(message)
    this.name = 'PolicyUpdateError'
    this.code = code
  }
}

interface Invocation {
  cwd: string
  changes: unknown
  reason: string
  approval: unknown
  approved: unknown
  actor: unknown
  approvalMode: unknown
  approvalModeSnake: unknown
  persist: boolean
}

interface BoundaryField {
  boundary: BoundaryName
  field?: string
}

interface Operation {
  field: string
  operation: 'set' | 'add' | 'remove'
  value: unknown
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function reject(message: string, code = 'POLICY_UPDATE_REJECTED'): never {
  throw new PolicyUpdateError(message, code)
}

function readStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) reject(`Policy field "${field}" must be an array of at most ${MAX_LIST_ITEMS} strings.`)
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_TEXT_LENGTH) reject(`Policy field "${field}" must contain non-empty bounded strings.`)
    result.push(item)
  }
  return [...new Set(result)]
}

function validateKnownPolicy(document: RecordValue, path: string): EliaPolicy {
  const denyTools = own(document, 'denyTools') ? readStringList(document.denyTools, 'denyTools') : [...BASE_POLICY.denyTools]
  const denyIntents = own(document, 'denyIntents') ? readStringList(document.denyIntents, 'denyIntents') : [...BASE_POLICY.denyIntents]
  const denyCommandPatterns = own(document, 'denyCommandPatterns') ? readStringList(document.denyCommandPatterns, 'denyCommandPatterns') : [...BASE_POLICY.denyCommandPatterns]
  for (const pattern of denyCommandPatterns) {
    try {
      new RegExp(pattern, 'i')
    } catch {
      reject(`Policy field "denyCommandPatterns" contains an invalid regular expression in ${path}.`, 'MALFORMED_POLICY')
    }
  }
  const risk = own(document, 'requireApprovalAtOrAbove') ? document.requireApprovalAtOrAbove : BASE_POLICY.requireApprovalAtOrAbove
  if (risk !== 'safe' && risk !== 'review' && risk !== 'critical') reject(`Policy field "requireApprovalAtOrAbove" is invalid in ${path}.`, 'MALFORMED_POLICY')
  return { denyTools, denyIntents, denyCommandPatterns, requireApprovalAtOrAbove: risk }
}

function policyStorePath(cwd: string): string {
  let project: string
  try {
    project = realpathSync.native(resolve(cwd))
  } catch (error) {
    reject(`Policy project directory could not be resolved: ${error instanceof Error ? error.message : String(error)}`, 'MALFORMED_POLICY')
  }
  const state = resolve(cwd, '.elia')
  let realState = join(project, '.elia')
  if (existsSync(state)) {
    try {
      const stat = lstatSync(state)
      if (!stat.isDirectory() || stat.isSymbolicLink()) reject('The .elia policy directory must be a regular, non-symlink directory.', 'MALFORMED_POLICY')
      realState = realpathSync.native(state)
    } catch (error) {
      if (error instanceof PolicyUpdateError) throw error
      reject('The .elia policy directory could not be inspected.', 'MALFORMED_POLICY')
    }
  }
  const stateRelative = relative(project, realState)
  if (stateRelative.startsWith('..') || isAbsolute(stateRelative)) reject('The .elia policy directory must remain inside the project.', 'MALFORMED_POLICY')
  return join(realState, 'policy.json')
}

function readCurrent(cwd: string, path: string): { path: string; document: RecordValue; exists: boolean; known: EliaPolicy } {
  if (!existsSync(path)) {
    return { path, document: { ...BASE_POLICY }, exists: false, known: { ...BASE_POLICY } }
  }
  try {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink()) {
      reject(`Policy at ${path} must be a regular, non-symlink file.`, 'MALFORMED_POLICY')
    }
    if (statSync(path).size > MAX_POLICY_BYTES) {
      reject(`Policy at ${path} exceeds the ${MAX_POLICY_BYTES}-byte limit.`, 'POLICY_TOO_LARGE')
    }
  } catch (error) {
    if (error instanceof PolicyUpdateError) throw error
    reject(`Policy at ${path} could not be inspected: ${error instanceof Error ? error.message : String(error)}`, 'MALFORMED_POLICY')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    reject(`Policy at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'MALFORMED_POLICY')
  }
  if (!isRecord(parsed)) reject(`Policy at ${path} must be a JSON object.`, 'MALFORMED_POLICY')
  try {
    loadPolicy(cwd)
  } catch (error) {
    reject(error instanceof Error ? error.message : String(error), 'MALFORMED_POLICY')
  }
  return { path, document: parsed, exists: true, known: validateKnownPolicy(parsed, path) }
}

function normalizeMode(value: unknown): ApprovalMode | undefined {
  if (value === undefined) return undefined
  if (value === 'auto' || value === 'always' || value === 'never') return value
  reject('approval mode must be "auto", "always", or "never".', 'MALFORMED_APPROVAL')
}

function parseInvocation(first: unknown, second?: unknown, third?: unknown, fourth?: unknown): Invocation {
  if (isRecord(first) && own(first, 'changes') && typeof second === 'string') {
    const options = isRecord(third) ? third : undefined
    return invocationFromRecord({
      cwd: typeof first.cwd === 'string' ? first.cwd : typeof options?.cwd === 'string' ? options.cwd : process.cwd(),
      changes: first.changes,
      reason: second,
      approval: options?.approval ?? first.approval ?? fourth,
      approved: options?.approved ?? first.approved,
      actor: options?.actor ?? first.actor,
      approvalMode: options?.approvalMode ?? first.approvalMode,
      approval_mode: options?.approval_mode ?? first.approval_mode,
      persist: options?.persist ?? first.persist,
    })
  }
  if (isRecord(first) && own(first, 'changes') && second === undefined && typeof first.reason === 'string') {
    return invocationFromRecord({
      cwd: first.cwd,
      changes: first.changes,
      reason: first.reason,
      approval: first.approval,
      approved: first.approved,
      actor: first.actor,
      approvalMode: first.approvalMode,
      approval_mode: first.approval_mode,
      persist: first.persist,
    })
  }
  if (typeof second === 'string' && isRecord(third)) {
    const options = third
    return {
      cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
      changes: first,
      reason: second,
      approval: options.approval ?? fourth,
      approved: options.approved,
      actor: options.actor,
      approvalMode: options.approvalMode,
      approvalModeSnake: options.approval_mode,
      persist: options.persist !== false,
    }
  }
  if (typeof first === 'string' && typeof third === 'string') {
    return {
      cwd: first,
      changes: second,
      reason: third,
      approval: fourth,
      approved: undefined,
      actor: undefined,
      approvalMode: undefined,
      approvalModeSnake: undefined,
      persist: true,
    }
  }
  if (typeof first === 'string' && second === undefined && isRecord(third) && typeof third.reason === 'string') {
    return invocationFromRecord({
      cwd: first,
      changes: third.changes,
      reason: third.reason,
      approval: third.approval,
      approved: third.approved,
      actor: third.actor,
      approvalMode: third.approvalMode,
      approval_mode: third.approval_mode,
      persist: third.persist,
    })
  }
  reject('Policy update requires structured changes and a non-empty reason.', 'MALFORMED_REQUEST')
}

function invocationFromRecord(request: PolicyUpdateRequest): Invocation {
  const mode = normalizeMode(request.approvalMode)
  const snakeMode = normalizeMode(request.approval_mode)
  if (mode !== undefined && snakeMode !== undefined && mode !== snakeMode) reject('approvalMode and approval_mode disagree.', 'MALFORMED_APPROVAL')
  if (request.persist !== undefined && typeof request.persist !== 'boolean') reject('persist must be a boolean.', 'MALFORMED_REQUEST')
  return {
    cwd: typeof request.cwd === 'string' ? request.cwd : process.cwd(),
    changes: request.changes,
    reason: request.reason,
    approval: request.approval,
    approved: request.approved,
    actor: request.actor,
    approvalMode: mode ?? snakeMode,
    approvalModeSnake: snakeMode,
    persist: request.persist !== false,
  }
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') reject('Policy update reason must be a string.', 'MALFORMED_REQUEST')
  const reason = value.trim()
  if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) reject(`Policy update reason must be between 1 and ${MAX_REASON_LENGTH} characters.`, 'MALFORMED_REQUEST')
  return reason
}

function normalizeApproval(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  if (!isRecord(value)) reject('Approval must be a boolean or an explicit approval object.', 'MALFORMED_APPROVAL')
  if (own(value, 'actor') && typeof value.actor !== 'string') reject('Approval actor must be a string when supplied.', 'MALFORMED_APPROVAL')
  return value.approved === true
}

function cloneValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_POLICY_DEPTH) reject(`Policy values cannot exceed ${MAX_POLICY_DEPTH} levels.`, 'MALFORMED_POLICY')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('Policy numbers must be finite.', 'MALFORMED_POLICY')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_POLICY_ARRAY_ITEMS) reject(`Policy arrays cannot exceed ${MAX_POLICY_ARRAY_ITEMS} items.`, 'MALFORMED_POLICY')
    return value.map((item) => cloneValue(item, depth + 1))
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length > MAX_POLICY_KEYS) reject(`Policy objects cannot exceed ${MAX_POLICY_KEYS} fields.`, 'MALFORMED_POLICY')
    return Object.fromEntries(entries.map(([key, child]) => [key, cloneValue(child, depth + 1)]))
  }
  reject('Policy values must contain only JSON-compatible data.', 'MALFORMED_POLICY')
}

function cloneRecord(value: RecordValue): RecordValue {
  return cloneValue(value) as RecordValue
}

function canonicalField(value: string): string {
  const directAliases: Record<string, string> = {
    governor_enabled: 'governor.enabled',
    approval_enabled: 'approval.enabled',
    preauth_enabled: 'preauth.enabled',
    value_core_enabled: 'valueCore.enabled',
    gate_enabled: 'gate.enabled',
    benchmark_enabled: 'benchmark.enabled',
    allow_network: 'network.allowNetwork',
    allow_outside_workspace: 'file.allowOutsideWorkspace',
    allow_external_files: 'file.allowExternalFiles',
    allow_bypass: 'approval.allowBypass',
    require_approval: 'approval.required',
    require_approval_explicit: 'approval.required',
    require_explicit_approval: 'approval.required',
  }
  const trimmed = value.trim()
  const aliased = directAliases[trimmed.toLowerCase()] ?? trimmed.replace(/^policy\./i, '')
  const aliases: Record<string, string> = {
    deny_tools: 'denyTools',
    deny_intents: 'denyIntents',
    deny_command_patterns: 'denyCommandPatterns',
    require_approval_at_or_above: 'requireApprovalAtOrAbove',
    pre_authorization: 'preauth',
    preauthorization: 'preauth',
    value_core: 'valueCore',
    valuecore: 'valueCore',
    file_boundary: 'file',
    network_boundary: 'network',
  }
  const segments = aliased.split('.')
  if (segments.some((segment) => segment.length === 0)) return ''
  return segments.map((segment) => {
    const normalized = segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    return aliases[normalized] ?? normalized
  }).join('.')
}

function boundaryField(value: string): BoundaryField | undefined {
  const canonical = canonicalField(value)
  const direct = ['governor', 'approval', 'preauth', 'valueCore', 'gate', 'benchmark', 'network', 'file'] as const
  for (const name of direct) {
    if (canonical === name) return { boundary: name }
    if (canonical.startsWith(`${name}.`)) return { boundary: name, field: canonical.slice(name.length + 1) }
  }
  return undefined
}

function fieldName(value: string): string {
  const canonical = canonicalField(value)
  if (LIST_FIELDS.has(canonical) || canonical === 'requireApprovalAtOrAbove') return canonical
  const boundary = boundaryField(canonical)
  if (boundary) {
    if (boundary.field === undefined) return boundary.boundary
    return `${boundary.boundary}.${boundary.field}`
  }
  return canonical
}

function operationFrom(value: unknown): Operation {
  if (!isRecord(value)) reject('Each policy operation must be an object with a field and value.', 'MALFORMED_CHANGE')
  const rawField = value.field ?? value.path ?? value.key
  if (typeof rawField !== 'string' || rawField.length === 0 || rawField.length > MAX_TEXT_LENGTH) reject('Policy operation has an invalid field.', 'MALFORMED_CHANGE')
  const rawOperation = value.operation ?? value.op ?? value.action ?? 'set'
  if (typeof rawOperation !== 'string') reject('Policy operation must be a string.', 'MALFORMED_CHANGE')
  const operation = rawOperation.toLowerCase()
  const normalized = operation === 'append' ? 'add' : operation === 'delete' ? 'remove' : operation === 'replace' || operation === 'update' ? 'set' : operation
  if (normalized !== 'set' && normalized !== 'add' && normalized !== 'remove') reject(`Unknown policy operation "${rawOperation}".`, 'UNKNOWN_CHANGE')
  if (!own(value, 'value') && !own(value, 'values')) reject('Policy operation requires a value.', 'MALFORMED_CHANGE')
  return { field: rawField, operation: normalized, value: own(value, 'value') ? value.value : value.values }
}

function listValue(value: unknown, field: string): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) reject(`Policy field "${field}" requires a string or string array.`, 'MALFORMED_CHANGE')
  return readStringList(value, field)
}

function mergeList(currentValue: unknown, requested: unknown, field: string, kind: ListKind, operation: 'set' | 'add' | 'remove'): string[] {
  const current = listValue(currentValue ?? [], field)
  const values = listValue(requested, field)
  if (field === 'denyCommandPatterns') {
    for (const pattern of values) {
      try {
        new RegExp(pattern, 'i')
      } catch {
        reject(`Policy field "${field}" contains an invalid regular expression.`, 'MALFORMED_CHANGE')
      }
    }
  }
  if (kind === 'deny') {
    if (operation === 'remove') reject(`Policy field "${field}" cannot remove an existing restriction.`, 'POLICY_WEAKENING')
    return [...new Set(operation === 'set' ? values : current.concat(values))]
  }
  if (kind === 'allow') {
    const desired = operation === 'add' ? current.concat(values) : values
    if (current.some((item) => !desired.includes(item))) reject(`Policy field "${field}" cannot expand its allowlist.`, 'POLICY_WEAKENING')
    return [...new Set(desired)]
  }
  return [...new Set(current.concat(values))]
}

function matchesBoundaryField(fields: ReadonlySet<string>, field: string): boolean {
  const normalized = field.replace(/[^a-z]/gi, '').toLowerCase()
  for (const candidate of fields) {
    if (candidate.replace(/[^a-z]/gi, '').toLowerCase() === normalized) return true
  }
  return false
}

function booleanDirection(field: string): BooleanDirection {
  if (matchesBoundaryField(POSITIVE_BOOLEAN_FIELDS, field)) return 'mustStayOrIncrease'
  if (matchesBoundaryField(NEGATIVE_BOOLEAN_FIELDS, field)) return 'mustStayOrDecrease'
  return 'custom'
}

function numberDirection(field: string): NumberDirection {
  const normalized = field.replace(/[^a-z]/g, '').toLowerCase()
  if (LOWER_NUMBER_FIELDS.has(normalized)) return 'lower'
  if (HIGHER_NUMBER_FIELDS.has(normalized)) return 'higher'
  return 'custom'
}

function effectiveBoolean(current: RecordValue, field: string): boolean {
  if (own(current, field)) return current[field] === true
  if (matchesBoundaryField(NEGATIVE_BOOLEAN_FIELDS, field)) return false
  return true
}

function effectiveList(current: RecordValue, field: string): string[] {
  return Array.isArray(current[field]) ? current[field].filter((value): value is string => typeof value === 'string') : []
}

function effectiveNumber(current: RecordValue, field: string): number | undefined {
  const value = current[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function applyBoolean(current: RecordValue, field: string, requested: unknown): boolean {
  if (typeof requested !== 'boolean') reject(`Boundary field "${field}" must be boolean.`, 'MALFORMED_CHANGE')
  const before = effectiveBoolean(current, field)
  const direction = booleanDirection(field)
  if (direction === 'mustStayOrIncrease' && before && !requested) reject(`Boundary field "${field}" cannot be disabled.`, 'POLICY_WEAKENING')
  if (direction === 'mustStayOrDecrease' && !before && requested) reject(`Boundary field "${field}" cannot be enabled.`, 'POLICY_WEAKENING')
  if (direction === 'custom' && before !== requested) reject(`Boundary field "${field}" has no provable tightening direction.`, 'UNKNOWN_CHANGE')
  return requested
}

function applyNumber(current: RecordValue, field: string, requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) reject(`Boundary field "${field}" must be a finite non-negative number.`, 'MALFORMED_CHANGE')
  const before = effectiveNumber(current, field)
  const direction = numberDirection(field)
  if (before !== undefined && direction === 'lower' && requested > before) reject(`Boundary field "${field}" cannot be loosened.`, 'POLICY_WEAKENING')
  if (before !== undefined && direction === 'higher' && requested < before) reject(`Boundary field "${field}" cannot be loosened.`, 'POLICY_WEAKENING')
  if (before !== undefined && direction === 'custom' && requested !== before) reject(`Boundary field "${field}" has no provable tightening direction.`, 'UNKNOWN_CHANGE')
  return requested
}

function applyString(current: RecordValue, field: string, requested: unknown): string {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > MAX_TEXT_LENGTH) reject(`Boundary field "${field}" must be a bounded string.`, 'MALFORMED_CHANGE')
  const normalized = requested.toLowerCase()
  if (!SCOPE_VALUES.has(normalized)) reject(`Boundary field "${field}" has an unknown value.`, 'UNKNOWN_CHANGE')
  const before = typeof current[field] === 'string' ? current[field].toLowerCase() : undefined
  if (before === undefined || before === normalized) return requested
  const rank: Record<string, number> = { never: 0, explicit: 1, allowlist: 2, deny: 3, always: 4, strict: 4, workspace: 5, closed: 6 }
  if ((rank[normalized] ?? -1) <= (rank[before] ?? -1)) reject(`Boundary field "${field}" cannot be loosened.`, 'POLICY_WEAKENING')
  return requested
}

function applyBoundaryField(current: RecordValue, rawField: string, requested: unknown): void {
  const field = BOUNDARY_FIELD_ALIASES[rawField] ?? rawField
  const normalized = field.replace(/[^a-zA-Z]/g, '')
  const lower = normalized.toLowerCase()
  if (ALLOWLIST_FIELDS.has(field) || ALLOWLIST_FIELDS.has(lower)) {
    current[field] = mergeList(effectiveList(current, field), requested, field, 'allow', 'set')
    return
  }
  if (DENYLIST_FIELDS.has(field) || DENYLIST_FIELDS.has(lower)) {
    current[field] = mergeList(effectiveList(current, field), requested, field, 'deny', 'set')
    return
  }
  if (lower === 'allow' || lower === 'allowlist' || lower === 'allowed') {
    if (typeof requested === 'boolean') {
      current[field] = applyBoolean(current, field, requested)
      return
    }
    current[field] = mergeList(effectiveList(current, field), requested, field, 'allow', 'set')
    return
  }
  if (lower === 'deny' || lower === 'denylist' || lower === 'denied' || lower === 'blocked') {
    if (typeof requested === 'boolean') {
      current[field] = applyBoolean(current, 'required', requested)
      return
    }
    current[field] = mergeList(effectiveList(current, field), requested, field, 'deny', 'set')
    return
  }
  if (lower === 'enabled' || lower === 'enforced' || lower === 'required' || lower === 'failclosed' || lower === 'blockunapproved' || lower === 'requireapproval' || lower === 'requireexplicitapproval' || lower === 'requirevaluecore' || lower === 'requiregate' || lower === 'requirebenchmark' || lower === 'requirenetworkboundary' || lower === 'requirefileboundary' || lower === 'preventbypass' || lower === 'restricttoworkspace' || matchesBoundaryField(NEGATIVE_BOOLEAN_FIELDS, field)) {
    current[field] = applyBoolean(current, field, requested)
    return
  }
  if (lower.startsWith('max') || lower.startsWith('min') || lower === 'threshold' || lower === 'ttlms' || lower === 'timeoutms' || lower === 'limit') {
    current[field] = applyNumber(current, field, requested)
    return
  }
  if (lower === 'mode' || lower === 'scope' || lower === 'approvalmode' || lower === 'networkpolicy' || lower === 'filepolicy') {
    current[field] = applyString(current, field, requested)
    return
  }
  reject(`Unknown boundary field "${field}".`, 'UNKNOWN_CHANGE')
}

function applyBoundaryObject(candidate: RecordValue, boundary: BoundaryName, requested: unknown): void {
  const currentValue = candidate[boundary]
  if (currentValue !== undefined && !isRecord(currentValue)) reject(`Policy boundary "${boundary}" must be an object.`, 'MALFORMED_POLICY')
  const current: RecordValue = isRecord(currentValue) ? cloneRecord(currentValue) : {}
  if (typeof requested === 'boolean') {
    applyBoundaryField(current, 'enabled', requested)
  } else if (!isRecord(requested)) {
    reject(`Policy boundary "${boundary}" requires an object or boolean.`, 'MALFORMED_CHANGE')
  } else {
    for (const [key, value] of Object.entries(requested)) applyBoundaryField(current, key, value)
  }
  candidate[boundary] = current
}

function applyRisk(candidate: RecordValue, value: unknown, operation: 'set' | 'add' | 'remove'): void {
  if (operation !== 'set') reject('requireApprovalAtOrAbove only supports set.', 'MALFORMED_CHANGE')
  if (value !== 'safe' && value !== 'review' && value !== 'critical') reject('requireApprovalAtOrAbove must be safe, review, or critical.', 'MALFORMED_CHANGE')
  const current = candidate.requireApprovalAtOrAbove
  const order: Record<Risk, number> = { safe: 0, review: 1, critical: 2 }
  if (typeof current === 'string' && order[value] > order[current as Risk]) reject('Policy cannot raise the approval threshold.', 'POLICY_WEAKENING')
  candidate.requireApprovalAtOrAbove = value
}

function applyField(candidate: RecordValue, rawField: string, requested: unknown, operation: 'set' | 'add' | 'remove' = 'set'): void {
  const field = fieldName(rawField)
  if (LIST_FIELDS.has(field)) {
    const kind: ListKind = 'deny'
    if (operation === 'remove') {
      candidate[field] = mergeList(candidate[field], requested, field, kind, 'remove')
    } else {
      candidate[field] = mergeList(candidate[field], requested, field, kind, operation)
    }
    return
  }
  if (field === 'requireApprovalAtOrAbove') {
    applyRisk(candidate, requested, operation)
    return
  }
  const boundary = boundaryField(field)
  if (boundary) {
    if (operation !== 'set') reject(`Boundary field "${field}" only supports set operations.`, 'MALFORMED_CHANGE')
    if (boundary.field === undefined) {
      applyBoundaryObject(candidate, boundary.boundary, requested)
      return
    }
    const currentValue = candidate[boundary.boundary]
    const current: RecordValue = isRecord(currentValue) ? cloneRecord(currentValue) : {}
    applyBoundaryField(current, boundary.field, requested)
    candidate[boundary.boundary] = current
    return
  }
  reject(`Unknown policy field "${rawField}".`, 'UNKNOWN_CHANGE')
}

function applyOperation(candidate: RecordValue, value: unknown): void {
  const operation = operationFrom(value)
  applyField(candidate, operation.field, operation.value, operation.operation)
}

function applyChanges(current: RecordValue, changes: unknown): RecordValue {
  const candidate = cloneRecord(current)
  if (Array.isArray(changes)) {
    if (changes.length === 0) reject('Policy changes cannot be empty.', 'MALFORMED_CHANGE')
    for (const operation of changes) applyOperation(candidate, operation)
    return candidate
  }
  if (!isRecord(changes)) reject('Policy changes must be an object or operation array.', 'MALFORMED_CHANGE')
  if (own(changes, 'operations') || own(changes, 'updates')) {
    const keys = Object.keys(changes)
    if (keys.some((key) => key !== 'operations' && key !== 'updates')) reject('Policy operation envelope contains unknown fields.', 'UNKNOWN_CHANGE')
    const operations = own(changes, 'operations') ? changes.operations : changes.updates
    if (!Array.isArray(operations) || operations.length === 0) reject('Policy operation envelope requires a non-empty array.', 'MALFORMED_CHANGE')
    for (const operation of operations) applyOperation(candidate, operation)
    return candidate
  }
  if (own(changes, 'changes') && Object.keys(changes).length === 1) return applyChanges(current, changes.changes)
  for (const [key, value] of Object.entries(changes)) applyField(candidate, key, value)
  return candidate
}

function assertNoWeakening(current: RecordValue, candidate: RecordValue): void {
  const currentKnown = validateKnownPolicy(current, 'current policy')
  const candidateKnown = validateKnownPolicy(candidate, 'updated policy')
  for (const field of ['denyTools', 'denyIntents', 'denyCommandPatterns'] as const) {
    if (currentKnown[field].some((value) => !candidateKnown[field].includes(value))) reject(`Policy field "${field}" cannot remove an existing restriction.`, 'POLICY_WEAKENING')
  }
  const order: Record<Risk, number> = { safe: 0, review: 1, critical: 2 }
  if (order[candidateKnown.requireApprovalAtOrAbove] > order[currentKnown.requireApprovalAtOrAbove]) reject('Policy cannot raise the approval threshold.', 'POLICY_WEAKENING')
  for (const boundary of BOUNDARY_NAMES) {
    const before = current[boundary]
    if (before === undefined) continue
    if (!isRecord(before) || !isRecord(candidate[boundary])) reject(`Policy boundary "${boundary}" cannot be removed.`, 'POLICY_WEAKENING')
    for (const [key, value] of Object.entries(before)) {
      if (!own(candidate[boundary] as RecordValue, key)) reject(`Policy boundary "${boundary}.${key}" cannot be removed.`, 'POLICY_WEAKENING')
      if (typeof value === 'boolean' && typeof (candidate[boundary] as RecordValue)[key] === 'boolean' && value !== (candidate[boundary] as RecordValue)[key]) {
        const testCurrent: RecordValue = { [key]: value }
        applyBoundaryField(testCurrent, key, (candidate[boundary] as RecordValue)[key])
      }
    }
  }
}

function approvalModeOf(invocation: Invocation): ApprovalMode {
  const camel = normalizeMode(invocation.approvalMode)
  const snake = normalizeMode(invocation.approvalModeSnake)
  if (camel !== undefined && snake !== undefined && camel !== snake) reject('approvalMode and approval_mode disagree.', 'MALFORMED_APPROVAL')
  return camel ?? snake ?? 'auto'
}

function requireExplicitApproval(invocation: Invocation, mode: ApprovalMode, changed: boolean): boolean {
  const approved = invocation.approved !== undefined ? normalizeApproval(invocation.approved) : invocation.approval !== undefined ? normalizeApproval(invocation.approval) : false
  if (invocation.approved !== undefined && invocation.approval !== undefined && normalizeApproval(invocation.approved) !== normalizeApproval(invocation.approval)) reject('approved and approval disagree.', 'MALFORMED_APPROVAL')
  if (invocation.actor !== undefined && typeof invocation.actor !== 'string') reject('approval actor must be a string.', 'MALFORMED_APPROVAL')
  if (mode === 'never') reject('Policy updates are unavailable when approval_mode is never.', 'APPROVAL_REQUIRED')
  if (changed && !approved) reject('Policy tightening requires explicit approval.', 'APPROVAL_REQUIRED')
  return approved
}

function writePolicy(path: string, policy: RecordValue): void {
  const content = `${JSON.stringify(policy, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_POLICY_BYTES) reject(`Updated policy exceeds the ${MAX_POLICY_BYTES}-byte limit.`, 'POLICY_TOO_LARGE')
  writeSecureFile(path, content)
}

function documentsEqual(left: RecordValue, right: RecordValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function updatePolicy(changes: unknown, reason: string, options?: PolicyUpdateOptions): PolicyUpdateResult
export function updatePolicy(request: PolicyUpdateRequest): PolicyUpdateResult
export function updatePolicy(cwd: string, changes: unknown, reason: string, approval?: unknown): PolicyUpdateResult
export function updatePolicy(first: unknown, second?: unknown, third?: unknown, fourth?: unknown): PolicyUpdateResult {
  const invocation = parseInvocation(first, second, third, fourth)
  const reasonText = normalizeReason(invocation.reason)
  const mode = approvalModeOf(invocation)
  const approvalProvided = requireExplicitApproval(invocation, mode, false)
  const path = policyStorePath(invocation.cwd)
  return withFileLock(`${path}.lock`, () => {
    const current = readCurrent(invocation.cwd, path)
    const candidate = applyChanges(current.document, invocation.changes)
    assertNoWeakening(current.document, candidate)
    const changed = !documentsEqual(current.document, candidate)
    requireExplicitApproval(invocation, mode, changed)
    if (changed && invocation.persist) writePolicy(current.path, candidate)
    return {
      ok: true,
      changed,
      tightened: changed,
      written: changed && invocation.persist,
      rejected: false,
      reason: reasonText,
      path: current.path,
      previous: cloneRecord(current.document),
      policy: cloneRecord(candidate),
      approvalRequired: changed,
      approvalProvided,
      approvalMode: mode,
    }
  }, { ttlMs: 10_000, timeoutMs: 3_000 })
}

export const applyPolicyUpdate = updatePolicy
export const updateEliaPolicy = updatePolicy
