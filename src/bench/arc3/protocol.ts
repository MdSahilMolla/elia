export interface Observation {
  game_id: string
  state: string
  levels_completed: number
  win_levels: number
  available_actions: number[]
  frame: number[][][]
}

/** Lossless runs of equal rows; hexadecimal characters are pixel colors, not objects. */
export function describeObservation(observation: Observation): string {
  const frames = observation.frame.map((frame, index) => {
    const rows = frame.map(row => row.map(pixel => {
      if (!Number.isInteger(pixel) || pixel < 0 || pixel > 15) throw new Error('Invalid ARC pixel')
      return pixel.toString(16).toUpperCase()
    }).join(''))
    const lines: string[] = []
    for (let y = 0; y < rows.length;) {
      let end = y
      while (end + 1 < rows.length && rows[end + 1] === rows[y]) end++
      lines.push(`y=${y}${end === y ? '' : `..${end}`}: ${rows[y]}`)
      y = end + 1
    }
    return `Frame ${index} (${frame[0]?.length ?? 0}x${frame.length}):\n${lines.join('\n')}`
  })
  return `State: ${observation.state}; levels completed: ${observation.levels_completed}/${observation.win_levels}\nAvailable actions: RESET, ${observation.available_actions.map(id => `ACTION${id}`).join(', ')}\n${frames.join('\n\n')}`
}

export function parseAction(input: Record<string, unknown>, available: number[]): { action: string; data: Record<string, number> } {
  const action = input.action
  if (typeof action !== 'string' || !/^(RESET|ACTION[1-7])$/.test(action)) throw new Error('Invalid action name')
  if (action !== 'RESET' && !available.includes(Number(action.slice(6)))) throw new Error('Action not currently available')
  if (action !== 'ACTION6') return { action, data: {} }
  const { x, y } = input
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 63 || y > 63) {
    throw new Error('ACTION6 requires integer x and y in [0,63]')
  }
  return { action, data: { x, y } }
}
