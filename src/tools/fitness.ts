import type { Tool } from './types.ts'

type RecordValue = Record<string, unknown>

function rowsFromInput(input: Record<string, unknown>, key: string): RecordValue[] {
  const raw = input[key]
  if (Array.isArray(raw)) return raw.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object')
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((item): item is RecordValue => Boolean(item) && typeof item === 'object') : []
    } catch {
      throw new Error(`${key} must be a JSON array when provided as text`)
    }
  }
  return []
}

function numeric(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : fallback
}

function text(input: unknown, fallback: string): string {
  return typeof input === 'string' && input.trim() ? input.trim() : fallback
}

function buildPlan(input: Record<string, unknown>): Record<string, unknown> {
  const daysPerWeek = Math.max(1, Math.min(7, Math.round(numeric(input.daysPerWeek, 3))))
  const minutes = Math.max(10, Math.min(180, Math.round(numeric(input.minutesPerSession, 35))))
  const goal = text(input.goal, 'general fitness')
  const experience = text(input.experience, 'beginner')
  const equipment = Array.isArray(input.equipment) ? input.equipment.filter((item): item is string => typeof item === 'string').slice(0, 12) : []
  const templates = [
    { focus: 'full-body strength', durationMin: minutes, note: 'Use controlled technique and leave room for recovery.' },
    { focus: 'easy cardio or active recovery', durationMin: minutes, note: 'Keep intensity conversational unless a qualified coach has set another target.' },
    { focus: 'mobility and movement quality', durationMin: Math.min(minutes, 30), note: 'Move within a comfortable range; do not force painful positions.' },
    { focus: 'full-body strength', durationMin: minutes, note: 'Repeat only if recovery and technique remain good.' },
    { focus: 'optional enjoyable activity', durationMin: Math.min(minutes, 60), note: 'Optional: choose a sustainable activity rather than adding intensity by default.' },
    { focus: 'rest', durationMin: 0, note: 'Rest or gentle everyday movement.' },
    { focus: 'rest', durationMin: 0, note: 'Rest and reflect on recovery.' },
  ]
  const sessions = templates.slice(0, daysPerWeek)
  return {
    action: 'plan',
    goal,
    experience,
    equipment,
    daysPerWeek,
    minutesPerSession: minutes,
    sessions,
    progression: ['Start below the maximum you believe you can do.', 'Increase one variable at a time only after several comfortable sessions.', 'If recovery worsens or pain appears, reduce or stop the provoking activity and seek qualified advice when appropriate.'],
    limitations: ['This is a generic organizational template, not individualized medical or clinical advice.', 'It does not diagnose conditions, prescribe treatment, or guarantee results.', 'Adjustments require real feedback about recovery, technique, and symptoms.'],
  }
}

function summarizeProgress(rows: RecordValue[]): Record<string, unknown> {
  let completed = 0
  let totalMinutes = 0
  let invalidRows = 0
  for (const row of rows) {
    const duration = numeric(row.durationMin, NaN)
    if (!Number.isFinite(duration) || duration < 0) {
      invalidRows += 1
      continue
    }
    if (row.completed === true || row.completed === 'true' || row.status === 'completed') completed += 1
    if (row.completed === true || row.completed === 'true' || row.status === 'completed') totalMinutes += duration
  }
  return {
    action: 'progress',
    sessionsRead: rows.length,
    completedSessions: completed,
    adherenceRate: rows.length ? Number((completed / rows.length).toFixed(3)) : 0,
    completedMinutes: Number(totalMinutes.toFixed(1)),
    invalidRows,
    limitations: ['Adherence is calculated from supplied rows only.', 'This summary cannot assess fitness, health, readiness, recovery quality, or injury risk.', 'Do not infer medical conclusions from wearable or activity data alone.'],
  }
}

function validateRows(rows: RecordValue[]): Record<string, unknown> {
  const warnings: string[] = []
  rows.forEach((row, index) => {
    if (typeof row.durationMin !== 'number' || !Number.isFinite(row.durationMin) || row.durationMin < 0) warnings.push(`row ${index + 1} requires a non-negative finite durationMin`)
    if (row.completed !== undefined && typeof row.completed !== 'boolean' && row.completed !== 'true' && row.completed !== 'false') warnings.push(`row ${index + 1} completed must be boolean when provided`)
  })
  return { action: 'validate', rowsRead: rows.length, valid: warnings.length === 0, warnings, note: 'Validation checks supplied activity shape only; it does not assess health or training safety.' }
}

export const fitnessTool: Tool = {
  name: 'fitness',
  description: 'Create a conservative generic fitness-plan template, summarize user-supplied activity progress, or validate tracking rows. It is not medical advice and never diagnoses, prescribes treatment, or guarantees results.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['plan', 'progress', 'validate'] },
      goal: { type: 'string', description: 'General goal such as consistency, strength, mobility, or cardio.' },
      experience: { type: 'string', description: 'Self-described experience level.' },
      equipment: { type: 'array', description: 'Available equipment names.' },
      daysPerWeek: { type: 'number', description: 'Desired sessions per week, bounded from 1 to 7.' },
      minutesPerSession: { type: 'number', description: 'Desired session duration, bounded from 10 to 180 minutes.' },
      sessions: { type: 'array', description: 'Activity rows with durationMin and completed/status; may also be a JSON string.' },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = input.action
    if (action !== 'plan' && action !== 'progress' && action !== 'validate') throw new Error('fitness action must be plan, progress, or validate')
    if (action === 'plan') return JSON.stringify(buildPlan(input), null, 2)
    const rows = rowsFromInput(input, 'sessions')
    return JSON.stringify(action === 'progress' ? summarizeProgress(rows) : validateRows(rows), null, 2)
  },
}
