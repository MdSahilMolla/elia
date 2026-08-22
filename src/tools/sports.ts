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

function numberValue(row: RecordValue, key: string): number | undefined {
  const value = row[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textValue(row: RecordValue, key: string): string | undefined {
  const value = row[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function teamSummary(rows: RecordValue[]): Record<string, unknown> {
  const teams = new Map<string, { team: string; played: number; wins: number; draws: number; losses: number; goalsFor: number; goalsAgainst: number; points: number }>()
  const invalid: string[] = []
  for (const [index, row] of rows.entries()) {
    const team = textValue(row, 'team')
    const goalsFor = numberValue(row, 'goalsFor')
    const goalsAgainst = numberValue(row, 'goalsAgainst')
    if (!team || goalsFor === undefined || goalsAgainst === undefined || goalsFor < 0 || goalsAgainst < 0) {
      invalid.push(`row ${index + 1} requires team, non-negative goalsFor, and non-negative goalsAgainst`)
      continue
    }
    const current = teams.get(team) ?? { team, played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 }
    current.played += 1
    current.goalsFor += goalsFor
    current.goalsAgainst += goalsAgainst
    if (goalsFor > goalsAgainst) {
      current.wins += 1
      current.points += 3
    } else if (goalsFor === goalsAgainst) {
      current.draws += 1
      current.points += 1
    } else {
      current.losses += 1
    }
    teams.set(team, current)
  }
  const table = [...teams.values()]
    .map((row) => ({ ...row, goalDifference: row.goalsFor - row.goalsAgainst, pointsPerGame: row.played ? Number((row.points / row.played).toFixed(3)) : 0 }))
    .sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor || a.team.localeCompare(b.team))
  return { action: 'team_summary', matchesRead: rows.length, teams: table, invalidRows: invalid, limitations: ['Each row is treated as one team-match observation; provide one row per team per match for a complete table.', 'Points and rankings are descriptive calculations, not predictions or causal conclusions.'] }
}

function playerCompare(rows: RecordValue[], metric: string): Record<string, unknown> {
  const valid = rows.filter((row) => textValue(row, 'name') && numberValue(row, metric) !== undefined)
  const sorted = [...valid].sort((a, b) => (numberValue(b, metric) ?? 0) - (numberValue(a, metric) ?? 0) || (textValue(a, 'name') ?? '').localeCompare(textValue(b, 'name') ?? ''))
  const comparison = sorted.map((row, index) => ({ rank: index + 1, name: textValue(row, 'name'), metric, value: numberValue(row, metric) }))
  return { action: 'player_compare', metric, playersRead: rows.length, comparison, excludedRows: rows.length - valid.length, limitations: ['A single metric is not a complete player evaluation.', 'Adjust for role, minutes, competition strength, tactics, and data quality before making decisions.', 'This tool does not predict injury, career outcomes, or future performance.'] }
}

function validateRows(rows: RecordValue[]): Record<string, unknown> {
  const warnings: string[] = []
  rows.forEach((row, index) => {
    if (!textValue(row, 'team') && !textValue(row, 'name')) warnings.push(`row ${index + 1} has no team or name identifier`)
    for (const [key, value] of Object.entries(row)) if (typeof value === 'number' && !Number.isFinite(value)) warnings.push(`row ${index + 1} field ${key} is not finite`)
  })
  return { action: 'validate', rowsRead: rows.length, valid: warnings.length === 0, warnings, note: 'Validation checks shape and finite numeric values only; it does not verify the truth of supplied sports data.' }
}

export const sportsTool: Tool = {
  name: 'sports',
  description: 'Run deterministic sports analysis on user-supplied structured data: summarize team results, compare players by a supplied metric, or validate sports rows. It never fetches or invents scores, rankings, injuries, contracts, or predictions.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['team_summary', 'player_compare', 'validate'] },
      matches: { type: 'array', description: 'Team-match rows with team, goalsFor, and goalsAgainst; may also be a JSON string.' },
      players: { type: 'array', description: 'Player rows with name and the selected numeric metric; may also be a JSON string.' },
      metric: { type: 'string', description: 'Numeric player field to rank for player_compare, default score.' },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = input.action
    if (action !== 'team_summary' && action !== 'player_compare' && action !== 'validate') throw new Error('sports action must be team_summary, player_compare, or validate')
    if (action === 'team_summary') return JSON.stringify(teamSummary(rowsFromInput(input, 'matches')), null, 2)
    if (action === 'player_compare') return JSON.stringify(playerCompare(rowsFromInput(input, 'players'), typeof input.metric === 'string' && input.metric.trim() ? input.metric.trim() : 'score'), null, 2)
    return JSON.stringify(validateRows([...rowsFromInput(input, 'matches'), ...rowsFromInput(input, 'players')]), null, 2)
  },
}
