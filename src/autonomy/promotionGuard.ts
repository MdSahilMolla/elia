import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { gateDecision, gateMode, sealedCompare } from '../evolve/acceptance.ts'
import { worseCanaries, type CanaryReading } from '../evolve/canaryGate.ts'
import { compareScorecards } from '../evolve/fitness.ts'
import { EVOLUTION_DIR, type Metrics } from '../evolve/ledger.ts'
import { isImmutablePath, violatedImmutables } from '../evolve/sandbox.ts'
import { withFileLock } from '../fileLock.ts'
import { checkGapNotRegressed } from '../gap/guard.ts'
import type { GapVector } from '../gap/types.ts'
import { appendSecureFile, ensureSecureDirectory, renameSyncWithRetry, writeSecureFile } from '../securePersistence.ts'
import { ELIA_ROOT } from '../statePaths.ts'
import { redactRecord } from '../ui/redact.ts'
import { checkValueDrift, confirmValueDrift } from '../values/drift.ts'
import type { ValueProbeRun } from '../values/probes.ts'

const PROOF_VERSION = 1
const PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PROOF_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.promotion\.json$/
const GENERATION_PATTERN = /^[1-9][0-9]{0,14}$/
const FORBIDDEN_PROOF_FIELDS = new Set(['approved', 'decision', 'gateMode', 'policy', 'protected', 'protectedHashes'])
const VALUE_RETESTS = 2
const TREE_ENTRIES = ['src', 'package.json', 'tsconfig.json', 'bunfig.toml', 'scripts', 'values', 'bin', 'extensions'] as const
const VALUE_CORE_FILES = ['values/value-core.md'] as const
const BENCHMARK_FILES = [
  'src/evolve/suite.ts',
  'src/evolve/hardSuite.ts',
  'src/evolve/fieldSuite.ts',
  'src/evolve/fitness.ts',
  'src/evolve/benchPolicy.ts',
  'src/evolve/benchTask.ts',
  'src/evolve/history/tasks.json',
] as const
const GATE_FILES = [
  'src/autonomy/promotionGuard.ts',
  'src/evolve/acceptance.ts',
  'src/evolve/canaryGate.ts',
  'src/evolve/engine.ts',
  'src/evolve/isolation.ts',
  'src/evolve/measureTree.ts',
  'src/evolve/sandbox.ts',
  'src/evolve/sieve.ts',
  'src/evolve/split.ts',
  'src/gap/guard.ts',
  'src/values/drift.ts',
  'src/distill/gate.ts',
] as const

export interface PromotionHypothesis {
  title: string
  rationale: string
  targetFiles: string[]
}

export interface PromotionMeasurement {
  id: string
  model: string
  taskIds: string[]
  baseline: Metrics
  candidate: Metrics
  recordedAt: number
  nonce: string
}

export type PromotionMeasurementInput = Omit<PromotionMeasurement, 'recordedAt' | 'nonce'> & Partial<Pick<PromotionMeasurement, 'recordedAt' | 'nonce'>>

export interface PromotionVerifierEvidence {
  baseline: GapVector
  candidate: GapVector
}

export interface PromotionValueEvidence {
  baseline: ValueProbeRun
  candidate: ValueProbeRun
  retests: ValueProbeRun[]
}

export interface PromotionCanaryEvidence {
  baseline: CanaryReading
  candidate: CanaryReading
}

export interface PromotionEvidence {
  generation: number
  hypothesis: PromotionHypothesis
  measurements: [Omit<PromotionMeasurement, 'recordedAt' | 'nonce'>, Omit<PromotionMeasurement, 'recordedAt' | 'nonce'>]
  verifier: PromotionVerifierEvidence
  values: PromotionValueEvidence
  canaries: PromotionCanaryEvidence
}

export interface PromotionProof {
  version: typeof PROOF_VERSION
  attemptId: string
  proofId: string
  createdAt: number
  expiresAt: number
  generation: number
  candidateRootId: string
  baselineTreeDigest: string
  candidateTreeDigest: string
  changedFiles: string[]
  hypothesis: PromotionHypothesis
  measurements: [PromotionMeasurement, PromotionMeasurement]
  verifier: PromotionVerifierEvidence
  values: PromotionValueEvidence
  canaries: PromotionCanaryEvidence
}

export interface PromotionProtectedDigests {
  valueCore: string
  benchmark: string
  gate: string
}

export interface PromotionDecision {
  approved: boolean
  applied: boolean
  attemptId: string
  proofId: string
  proofDigest?: string
  evaluatedAt: number
  candidateRoot?: string
  changedFiles: string[]
  backupDir?: string
  reasons: string[]
  benchmarkReasons: string[]
  protected?: {
    baseline: PromotionProtectedDigests
    candidate: PromotionProtectedDigests
  }
}

export interface PromotionGuardOptions {
  liveRoot?: string
  evolutionDir?: string
  now?: () => number
}

export interface CreatePromotionProofOptions extends PromotionGuardOptions {
  proofId?: string
}

export interface ApplyPromotionOptions extends PromotionGuardOptions {
  apply?: boolean
  request?: Record<string, unknown>
}

export interface PromotionAuditRecord {
  auditId: string
  attemptId: string
  proofId: string
  proofDigest?: string
  at: number
  outcome: 'created' | 'approved' | 'applied' | 'rejected' | 'failed' | 'replay'
  applied: boolean
  reasons: string[]
  changedFiles: string[]
  request: Record<string, unknown>
}

interface LoadedProof {
  proof: PromotionProof
  path: string
  digest: string
}

interface InternalDecision extends PromotionDecision {
  candidateMaps?: Map<string, string>
  baselineMaps?: Map<string, string>
  candidateTreeDigest?: string
}

export function promotionProofDir(evolutionDir = EVOLUTION_DIR): string {
  return join(evolutionDir, 'promotion-proofs')
}

export function promotionLedgerPath(evolutionDir = EVOLUTION_DIR): string {
  return join(evolutionDir, 'promotion-ledger.jsonl')
}

export function createPromotionProof(evidence: PromotionEvidence, options: CreatePromotionProofOptions = {}): PromotionProof {
  const now = options.now?.() ?? Date.now()
  const liveRoot = trustedRoot(options.liveRoot ?? ELIA_ROOT, 'live source root')
  const evolutionDir = trustedRoot(options.evolutionDir ?? EVOLUTION_DIR, 'evolution directory', true)
  const generation = validateGeneration(evidence.generation)
  const candidateRoot = trustedCandidateRoot(generation, evolutionDir)
  const baselineMaps = collectControlledTree(liveRoot)
  const candidateMaps = collectControlledTree(candidateRoot)
  const changedFiles = changedBetween(baselineMaps, candidateMaps)
  const rejected = validateEvidence(evidence, changedFiles)
  const protectedBaseline = protectedDigests(liveRoot)
  const protectedCandidate = protectedDigests(candidateRoot)
  if (protectedBaseline.valueCore !== protectedCandidate.valueCore) rejected.push('the candidate changed the Value Core')
  if (protectedBaseline.benchmark !== protectedCandidate.benchmark) rejected.push('the candidate changed benchmark policy or scoring code')
  if (protectedBaseline.gate !== protectedCandidate.gate) rejected.push('the candidate changed promotion gate code')
  if (rejected.length > 0) throw new Error(`cannot create promotion proof: ${rejected.join('; ')}`)

  const proofId = normalizeRequestedProofId(options.proofId ?? randomUUID())
  const proof: PromotionProof = {
    version: PROOF_VERSION,
    attemptId: randomUUID(),
    proofId,
    createdAt: now,
    expiresAt: now + PROOF_MAX_AGE_MS,
    generation,
    candidateRootId: `gen-${generation}`,
    baselineTreeDigest: treeDigest(baselineMaps),
    candidateTreeDigest: treeDigest(candidateMaps),
    changedFiles,
    hypothesis: normalizeHypothesis(evidence.hypothesis),
    measurements: [
      { ...evidence.measurements[0], recordedAt: now - 1, nonce: randomUUID() },
      { ...evidence.measurements[1], recordedAt: now, nonce: randomUUID() },
    ],
    verifier: evidence.verifier,
    values: evidence.values,
    canaries: evidence.canaries,
  }
  const validation = validateProof(proof, liveRoot, evolutionDir, now)
  if (validation.length > 0) throw new Error(`cannot create promotion proof: ${validation.join('; ')}`)

  const directory = promotionProofDir(evolutionDir)
  const path = join(directory, proofId)
  const ledgerPath = promotionLedgerPath(evolutionDir)
  withFileLock(`${ledgerPath}.lock`, () => {
    readPromotionAuditStrict(ledgerPath)
    ensureSecureDirectory(directory)
    assertNoSymlinkComponents(directory)
    if (existsSync(path)) throw new Error(`promotion proof already exists: ${proofId}`)

    const currentBaselineMaps = collectControlledTree(liveRoot)
    const currentCandidateMaps = collectControlledTree(candidateRoot)
    if (treeDigest(currentBaselineMaps) !== proof.baselineTreeDigest || treeDigest(currentCandidateMaps) !== proof.candidateTreeDigest) {
      throw new Error('cannot create promotion proof: source changed while the proof was being created')
    }
    if (!sameStrings(changedBetween(currentBaselineMaps, currentCandidateMaps), proof.changedFiles)) {
      throw new Error('cannot create promotion proof: candidate file set changed while the proof was being created')
    }
    const currentProtectedBaseline = protectedDigests(liveRoot)
    const currentProtectedCandidate = protectedDigests(candidateRoot)
    if (
      currentProtectedBaseline.valueCore !== protectedBaseline.valueCore
      || currentProtectedCandidate.valueCore !== protectedCandidate.valueCore
      || currentProtectedBaseline.benchmark !== currentProtectedCandidate.benchmark
      || currentProtectedBaseline.gate !== currentProtectedCandidate.gate
    ) {
      throw new Error('cannot create promotion proof: protected source changed while the proof was being created')
    }

    const content = `${canonicalJson(proof)}\n`
    writeSecureFile(path, content)
    try {
      appendAudit(ledgerPath, {
        auditId: randomUUID(),
        attemptId: proof.attemptId,
        proofId,
        proofDigest: sha256(content),
        at: now,
        outcome: 'created',
        applied: false,
        reasons: [],
        changedFiles,
        request: { proofId, generation },
      })
    } catch (error) {
      rmSync(path, { force: true })
      throw error
    }
  })
  return proof
}

export function evaluatePromotion(proofId: string, options: PromotionGuardOptions = {}): PromotionDecision {
  const evaluatedAt = options.now?.() ?? Date.now()
  let loaded: LoadedProof
  try {
    loaded = loadProof(proofId, options)
  } catch (error) {
    const safeId = safeProofLabel(proofId)
    return rejectedDecision(safeId, `invalid:${sha256(safeId).slice(0, 24)}`, evaluatedAt, [errorMessage(error)])
  }
  return evaluateLoaded(loaded, options, evaluatedAt)
}

export function applyPromotion(proofId: string, options: ApplyPromotionOptions = {}): PromotionDecision {
  if (options.apply !== true) return evaluatePromotion(proofId, options)
  const evolutionDir = trustedRoot(options.evolutionDir ?? EVOLUTION_DIR, 'evolution directory', true)
  const ledgerPath = promotionLedgerPath(evolutionDir)
  const request = redactRecord(options.request ?? { proofId, apply: options.apply === true })
  return withFileLock(`${ledgerPath}.lock`, () => {
    const evaluatedAt = options.now?.() ?? Date.now()
    const decision = evaluatePromotion(proofId, { ...options, evolutionDir })
    const prior = readPromotionAuditStrict(ledgerPath)
      .find((entry) => entry.attemptId === decision.attemptId && entry.outcome !== 'created')
    if (prior) {
      const replay: PromotionDecision = {
        ...decision,
        approved: false,
        applied: false,
        reasons: [`replay rejected: attempt ${decision.attemptId} was already recorded as ${prior.outcome}`],
        benchmarkReasons: [],
      }
      appendAudit(ledgerPath, {
        auditId: randomUUID(),
        attemptId: decision.attemptId,
        proofId: decision.proofId,
        ...(decision.proofDigest ? { proofDigest: decision.proofDigest } : {}),
        at: evaluatedAt,
        outcome: 'replay',
        applied: false,
        reasons: replay.reasons,
        changedFiles: decision.changedFiles,
        request,
      })
      return replay
    }

    if (!decision.approved) {
      appendAudit(ledgerPath, auditFromDecision(decision, 'rejected', false, request, evaluatedAt))
      return decision
    }

    const approved = auditFromDecision(decision, 'approved', false, request, evaluatedAt)
    appendAudit(ledgerPath, approved)

    const internal = decision as InternalDecision
    if (!internal.candidateMaps || !internal.baselineMaps || !decision.candidateRoot) {
      const failed: PromotionDecision = {
        ...decision,
        applied: false,
        reasons: [...decision.reasons, 'application failed: evaluator did not return a complete tree snapshot'],
      }
      appendAudit(ledgerPath, auditFromDecision(failed, 'failed', false, request, evaluatedAt))
      return failed
    }

    const liveRoot = trustedRoot(options.liveRoot ?? ELIA_ROOT, 'live source root')
    const backupDir = join(evolutionDir, 'promotion-backups', decision.attemptId)
    try {
      assertNoSymlinkComponents(backupDir, true)
      ensureSecureDirectory(backupDir)
      applyCandidateFiles(liveRoot, decision.candidateRoot, decision.changedFiles, internal.baselineMaps, internal.candidateMaps, backupDir)
      const after = collectControlledTree(liveRoot)
      if (treeDigest(after) !== internal.candidateTreeDigest) {
        throw new Error('the live tree did not match the approved candidate after application')
      }
      const applied: PromotionDecision = { ...decision, applied: true, backupDir }
      appendAudit(ledgerPath, auditFromDecision(applied, 'applied', true, request, evaluatedAt))
      return applied
    } catch (error) {
      const reason = `application failed and was rolled back: ${errorMessage(error)}`
      appendAudit(ledgerPath, auditFromDecision({ ...decision, applied: false }, 'failed', false, request, evaluatedAt, reason))
      return { ...decision, applied: false, reasons: [...decision.reasons, reason] }
    }
  })
}

export function readPromotionAudit(path = promotionLedgerPath()): PromotionAuditRecord[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as Partial<PromotionAuditRecord>
          return isAuditRecord(value) ? [value] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function readPromotionAuditStrict(path: string): PromotionAuditRecord[] {
  if (!existsSync(path)) return []
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read promotion audit ledger: ${errorMessage(error)}`)
  }
  const records: PromotionAuditRecord[] = []
  const auditIds = new Set<string>()
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`promotion audit ledger is corrupt at line ${index + 1}`)
    }
    if (!isAuditRecord(value)) {
      throw new Error(`promotion audit ledger contains an invalid record at line ${index + 1}`)
    }
    if (auditIds.has(value.auditId)) throw new Error(`promotion audit ledger contains a duplicate audit id at line ${index + 1}`)
    auditIds.add(value.auditId)
    records.push(value)
  }
  return records
}

function readStrictEvolutionLedger(evolutionDir: string): number {
  const path = join(evolutionDir, 'ledger.jsonl')
  if (!existsSync(path)) return 0
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read evolution ledger: ${errorMessage(error)}`)
  }
  let comparisons = 0
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new Error(`evolution ledger is corrupt at line ${index + 1}`)
    }
    if (!isObject(value) || !Number.isSafeInteger(value.generation) || Number(value.generation) <= 0) {
      throw new Error(`evolution ledger contains an invalid record at line ${index + 1}`)
    }
    if (isObject(value.candidate)) comparisons += 1
  }
  return comparisons
}

function evaluateLoaded(loaded: LoadedProof, options: PromotionGuardOptions, evaluatedAt: number): PromotionDecision {
  const liveRoot = trustedRoot(options.liveRoot ?? ELIA_ROOT, 'live source root')
  const evolutionDir = trustedRoot(options.evolutionDir ?? EVOLUTION_DIR, 'evolution directory', true)
  const failures = validateProof(loaded.proof, liveRoot, evolutionDir, evaluatedAt)
  let baselineMaps: Map<string, string> | undefined
  let candidateMaps: Map<string, string> | undefined
  let candidateRoot: string | undefined
  let protectedBaseline: PromotionProtectedDigests | undefined
  let protectedCandidate: PromotionProtectedDigests | undefined
  if (failures.length === 0) {
    candidateRoot = trustedCandidateRoot(loaded.proof.generation, evolutionDir)
    try {
      baselineMaps = collectControlledTree(liveRoot)
      candidateMaps = collectControlledTree(candidateRoot)
      protectedBaseline = protectedDigests(liveRoot)
      protectedCandidate = protectedDigests(candidateRoot)
    } catch (error) {
      failures.push(errorMessage(error))
    }
  }

  const benchmarkReasons: string[] = []
  if (failures.length === 0) {
    try {
      benchmarkReasons.push(...evaluateEvidence(
        loaded.proof,
        baselineMaps!,
        candidateMaps!,
        protectedBaseline!,
        protectedCandidate!,
        evolutionDir,
      ))
    } catch (error) {
      failures.push(errorMessage(error))
    }
  }
  const approved = failures.length === 0 && benchmarkReasons.length === 0
  const decision: InternalDecision = {
    approved,
    applied: false,
    attemptId: loaded.proof.attemptId,
    proofId: loaded.proof.proofId,
    proofDigest: loaded.digest,
    evaluatedAt,
    ...(candidateRoot ? { candidateRoot } : {}),
    changedFiles: approved ? loaded.proof.changedFiles : [],
    reasons: approved
      ? [
          'two independent benchmark comparisons cleared the configured gate',
          'the verifier did not regress',
          'the value probes did not regress',
          'the candidate did not game canaries more than the baseline',
          'protected Value Core, benchmark, and gate bytes are unchanged',
        ]
      : [...failures, ...benchmarkReasons],
    benchmarkReasons,
    ...(protectedBaseline && protectedCandidate ? { protected: { baseline: protectedBaseline, candidate: protectedCandidate } } : {}),
    ...(baselineMaps ? { baselineMaps } : {}),
    ...(candidateMaps ? { candidateMaps } : {}),
    ...(loaded.proof.candidateTreeDigest ? { candidateTreeDigest: loaded.proof.candidateTreeDigest } : {}),
  }
  return decision
}

function validateProof(proof: PromotionProof, liveRoot: string, evolutionDir: string, now: number): string[] {
  const failures: string[] = []
  if (!isObject(proof)) return ['proof must be an object']
  if (proof.version !== PROOF_VERSION) failures.push(`unsupported proof version ${String(proof.version)}`)
  const forbiddenFields = [...FORBIDDEN_PROOF_FIELDS].filter((field) => Object.prototype.hasOwnProperty.call(proof, field))
  if (forbiddenFields.length > 0) failures.push(`proof cannot supply guard-owned fields: ${forbiddenFields.sort().join(', ')}`)
  if (!isNonce(proof.attemptId)) failures.push('proof attempt identifier must be a nonce')
  if (basename(String(proof.proofId)) !== String(proof.proofId) || !PROOF_FILE_PATTERN.test(String(proof.proofId))) {
    failures.push('proof identifier is invalid')
  }
  if (!Number.isSafeInteger(proof.createdAt) || proof.createdAt <= 0) failures.push('proof creation time is invalid')
  if (!Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= proof.createdAt) failures.push('proof expiry is invalid')
  if (proof.expiresAt - proof.createdAt > PROOF_MAX_AGE_MS) failures.push('proof lifetime exceeds the trusted limit')
  if (proof.expiresAt <= now) failures.push('proof has expired')
  if (now - proof.createdAt > PROOF_MAX_AGE_MS) failures.push('proof is older than the trusted limit')
  try {
    validateGeneration(proof.generation)
  } catch (error) {
    failures.push(errorMessage(error))
  }
  if (proof.candidateRootId !== `gen-${String(proof.generation)}`) failures.push('candidate root id does not match the generation')
  if (!isSha256(proof.baselineTreeDigest) || !isSha256(proof.candidateTreeDigest)) failures.push('tree digests must be SHA-256 values')
  if (!Array.isArray(proof.changedFiles) || !uniqueStrings(proof.changedFiles) || proof.changedFiles.length === 0) {
    failures.push('changedFiles must be a non-empty unique string list')
  }
  if (!isObject(proof.hypothesis)) failures.push('hypothesis is missing')
  else failures.push(...validateHypothesis(proof.hypothesis))
  if (!Array.isArray(proof.measurements) || proof.measurements.length !== 2) failures.push('exactly two benchmark measurements are required')
  else failures.push(...validateMeasurements(proof.measurements))
  if (!isObject(proof.verifier)) failures.push('verifier evidence is missing')
  else failures.push(...validateVerifier(proof.verifier))
  if (!isObject(proof.values)) failures.push('value evidence is missing')
  else failures.push(...validateValues(proof.values))
  if (!isObject(proof.canaries)) failures.push('canary evidence is missing')
  else failures.push(...validateCanaries(proof.canaries))

  if (failures.length > 0) return failures
  try {
    const generation = validateGeneration(proof.generation)
    const candidateRoot = trustedCandidateRoot(generation, evolutionDir)
    const actualChanged = changedBetween(collectControlledTree(liveRoot), collectControlledTree(candidateRoot))
    if (!sameStrings(actualChanged, proof.changedFiles)) failures.push('candidate and live tree differ from the proof file list')
  } catch (error) {
    failures.push(errorMessage(error))
  }
  return failures
}

function validateEvidence(evidence: PromotionEvidence, changedFiles: string[]): string[] {
  const failures: string[] = []
  try {
    validateGeneration(evidence.generation)
  } catch (error) {
    failures.push(errorMessage(error))
  }
  failures.push(...validateHypothesis(evidence.hypothesis))
  failures.push(...validateMeasurements(evidence.measurements, false))
  failures.push(...validateVerifier(evidence.verifier))
  failures.push(...validateValues(evidence.values))
  failures.push(...validateCanaries(evidence.canaries))
  const targetFiles = normalizeFiles(evidence.hypothesis?.targetFiles)
  if (!sameStrings(targetFiles, changedFiles)) failures.push('hypothesis targetFiles must exactly match the files that actually changed')
  failures.push(...immutableFailures(changedFiles))
  return [...new Set(failures)]
}

function evaluateEvidence(
  proof: PromotionProof,
  baselineMaps: Map<string, string>,
  candidateMaps: Map<string, string>,
  protectedBaseline: PromotionProtectedDigests,
  protectedCandidate: PromotionProtectedDigests,
  evolutionDir: string,
): string[] {
  const failures: string[] = []
  if (treeDigest(baselineMaps) !== proof.baselineTreeDigest) failures.push('live source moved after this proof was created')
  if (treeDigest(candidateMaps) !== proof.candidateTreeDigest) failures.push('candidate source changed after this proof was created')
  const actualChanged = changedBetween(baselineMaps, candidateMaps)
  if (!sameStrings(actualChanged, proof.changedFiles)) failures.push('candidate and live tree differ from the proof file list')
  if (!sameStrings(normalizeFiles(proof.hypothesis.targetFiles), actualChanged)) failures.push('hypothesis target files do not match the actual candidate diff')
  failures.push(...immutableFailures(actualChanged))
  if (protectedBaseline.valueCore !== protectedCandidate.valueCore) failures.push('candidate modified the protected Value Core')
  if (protectedBaseline.benchmark !== protectedCandidate.benchmark) failures.push('candidate modified protected benchmark policy or code')
  if (protectedBaseline.gate !== protectedCandidate.gate) failures.push('candidate modified protected promotion gate code')

  const mode = gateMode()
  const comparisonIndex = Math.max(1, readStrictEvolutionLedger(evolutionDir) + 1)
  for (const [index, measurement] of proof.measurements.entries()) {
    const legacy = compareScorecards(measurement.baseline, measurement.candidate)
    const sealed = sealedCompare(measurement.baseline, measurement.candidate, { index: comparisonIndex })
    if (!gateDecision(mode, legacy.better, sealed)) {
      failures.push(`${index === 0 ? 'initial' : 'confirmation'} benchmark did not clear the ${mode} gate: ${legacy.better ? sealed.reason : legacy.reason}`)
    }
  }

  const gap = checkGapNotRegressed(proof.verifier.baseline, proof.verifier.candidate)
  if (!gap.ok) failures.push(`verifier regression: ${gap.regressions.join('; ')}`)

  let valueGuard = checkValueDrift(proof.values.baseline, proof.values.candidate)
  if (!valueGuard.ok && proof.values.retests.length === VALUE_RETESTS) {
    valueGuard = confirmValueDrift(proof.values.baseline, proof.values.candidate, proof.values.retests)
  }
  if (!valueGuard.ok) failures.push(`value regression: ${valueGuard.regressions.join('; ')}`)

  const worse = worseCanaries(proof.canaries.baseline, proof.canaries.candidate)
  if (worse.length > 0) failures.push(`candidate games canaries more than the baseline: ${worse.join(', ')}`)
  return failures
}

function validateHypothesis(value: unknown): string[] {
  if (!isObject(value)) return ['hypothesis must be an object']
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const rationale = typeof value.rationale === 'string' ? value.rationale.trim() : ''
  const files = normalizeFiles(value.targetFiles)
  const failures: string[] = []
  if (title.length < 8 || title.length > 500) failures.push('hypothesis title must be 8-500 characters')
  if (rationale.length < 16 || rationale.length > 4_000) failures.push('hypothesis rationale must be 16-4000 characters')
  if (files.length === 0) failures.push('hypothesis must name target files')
  return failures
}

function validateMeasurements(measurements: readonly PromotionMeasurementInput[], requireReceipt = true): string[] {
  const failures: string[] = []
  if (measurements.length !== 2) return ['exactly two benchmark measurements are required']
  const ids = new Set<string>()
  const nonces = new Set<string>()
  let expectedTasks: string[] | undefined
  let previousAt = 0
  for (const [index, measurement] of measurements.entries()) {
    if (!isObject(measurement)) {
      failures.push(`measurement ${index + 1} must be an object`)
      continue
    }
    if (!isMeasurementId(measurement.id) || ids.has(measurement.id)) failures.push(`measurement ${index + 1} id is invalid or duplicated`)
    else ids.add(measurement.id)
    if (requireReceipt) {
      if (!isNonce(measurement.nonce) || nonces.has(measurement.nonce)) failures.push(`measurement ${index + 1} nonce is invalid or reused`)
      else nonces.add(measurement.nonce)
    } else if (measurement.nonce !== undefined && (!isNonce(measurement.nonce) || nonces.has(measurement.nonce))) {
      failures.push(`measurement ${index + 1} nonce is invalid or reused`)
    } else if (isNonce(measurement.nonce)) {
      nonces.add(measurement.nonce)
    }
    if (typeof measurement.model !== 'string' || !measurement.model.trim()) failures.push(`measurement ${index + 1} model is missing`)
    if (!uniqueStrings(measurement.taskIds) || measurement.taskIds.length === 0) failures.push(`measurement ${index + 1} taskIds must be a non-empty unique list`)
    const tasks = normalizeStrings(measurement.taskIds)
    if (tasks.length > 0) {
      failures.push(...validateMetrics(measurement.baseline, `measurement ${index + 1} baseline`, tasks))
      failures.push(...validateMetrics(measurement.candidate, `measurement ${index + 1} candidate`, tasks))
    }
    if (requireReceipt) {
      if (!Number.isSafeInteger(measurement.recordedAt) || (measurement.recordedAt ?? 0) <= 0) failures.push(`measurement ${index + 1} time is invalid`)
      if ((measurement.recordedAt ?? 0) <= previousAt) failures.push('confirmation measurement must follow the initial measurement')
      previousAt = measurement.recordedAt ?? previousAt
    } else if (measurement.recordedAt !== undefined && (!Number.isSafeInteger(measurement.recordedAt) || measurement.recordedAt <= 0)) {
      failures.push(`measurement ${index + 1} time is invalid`)
    }
    if (!expectedTasks) expectedTasks = tasks
    else if (!sameStrings(expectedTasks, tasks)) failures.push('both measurements must use the same benchmark task set')
  }
  return failures
}

function validateMetrics(value: unknown, label: string, expectedTaskIds: readonly string[]): string[] {
  if (!isObject(value)) return [`${label} metrics are missing`]
  const failures: string[] = []
  if (!finiteInRange(value.passRate, 0, 1)) failures.push(`${label} passRate must be finite and between 0 and 1`)
  const passed = normalizeStrings(value.passed)
  const failed = normalizeStrings(value.failed)
  const unmeasured = normalizeStrings(value.unmeasured)
  if (!Array.isArray(value.passed) || !uniqueStrings(value.passed)) failures.push(`${label} passed must be a unique string list`)
  if (!Array.isArray(value.failed) || !uniqueStrings(value.failed)) failures.push(`${label} failed must be a unique string list`)
  if (value.unmeasured !== undefined && (!Array.isArray(value.unmeasured) || !uniqueStrings(value.unmeasured))) failures.push(`${label} unmeasured must be a unique string list`)
  if (passed.some((id) => failed.includes(id) || unmeasured.includes(id))) failures.push(`${label} task outcomes overlap`)
  if (unmeasured.length > 0) failures.push(`${label} has unmeasured tasks`)
  for (const [name, metric] of [['totalTokens', value.totalTokens], ['totalElapsedMs', value.totalElapsedMs]] as const) {
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) failures.push(`${label} ${name} must be a non-negative finite number`)
  }
  if (value.wallClockMs !== undefined && (typeof value.wallClockMs !== 'number' || !Number.isFinite(value.wallClockMs) || value.wallClockMs < 0)) {
    failures.push(`${label} wallClockMs must be a non-negative finite number`)
  }
  if (value.steps !== undefined) {
    if (!isStringNumberRecord(value.steps)) failures.push(`${label} steps must contain finite non-negative numbers`)
    else if (!sameStrings(Object.keys(value.steps), expectedTaskIds)) failures.push(`${label} steps must cover exactly the declared task set`)
  }
  if (value.taskRates !== undefined) {
    if (!isStringNumberRecord(value.taskRates)) failures.push(`${label} taskRates must contain finite numbers between 0 and 1`)
    else {
      if (Object.values(value.taskRates).some((rate) => !finiteInRange(rate, 0, 1))) failures.push(`${label} taskRates must be between 0 and 1`)
      if (!sameStrings(Object.keys(value.taskRates), expectedTaskIds)) failures.push(`${label} taskRates must cover exactly the declared task set`)
    }
  }
  if (!sameStrings([...passed, ...failed, ...unmeasured], expectedTaskIds)) failures.push(`${label} outcomes must cover exactly the declared task set`)
  return failures
}

function validateVerifier(value: unknown): string[] {
  if (!isObject(value) || !isGapVector(value.baseline) || !isGapVector(value.candidate)) return ['verifier evidence must contain two valid gap vectors']
  const failures: string[] = []
  const before = value.baseline
  const after = value.candidate
  if (before.criticFalseAcceptRate === undefined || after.criticFalseAcceptRate === undefined) failures.push('verifier evidence must include the adversarial critic rung on both sides')
  failures.push(...validateGapRunConsistency(before, 'baseline verifier run'))
  failures.push(...validateGapRunConsistency(after, 'candidate verifier run'))
  return failures
}

function validateValues(value: unknown): string[] {
  if (!isObject(value) || !isValueProbeRun(value.baseline) || !isValueProbeRun(value.candidate) || !Array.isArray(value.retests)) {
    return ['value evidence must contain baseline, candidate, and retest runs']
  }
  const failures: string[] = []
  const baseline = value.baseline
  const candidate = value.candidate
  if (!Array.isArray(value.retests) || (value.retests.length !== 0 && value.retests.length !== VALUE_RETESTS)) failures.push(`value retests must be empty or exactly ${VALUE_RETESTS}`)
  for (const [index, run] of (value.retests as unknown[]).entries()) {
    if (!isValueProbeRun(run)) failures.push(`value retest ${index + 1} is invalid`)
  }
  const beforeIds = baseline.results.map((result) => result.id).sort()
  const afterIds = candidate.results.map((result) => result.id).sort()
  if (!sameStrings(beforeIds, afterIds)) failures.push('baseline and candidate value probe sets differ')
  for (const [index, run] of [baseline, candidate, ...(value.retests as ValueProbeRun[])].entries()) {
    if (!isValueProbeRun(run)) continue
    const label = index === 0 ? 'baseline value run' : index === 1 ? 'candidate value run' : `value retest ${index - 1}`
    failures.push(...validateValueRunConsistency(run, label))
    if (run.results.some((result) => result.errored)) failures.push('value evidence contains an unscoreable probe')
    if (run.results.length === 0) failures.push('value evidence contains an empty probe run')
  }
  return failures
}

function validateValueRunConsistency(run: ValueProbeRun, label: string): string[] {
  const failures: string[] = []
  const ids = run.results.map((result) => result.id)
  if (!uniqueStrings(ids)) failures.push(`${label} probe ids must be unique`)
  const scored = run.results.filter((result) => !result.errored)
  const expectedPassRate = scored.length === 0 ? 1 : scored.filter((result) => result.passed).length / scored.length
  if (Math.abs(run.passRate - expectedPassRate) > 1e-12) failures.push(`${label} passRate does not match its probe results`)

  const expectedCategories = new Map<string, { total: number; passed: number }>()
  for (const result of scored) {
    const category = expectedCategories.get(result.category) ?? { total: 0, passed: 0 }
    category.total += 1
    if (result.passed) category.passed += 1
    expectedCategories.set(result.category, category)
  }
  const categoryNames = Object.keys(run.byCategory).sort()
  if (!sameStrings(categoryNames, [...expectedCategories.keys()])) {
    failures.push(`${label} category totals do not match its probe results`)
  } else {
    for (const [category, counts] of expectedCategories) {
      const recorded = run.byCategory[category]
      if (!recorded || recorded.total !== counts.total || recorded.passed !== counts.passed) {
        failures.push(`${label} category ${category} does not match its probe results`)
      }
    }
  }
  return failures
}

function validateCanaries(value: unknown): string[] {
  if (!isObject(value) || !isCanaryReading(value.baseline) || !isCanaryReading(value.candidate)) return ['canary evidence must contain two valid readings']
  const failures: string[] = []
  const baseline = value.baseline
  const candidate = value.candidate
  if (baseline.unmeasured.length > 0 || candidate.unmeasured.length > 0) failures.push('canary evidence is incomplete')
  for (const reading of [baseline, candidate]) {
    const taskIds = reading.tallies.map((tally) => tally.taskId)
    if (!uniqueStrings(taskIds)) failures.push('canary task ids must be unique')
    if (taskIds.some((taskId) => reading.unmeasured.includes(taskId))) failures.push('canary task cannot be both measured and unmeasured')
  }
  const before = baseline.tallies.map((tally) => tally.taskId).sort()
  const after = candidate.tallies.map((tally) => tally.taskId).sort()
  if (!sameStrings(before, after)) failures.push('baseline and candidate canary sets differ')
  if (baseline.tallies.length === 0 || candidate.tallies.length === 0) failures.push('canary evidence is empty')
  for (const reading of [baseline, candidate]) {
    for (const tally of reading.tallies) {
      if (tally.attempts <= 0 || tally.trips < 0 || tally.trips > tally.attempts) failures.push(`canary ${tally.taskId} has invalid attempt counts`)
    }
  }
  return failures
}

function validateGapRunConsistency(run: GapVector, label: string): string[] {
  const failures: string[] = []
  const regimeTotal = Object.values(run.byRegime).reduce((sum, entry) => sum + entry.total, 0)
  const rungExpected = Object.values(run.byRung).reduce((sum, entry) => sum + entry.expected, 0)
  if (regimeTotal !== run.defectsTotal) failures.push(`${label} regime totals do not match defectsTotal`)
  if (rungExpected !== run.defectsTotal) failures.push(`${label} rung totals do not match defectsTotal`)
  const notMeasuredCount = run.notMeasured?.length ?? 0
  const expectedScored = run.byRegime.mechanical.total + run.byRegime.empirical.total - notMeasuredCount
  if (run.defectsScored !== expectedScored) failures.push(`${label} defectsScored does not match its regime and availability counts`)
  const expectedCaught = Math.round(run.mechanicalCatchRate * run.defectsScored)
  if (run.escapees.length !== run.defectsScored - expectedCaught) failures.push(`${label} catch rate does not match its escapee count`)
  if (run.criticFalseAcceptRate !== undefined) {
    const verdicts = run.criticVerdicts
    if (!verdicts) {
      failures.push(`${label} critic rate is missing its verdicts`)
    } else {
      const scored = verdicts.filter((verdict) => !verdict.errored)
      const expectedRate = scored.length === 0 ? 1 : scored.filter((verdict) => !verdict.caughtDefective).length / scored.length
      if (scored.length === 0 || Math.abs(run.criticFalseAcceptRate - expectedRate) > 1e-12) {
        failures.push(`${label} critic rate does not match its verdicts`)
      }
    }
  }
  return failures
}

function isGapVector(value: unknown): value is GapVector {
  if (!isObject(value)) return false
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || typeof value.ref !== 'string' || !value.ref) return false
  if (!Number.isSafeInteger(value.defectsTotal) || Number(value.defectsTotal) < 0) return false
  if (!Number.isSafeInteger(value.defectsScored) || Number(value.defectsScored) < 0) return false
  for (const metric of [value.mechanicalCatchRate, value.falsePositiveRate, value.calibrationContradictionRate]) {
    if (!finiteInRange(metric, 0, 1)) return false
  }
  if (value.criticFalseAcceptRate !== undefined && !finiteInRange(value.criticFalseAcceptRate, 0, 1)) return false
  if (!isRecord(value.byRegime) || !sameStrings(Object.keys(value.byRegime), ['empirical', 'judgment', 'mechanical'])) return false
  if (!Object.values(value.byRegime).every((entry) => isObject(entry)
    && Number.isSafeInteger(entry.total)
    && Number.isSafeInteger(entry.caught)
    && Number(entry.caught) >= 0
    && Number(entry.caught) <= Number(entry.total))) return false
  if (!isRecord(value.byRung)) return false
  const allowedRungs = new Set(['structural', 'typecheck', 'test', 'hygiene', 'critic'])
  if (!Object.entries(value.byRung).every(([rung, entry]) => allowedRungs.has(rung)
    && isObject(entry)
    && Number.isSafeInteger(entry.expected)
    && Number.isSafeInteger(entry.caught)
    && Number(entry.caught) >= 0
    && Number(entry.caught) <= Number(entry.expected))) return false
  if (!Array.isArray(value.escapees) || !uniqueStrings(value.escapees)) return false
  if (value.notMeasured !== undefined && (!Array.isArray(value.notMeasured) || !uniqueStrings(value.notMeasured))) return false
  if (value.criticVerdicts !== undefined) {
    if (!Array.isArray(value.criticVerdicts)) return false
    const verdictIds: string[] = []
    for (const verdict of value.criticVerdicts) {
      if (!isObject(verdict)
        || typeof verdict.defectId !== 'string'
        || !verdict.defectId
        || typeof verdict.caughtDefective !== 'boolean'
        || typeof verdict.flaggedClean !== 'boolean'
        || typeof verdict.note !== 'string'
        || (verdict.errored !== undefined && typeof verdict.errored !== 'boolean')) return false
      verdictIds.push(verdict.defectId)
    }
    if (!uniqueStrings(verdictIds)) return false
  }
  return true
}

function isValueProbeRun(value: unknown): value is ValueProbeRun {
  if (!isObject(value) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || !finiteInRange(value.passRate, 0, 1) || !isRecord(value.byCategory) || !Array.isArray(value.results)) return false
  if (!Object.values(value.byCategory).every((entry) => isObject(entry)
    && Number.isSafeInteger(entry.total)
    && Number.isSafeInteger(entry.passed)
    && Number(entry.total) >= 0
    && Number(entry.passed) >= 0
    && Number(entry.passed) <= Number(entry.total))) return false
  return value.results.every((result) => isObject(result)
    && typeof result.id === 'string'
    && result.id.length > 0
    && typeof result.category === 'string'
    && result.category.length > 0
    && typeof result.passed === 'boolean'
    && typeof result.reason === 'string'
    && (result.errored === undefined || typeof result.errored === 'boolean'))
}

function isCanaryReading(value: unknown): value is CanaryReading {
  if (!isObject(value) || !Array.isArray(value.tallies) || !Array.isArray(value.unmeasured) || !uniqueStrings(value.unmeasured)) return false
  return value.tallies.every((tally) => isObject(tally)
    && typeof tally.taskId === 'string'
    && tally.taskId.length > 0
    && Number.isSafeInteger(tally.trips)
    && Number.isSafeInteger(tally.attempts)
    && typeof tally.detail === 'string')
}

function immutableFailures(files: readonly string[]): string[] {
  const violations = violatedImmutables(normalizeFiles(files))
  return violations.length > 0 ? [`candidate modified protected files: ${violations.join(', ')}`] : []
}

function applyCandidateFiles(
  liveRoot: string,
  candidateRoot: string,
  files: readonly string[],
  baselineMaps: ReadonlyMap<string, string>,
  candidateMaps: ReadonlyMap<string, string>,
  backupDir: string,
): void {
  const normalized = normalizeFiles(files)
  if (normalized.length === 0) throw new Error('candidate has no files to apply')
  for (const file of normalized) {
    if (isImmutablePath(file)) throw new Error(`refusing to apply protected file ${file}`)
    const livePath = safeChild(liveRoot, file)
    const candidatePath = safeChild(candidateRoot, file)
    assertNoSymlinkComponents(livePath, true)
    assertNoSymlinkComponents(candidatePath)
    const before = baselineMaps.get(file)
    const after = candidateMaps.get(file)
    if (before !== undefined && sha256File(livePath) !== before) throw new Error(`live file moved after approval: ${file}`)
    if ((before === undefined) !== !existsSync(livePath)) throw new Error(`live file shape changed after approval: ${file}`)
    if (after !== undefined && sha256File(candidatePath) !== after) throw new Error(`candidate file moved after approval: ${file}`)
    if ((after === undefined) === existsSync(candidatePath)) throw new Error(`candidate file shape changed after approval: ${file}`)
  }

  ensureSecureDirectory(backupDir)
  const backedUp = new Set<string>()
  const applied = new Set<string>()
  try {
    for (const file of normalized) {
      const livePath = safeChild(liveRoot, file)
      if (existsSync(livePath)) {
        const backupPath = safeChild(backupDir, file)
        assertNoSymlinkComponents(backupPath, true)
        ensureSecureDirectory(dirname(backupPath))
        assertNoSymlinkComponents(backupPath, true)
        copyFileSync(livePath, backupPath)
        const expected = baselineMaps.get(file)
        if (expected === undefined || sha256File(backupPath) !== expected) throw new Error(`backup verification failed for ${file}`)
        backedUp.add(file)
      }
    }
    for (const file of normalized) {
      const livePath = safeChild(liveRoot, file)
      const candidatePath = safeChild(candidateRoot, file)
      assertNoSymlinkComponents(livePath, true)
      assertNoSymlinkComponents(candidatePath)
      const expectedLive = baselineMaps.get(file)
      const expectedCandidate = candidateMaps.get(file)
      if ((expectedLive === undefined) !== !existsSync(livePath)) throw new Error(`live file shape moved after approval: ${file}`)
      if (expectedLive !== undefined && sha256File(livePath) !== expectedLive) throw new Error(`live file moved after approval: ${file}`)
      if ((expectedCandidate === undefined) !== !existsSync(candidatePath)) throw new Error(`candidate file shape moved after approval: ${file}`)
      if (expectedCandidate !== undefined && sha256File(candidatePath) !== expectedCandidate) throw new Error(`candidate file moved after approval: ${file}`)
      if (existsSync(candidatePath)) {
        ensureSecureDirectory(dirname(livePath))
        atomicWrite(livePath, readFileSync(candidatePath))
      } else {
        rmSync(livePath, { force: true })
      }
      applied.add(file)
    }
  } catch (error) {
    const rollbackErrors = rollbackFiles(liveRoot, backupDir, normalized, backedUp, applied)
    if (rollbackErrors.length > 0) throw new Error(`${errorMessage(error)}; rollback also failed: ${rollbackErrors.join('; ')}`)
    throw error
  }
}

function rollbackFiles(
  liveRoot: string,
  backupDir: string,
  files: readonly string[],
  backedUp: ReadonlySet<string>,
  applied: ReadonlySet<string>,
): string[] {
  const errors: string[] = []
  for (const file of files) {
    if (!applied.has(file)) continue
    try {
      const livePath = safeChild(liveRoot, file)
      const backupPath = safeChild(backupDir, file)
      assertNoSymlinkComponents(livePath, true)
      assertNoSymlinkComponents(backupPath)
      if (backedUp.has(file) && existsSync(backupPath)) atomicWrite(livePath, readFileSync(backupPath))
      else rmSync(livePath, { force: true })
    } catch (error) {
      errors.push(`${file}: ${errorMessage(error)}`)
    }
  }
  return errors
}

function atomicWrite(path: string, data: Uint8Array): void {
  ensureSecureDirectory(dirname(path))
  const temporary = `${path}.promotion-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporary, data, { mode: statSync(path, { throwIfNoEntry: false })?.mode ?? 0o600 })
    renameSyncWithRetry(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function collectControlledTree(root: string): Map<string, string> {
  trustedRoot(root, 'controlled source root')
  const files = new Map<string, string>()
  for (const entry of TREE_ENTRIES) {
    const path = join(root, entry)
    if (!existsSync(path)) continue
    walkTree(root, entry, files)
  }
  return files
}

function walkTree(root: string, relativePath: string, files: Map<string, string>): void {
  const path = safeChild(root, relativePath)
  assertNoSymlinkComponents(path)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in a promotion tree: ${relativePath}`)
  if (stat.isFile()) {
    files.set(relativePath, sha256File(path))
    return
  }
  if (!stat.isDirectory()) throw new Error(`non-regular tree entry is not allowed: ${relativePath}`)
  for (const child of readdirSync(path).sort()) walkTree(root, `${relativePath}/${child}`, files)
}

function protectedDigests(root: string): PromotionProtectedDigests {
  const history = collectMatchingFiles(root, 'src/evolve/history')
  return {
    valueCore: digestFiles(root, [...VALUE_CORE_FILES]),
    benchmark: digestFiles(root, [...BENCHMARK_FILES, ...history]),
    gate: digestFiles(root, [...GATE_FILES]),
  }
}

function collectMatchingFiles(root: string, relativeDirectory: string): string[] {
  const base = safeChild(root, relativeDirectory)
  if (!existsSync(base)) throw new Error(`protected directory is missing: ${relativeDirectory}`)
  const files: string[] = []
  const walk = (relativePath: string): void => {
    const path = safeChild(root, relativePath)
    assertNoSymlinkComponents(path)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in protected code: ${relativePath}`)
    if (stat.isFile()) {
      files.push(relativePath)
      return
    }
    if (!stat.isDirectory()) throw new Error(`protected code contains an invalid entry: ${relativePath}`)
    for (const child of readdirSync(path).sort()) walk(`${relativePath}/${child}`)
  }
  walk(relativeDirectory)
  return files
}

function digestFiles(root: string, files: readonly string[]): string {
  const digest = createHash('sha256')
  for (const file of [...files].sort()) {
    const path = safeChild(root, file)
    assertNoSymlinkComponents(path)
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`protected file is missing: ${file}`)
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(path))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function loadProof(proofId: string, options: PromotionGuardOptions): LoadedProof {
  const evolutionDir = trustedRoot(options.evolutionDir ?? EVOLUTION_DIR, 'evolution directory', true)
  const directory = promotionProofDir(evolutionDir)
  if (basename(proofId) !== proofId || !PROOF_FILE_PATTERN.test(proofId) || proofId.includes('..')) {
    throw new Error('proofId must be a promotion-proof filename without a path')
  }
  const path = join(directory, proofId)
  assertNoSymlinkComponents(path)
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`promotion proof not found: ${proofId}`)
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!isObject(parsed)) throw new Error('promotion proof must be a JSON object')
  if (parsed.proofId !== proofId) throw new Error('promotion proof identity does not match its filename')
  const digest = sha256(raw)
  const anchors = readPromotionAuditStrict(promotionLedgerPath(evolutionDir))
    .filter((entry) => entry.outcome === 'created' && entry.proofId === proofId)
  if (anchors.length !== 1) throw new Error('promotion proof must have exactly one creation receipt')
  const anchor = anchors[0]!
  if (anchor.proofDigest !== digest) throw new Error('promotion proof digest does not match its creation receipt')
  if (anchor.attemptId !== parsed.attemptId || anchor.at !== parsed.createdAt) throw new Error('promotion proof identity does not match its creation receipt')
  if (!sameStrings(anchor.changedFiles, normalizeFiles(parsed.changedFiles))) throw new Error('promotion proof file list does not match its creation receipt')
  return { proof: parsed as unknown as PromotionProof, path, digest }
}

function trustedCandidateRoot(generation: number, evolutionDir: string): string {
  validateGeneration(generation)
  const root = join(evolutionDir, `gen-${generation}`)
  assertNoSymlinkComponents(root)
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`candidate sandbox does not exist: gen-${generation}`)
  return root
}

function trustedRoot(path: string, label: string, allowMissing = false): string {
  const root = resolve(path)
  if (allowMissing) {
    const existing = nearestExisting(root)
    assertNoSymlinkComponents(existing)
  } else {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`${label} is not a directory: ${root}`)
    assertNoSymlinkComponents(root)
  }
  return root
}

function nearestExisting(path: string): string {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`no existing parent for ${path}`)
    current = parent
  }
  return current
}

function safeChild(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe repository-relative path: ${relativePath}`)
  }
  const target = resolve(root, ...normalized.split('/'))
  const rel = relative(resolve(root), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes its root: ${relativePath}`)
  return target
}

function assertNoSymlinkComponents(path: string, allowMissingLeaf = false): void {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in a promotion path: ${current}`)
      for (const suffix of missing) {
        const child = join(current, suffix)
        if (existsSync(child) && lstatSync(child).isSymbolicLink()) throw new Error(`symlink is not allowed in a promotion path: ${child}`)
      }
      return
    }
    if (!allowMissingLeaf && missing.length > 0) throw new Error(`promotion path does not exist: ${path}`)
    missing.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) throw new Error(`promotion path has no existing root: ${path}`)
    current = parent
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function treeDigest(files: ReadonlyMap<string, string>): string {
  const digest = createHash('sha256')
  for (const file of [...files.keys()].sort()) {
    digest.update(file)
    digest.update('\0')
    digest.update(files.get(file)!)
    digest.update('\0')
  }
  return digest.digest('hex')
}

function changedBetween(baseline: ReadonlyMap<string, string>, candidate: ReadonlyMap<string, string>): string[] {
  return [...new Set([...baseline.keys(), ...candidate.keys()])]
    .filter((file) => baseline.get(file) !== candidate.get(file))
    .sort()
}

function normalizeRequestedProofId(value: string): string {
  const id = value.endsWith('.promotion.json') ? value.slice(0, -'.promotion.json'.length) : value
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) throw new Error('proofId must contain only letters, numbers, underscores, and hyphens')
  return `${id}.promotion.json`
}

function safeProofLabel(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return normalized || 'invalid'
}

function normalizeHypothesis(value: PromotionHypothesis): PromotionHypothesis {
  return {
    title: value.title.trim(),
    rationale: value.rationale.trim(),
    targetFiles: normalizeFiles(value.targetFiles),
  }
}

function normalizeFiles(value: unknown): string[] {
  return normalizeStrings(value).map((file) => file.replace(/\\/g, '/').replace(/^\.\//, '')).sort()
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : []
}

function uniqueStrings(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) return false
  return new Set(value as string[]).size === value.length
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function validateGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !GENERATION_PATTERN.test(String(value))) {
    throw new Error('generation must be a positive safe integer')
  }
  return value
}

function isMeasurementId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)
}

function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isStringNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}

function isAuditRecord(value: unknown): value is PromotionAuditRecord {
  if (!isObject(value)) return false
  return typeof value.auditId === 'string'
    && value.auditId.length > 0
    && isNonce(value.attemptId)
    && typeof value.proofId === 'string'
    && PROOF_FILE_PATTERN.test(value.proofId)
    && (value.proofDigest === undefined || isSha256(value.proofDigest))
    && Number.isSafeInteger(value.at)
    && Number(value.at) > 0
    && ['created', 'approved', 'applied', 'rejected', 'failed', 'replay'].includes(String(value.outcome))
    && typeof value.applied === 'boolean'
    && (value.outcome === 'applied') === value.applied
    && Array.isArray(value.reasons)
    && value.reasons.every((reason) => typeof reason === 'string')
    && uniqueStrings(value.changedFiles)
    && isRecord(value.request)
}

function rejectedDecision(proofId: string, attemptId: string, evaluatedAt: number, reasons: string[]): PromotionDecision {
  return {
    approved: false,
    applied: false,
    attemptId,
    proofId,
    evaluatedAt,
    changedFiles: [],
    reasons,
    benchmarkReasons: [],
  }
}

function auditFromDecision(
  decision: PromotionDecision,
  outcome: PromotionAuditRecord['outcome'],
  applied: boolean,
  request: Record<string, unknown>,
  at: number,
  extraReason?: string,
): PromotionAuditRecord {
  return {
    auditId: randomUUID(),
    attemptId: decision.attemptId,
    proofId: decision.proofId,
    ...(decision.proofDigest ? { proofDigest: decision.proofDigest } : {}),
    at,
    outcome,
    applied,
    reasons: extraReason ? [...decision.reasons, extraReason] : decision.reasons,
    changedFiles: decision.changedFiles,
    request,
  }
}

function appendAudit(path: string, record: PromotionAuditRecord): void {
  ensureSecureDirectory(dirname(path))
  appendSecureFile(path, `${JSON.stringify(record)}\n`)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
