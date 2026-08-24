export interface BridgeRequestEnvelope {
  id: string
  method: string
  params?: Record<string, unknown>
}

export function isBridgeRequest(value: unknown): value is BridgeRequestEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const request = value as Partial<BridgeRequestEnvelope>
  return typeof request.id === 'string' && request.id.length > 0 && typeof request.method === 'string'
}

export function encodeBridgeMessage(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`
}
