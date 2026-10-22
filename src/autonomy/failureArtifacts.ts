import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ensureSecureDirectory, writeSecureFile } from '../securePersistence.ts'
import { redactText } from '../ui/redact.ts'

export interface FailureArtifactInput {
  runId: string
  goal: string
  gate: 'build' | 'review'
  attempts: number
  trend: string
  fingerprints: string[]
  diagnosis: string
  workspaceRoot: string
  now?: number
}

export interface FailureArtifact {
  id: string
  runId: string
  goal: string
  gate: 'build' | 'review'
  attempts: number
  trend: string
  fingerprints: string[]
  diagnosis: string
  createdAt: number
}

export function writeFailureArtifact(input: FailureArtifactInput): FailureArtifact {
  const fingerprints = input.fingerprints.slice(0, 32).map((item) => redactText(item, 500))
  const diagnosis = redactText(input.diagnosis, 4_000)
  const id = createHash('sha256').update(`${input.gate}\n${fingerprints.join('\n')}`).digest('hex').slice(0, 24)
  const artifact: FailureArtifact = {
    id,
    runId: redactText(input.runId, 160),
    goal: redactText(input.goal, 1_000),
    gate: input.gate,
    attempts: Math.max(1, Math.floor(input.attempts)),
    trend: redactText(input.trend, 80),
    fingerprints,
    diagnosis,
    createdAt: input.now ?? Date.now(),
  }
  const directory = join(input.workspaceRoot, '.elia', 'failures')
  ensureSecureDirectory(directory)
  writeSecureFile(join(directory, `${id}.json`), JSON.stringify(artifact, null, 2))
  return artifact
}
